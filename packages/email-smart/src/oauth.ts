import * as fs from "node:fs";
import * as path from "node:path";
import { AuthError, UpstreamError } from "smart-mcp-core";

const CACHE_THRESHOLD_MS = 60_000;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

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

export class GoogleOAuthClient {
  private cached: AuthorizedUserFile | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly account: string,
    private readonly home: string = process.env.HOME!,
  ) {}

  getTokenPath(): string {
    return path.join(this.home, ".santo-agent", "oauth", `${this.account}.json`);
  }

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

  async hasGmailModifyScope(): Promise<boolean> {
    const file = this.loadFile();
    return file.scopes.includes(GMAIL_MODIFY_SCOPE);
  }

  private loadFile(): AuthorizedUserFile {
    const filePath = this.getTokenPath();
    if (!fs.existsSync(filePath)) {
      throw new AuthError(
        `token at ${filePath} not found; run python3 ~/.santo-agent/bin/auth.py --account ${this.account}`,
      );
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AuthError(
        `token file at ${filePath} is not valid JSON; re-run python3 ~/.santo-agent/bin/auth.py --account ${this.account}`,
      );
    }
    return this.validateFile(parsed, filePath);
  }

  private validateFile(parsed: unknown, filePath: string): AuthorizedUserFile {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AuthError(
        `token file at ${filePath} is not a JSON object; re-run python3 ~/.santo-agent/bin/auth.py --account ${this.account}`,
      );
    }
    const obj = parsed as Record<string, unknown>;
    for (const field of STRING_FIELDS) {
      if (typeof obj[field] !== "string") {
        throw new AuthError(
          `token file at ${filePath} missing or invalid field "${field}"; re-run python3 ~/.santo-agent/bin/auth.py --account ${this.account}`,
        );
      }
    }
    if (
      !Array.isArray(obj.scopes) ||
      !obj.scopes.every((s) => typeof s === "string")
    ) {
      throw new AuthError(
        `token file at ${filePath} missing or invalid field "scopes"; re-run python3 ~/.santo-agent/bin/auth.py --account ${this.account}`,
      );
    }
    const expiry = obj.expiry as string;
    if (!Number.isFinite(Date.parse(expiry))) {
      throw new AuthError(
        `token file at ${filePath} has unparseable expiry "${expiry}"; re-run python3 ~/.santo-agent/bin/auth.py --account ${this.account}`,
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
