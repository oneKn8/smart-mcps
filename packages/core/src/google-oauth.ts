import * as fs from "node:fs";
import * as path from "node:path";
import { AuthError, UpstreamError } from "./errors.js";

const CACHE_THRESHOLD_MS = 60_000;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_FILE_SUFFIX = ".json";

/**
 * Build the default re-auth hint matching the legacy email-smart wording so
 * existing AuthError messages stay byte-identical after the lift. Calendar
 * (and any future Google-OAuth MCP) overrides via `opts.reauthHint`.
 */
function defaultReauthHint(account: string): string {
  return `python3 ~/.santo-agent/bin/auth.py --account ${account}`;
}

/**
 * Shape of `~/.santo-agent/oauth/<account>.json` (or `<account>.calendar.json`,
 * etc., when `fileSuffix` is overridden). Mirrors Google's authorized_user
 * credential format. All fields are required; missing or wrong-typed values
 * surface as AuthError with the field name in the message.
 */
export type AuthorizedUserFile = {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry: string;
};

type TokenRefreshResponse = {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

const STRING_FIELDS: ReadonlyArray<
  Exclude<keyof AuthorizedUserFile, "scopes">
> = [
  "token",
  "refresh_token",
  "token_uri",
  "client_id",
  "client_secret",
  "expiry",
];

export type GoogleOAuthClientOpts = {
  /**
   * User home directory containing `.santo-agent/oauth/`. Defaults to
   * `process.env.HOME` resolved at construction time.
   */
  home?: string;
  /**
   * File-name suffix appended to the account name to form the token file
   * basename. Defaults to `".json"` (legacy email-smart layout). Pass
   * `".calendar.json"` for calendar-smart so the two MCPs do not stomp each
   * other's tokens.
   */
  fileSuffix?: string;
  /**
   * Trailing imperative inserted into AuthError messages to tell the user
   * how to mint a fresh token. Defaults to
   * `python3 ~/.santo-agent/bin/auth.py --account <account>` so existing
   * email-smart error messages are preserved verbatim. calendar-smart passes
   * `node packages/calendar-smart/dist/bin/calendar-smart-auth.js <account>`.
   */
  reauthHint?: string;
  /**
   * Reserved for future use: the OAuth scope this client expects on the
   * token file. Currently informational only; later phases may add an eager
   * scope check at construction time. Accepted now so callers (e.g.
   * calendar-smart) can wire it up without a future signature change.
   */
  requiredScope?: string;
};

/**
 * Google OAuth 2.0 client backed by the `~/.santo-agent/oauth/` token jar.
 * Reads the per-account JSON file lazily, caches the access token in memory
 * until it is within 60 s of expiry, then refreshes via the documented
 * `POST oauth2.googleapis.com/token` endpoint and rewrites the file at
 * mode 0600.
 *
 * Concurrent refreshes are deduped via an in-flight promise so two parallel
 * `getAccessToken()` calls trigger exactly one network round-trip.
 *
 * Originally lived in `packages/email-smart/src/oauth.ts`; lifted into core
 * during Phase 5 so calendar-smart can reuse the implementation against a
 * sibling token file (`<account>.calendar.json`).
 */
export class GoogleOAuthClient {
  private cached: AuthorizedUserFile | undefined;
  private inFlight: Promise<string> | undefined;

  private readonly account: string;
  private readonly home: string;
  private readonly fileSuffix: string;
  private readonly reauthHint: string;
  // requiredScope is stored but unused — see opts docstring.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly requiredScope: string | undefined;

  constructor(account: string, opts: GoogleOAuthClientOpts = {}) {
    this.account = account;
    // HOME is resolved at construction time. Pass `opts.home` explicitly to
    // avoid the env-var read; lazy resolution happens in callers' wrappers.
    this.home = opts.home ?? process.env.HOME!;
    this.fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    this.reauthHint = opts.reauthHint ?? defaultReauthHint(account);
    this.requiredScope = opts.requiredScope;
  }

  /**
   * Absolute path of the token file this client reads from / writes to.
   * Composes `<home>/.santo-agent/oauth/<account><fileSuffix>` — so for
   * `account="alice"` and the default suffix the path is
   * `<home>/.santo-agent/oauth/alice.json`.
   */
  getTokenPath(): string {
    return path.join(
      this.home,
      ".santo-agent",
      "oauth",
      `${this.account}${this.fileSuffix}`,
    );
  }

  /**
   * Return a fresh access token. Uses the in-memory cache when expiry is
   * more than 60 s out; otherwise refreshes against
   * `oauth2.googleapis.com/token` and persists the new token + expiry to
   * disk. Concurrent callers share the same in-flight refresh.
   */
  async getAccessToken(): Promise<string> {
    const file = this.loadFile();
    const expiryMs = Date.parse(file.expiry);
    if (expiryMs - Date.now() > CACHE_THRESHOLD_MS) {
      this.cached = file;
      return file.token;
    }

    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh(file).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /**
   * Returns true iff the token file's `scopes` array contains the requested
   * OAuth scope string. Replaces the legacy `hasGmailModifyScope()` helper
   * with a generic check usable by any Google-API MCP.
   */
  async hasScope(scope: string): Promise<boolean> {
    const file = this.loadFile();
    return file.scopes.includes(scope);
  }

  private loadFile(): AuthorizedUserFile {
    const filePath = this.getTokenPath();
    if (!fs.existsSync(filePath)) {
      throw new AuthError(
        `token at ${filePath} not found; run ${this.reauthHint}`,
      );
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AuthError(
        `token file at ${filePath} is not valid JSON; re-run ${this.reauthHint}`,
      );
    }
    return this.validateFile(parsed, filePath);
  }

  private validateFile(parsed: unknown, filePath: string): AuthorizedUserFile {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AuthError(
        `token file at ${filePath} is not a JSON object; re-run ${this.reauthHint}`,
      );
    }
    const obj = parsed as Record<string, unknown>;
    for (const field of STRING_FIELDS) {
      if (typeof obj[field] !== "string") {
        throw new AuthError(
          `token file at ${filePath} missing or invalid field "${field}"; re-run ${this.reauthHint}`,
        );
      }
    }
    if (
      !Array.isArray(obj.scopes) ||
      !obj.scopes.every((s) => typeof s === "string")
    ) {
      throw new AuthError(
        `token file at ${filePath} missing or invalid field "scopes"; re-run ${this.reauthHint}`,
      );
    }
    const expiry = obj.expiry as string;
    if (!Number.isFinite(Date.parse(expiry))) {
      throw new AuthError(
        `token file at ${filePath} has unparseable expiry "${expiry}"; re-run ${this.reauthHint}`,
      );
    }
    return {
      token: obj.token as string,
      refresh_token: obj.refresh_token as string,
      token_uri: obj.token_uri as string,
      client_id: obj.client_id as string,
      client_secret: obj.client_secret as string,
      scopes: obj.scopes as string[],
      expiry,
    };
  }

  private async refresh(file: AuthorizedUserFile): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: file.refresh_token,
      client_id: file.client_id,
      client_secret: file.client_secret,
    });

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UpstreamError(`OAuth refresh network failure: ${msg}`, { cause: err });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      if (
        response.status === 400 &&
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { error?: unknown }).error === "invalid_grant"
      ) {
        // Legacy literal — kept verbatim for backward compatibility with the
        // existing email-smart oauth tests. Independent of `reauthHint` on
        // purpose (the message historically used `bin/auth.py`, not the
        // fully-qualified python3 form).
        throw new AuthError(
          `refresh token revoked; re-run bin/auth.py --account ${this.account}`,
        );
      }
      throw new UpstreamError(`OAuth refresh failed: ${response.status} ${text}`);
    }

    const json = (await response.json()) as TokenRefreshResponse;
    if (typeof json.access_token !== "string" || json.access_token.length === 0) {
      throw new UpstreamError(
        "OAuth refresh response invalid: missing or malformed access_token",
      );
    }
    if (
      typeof json.expires_in !== "number" ||
      !Number.isFinite(json.expires_in) ||
      json.expires_in <= 0
    ) {
      throw new UpstreamError(
        "OAuth refresh response invalid: missing or malformed expires_in",
      );
    }
    const newExpiry = new Date(Date.now() + json.expires_in * 1000).toISOString();
    const updated: AuthorizedUserFile = {
      ...file,
      token: json.access_token,
      expiry: newExpiry,
    };
    this.writeFile(updated);
    this.cached = updated;
    return updated.token;
  }

  private writeFile(file: AuthorizedUserFile): void {
    const filePath = this.getTokenPath();
    fs.writeFileSync(filePath, JSON.stringify(file));
    fs.chmodSync(filePath, 0o600);
  }
}
