#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

/**
 * OAuth 2.0 token-mint CLI for calendar-smart. Reads
 * `~/.santo-agent/oauth/client.json` for the Google OAuth client id/secret,
 * prints an authorization URL with the calendar scope, prompts for the code
 * pasted back from the consent screen, exchanges it at the Google token
 * endpoint, and writes the result to
 * `~/.santo-agent/oauth/<account>.calendar.json` at mode 0600.
 *
 * The exchange logic is factored out into `runAuth(...)` so unit tests can
 * inject a deterministic `codeReader` and `now` clock without driving stdin
 * or wall-time.
 */

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const AUTHORIZATION_URL_BASE =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
export const OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

const CLIENT_JSON_RELATIVE = path.join(".santo-agent", "oauth", "client.json");
const TOKEN_FILE_SUFFIX = ".calendar.json";

export type RunAuthOpts = {
  account: string;
  home: string;
  /** Async reader for the authorization code pasted by the user. */
  codeReader: () => Promise<string>;
  /** Clock seam for expiry computation. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Logger used for the human-facing prompt. Defaults to a silent no-op. */
  log?: (line: string) => void;
};

export type RunAuthResult = {
  tokenPath: string;
  expiry: string;
};

/**
 * Shape of the (subset of) `~/.santo-agent/oauth/client.json` we consume.
 * Google's downloaded "Desktop app" file uses the wrapped form
 * `{ installed: { client_id, client_secret, ... } }`; we also accept a flat
 * `{ client_id, client_secret }` for users who have already de-wrapped it.
 */
type GoogleClientFile =
  | { installed: { client_id?: unknown; client_secret?: unknown } }
  | { client_id?: unknown; client_secret?: unknown };

type TokenExchangeResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
};

/**
 * Read the OAuth client id + secret from `~/.santo-agent/oauth/client.json`.
 * Throws a clear error if the file is missing or malformed; the user message
 * names the expected path and tells them to download a Desktop-app OAuth
 * client from Google Cloud Console.
 */
function readClientJson(home: string): { client_id: string; client_secret: string } {
  const clientJsonPath = path.join(home, CLIENT_JSON_RELATIVE);
  if (!fs.existsSync(clientJsonPath)) {
    throw new Error(
      `Drop your OAuth client at ${clientJsonPath} (download from Google Cloud Console under OAuth 2.0 Client IDs, Desktop app).`,
    );
  }
  let parsed: GoogleClientFile;
  try {
    parsed = JSON.parse(fs.readFileSync(clientJsonPath, "utf-8")) as GoogleClientFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`client.json at ${clientJsonPath} is not valid JSON: ${msg}`);
  }
  const inner =
    "installed" in parsed && typeof parsed.installed === "object" && parsed.installed !== null
      ? (parsed.installed as { client_id?: unknown; client_secret?: unknown })
      : (parsed as { client_id?: unknown; client_secret?: unknown });
  if (typeof inner.client_id !== "string" || inner.client_id.length === 0) {
    throw new Error(`client.json at ${clientJsonPath} missing string field "client_id".`);
  }
  if (typeof inner.client_secret !== "string" || inner.client_secret.length === 0) {
    throw new Error(`client.json at ${clientJsonPath} missing string field "client_secret".`);
  }
  return { client_id: inner.client_id, client_secret: inner.client_secret };
}

/**
 * Build the consent-screen URL the user opens in their browser.
 */
export function buildAuthorizationUrl(clientId: string): string {
  const url = new URL(AUTHORIZATION_URL_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", OOB_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", CALENDAR_SCOPE);
  return url.toString();
}

/**
 * Token-mint flow exposed for testing. The CLI's `main()` wraps this with a
 * stdin-driven `codeReader` and a console logger.
 */
export async function runAuth(opts: RunAuthOpts): Promise<RunAuthResult> {
  if (!opts.account || opts.account.length === 0) {
    throw new Error(
      "calendar-smart-auth: missing account argument. Usage: calendar-smart-auth <account>",
    );
  }
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());

  const { client_id, client_secret } = readClientJson(opts.home);

  const authUrl = buildAuthorizationUrl(client_id);
  log(`Open this URL in your browser, grant access, then paste the code:\n${authUrl}`);

  const code = (await opts.codeReader()).trim();
  if (!code) {
    throw new Error("calendar-smart-auth: empty authorization code; aborting.");
  }

  const body = new URLSearchParams({
    code,
    client_id,
    client_secret,
    redirect_uri: OOB_REDIRECT_URI,
    grant_type: "authorization_code",
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
    throw new Error(`Token exchange network failure: ${msg}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as TokenExchangeResponse;
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error(
      "Token exchange response invalid: missing or malformed access_token.",
    );
  }
  if (typeof json.refresh_token !== "string" || json.refresh_token.length === 0) {
    throw new Error(
      "Token exchange response invalid: missing refresh_token. Re-run consent with prompt=consent (the URL printed above already does this — try revoking the app at https://myaccount.google.com/permissions and try again).",
    );
  }
  if (
    typeof json.expires_in !== "number" ||
    !Number.isFinite(json.expires_in) ||
    json.expires_in <= 0
  ) {
    throw new Error(
      "Token exchange response invalid: missing or malformed expires_in.",
    );
  }

  const expiry = new Date(now().getTime() + json.expires_in * 1000).toISOString();
  const scopes =
    typeof json.scope === "string" && json.scope.length > 0
      ? json.scope.split(/\s+/).filter((s) => s.length > 0)
      : [CALENDAR_SCOPE];

  const tokenPath = path.join(
    opts.home,
    ".santo-agent",
    "oauth",
    `${opts.account}${TOKEN_FILE_SUFFIX}`,
  );

  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({
      token: json.access_token,
      refresh_token: json.refresh_token,
      token_uri: TOKEN_URL,
      client_id,
      client_secret,
      scopes,
      expiry,
    }),
  );
  fs.chmodSync(tokenPath, 0o600);

  return { tokenPath, expiry };
}

/**
 * stdin-driven prompt used by the CLI entry point. Resolves with the line
 * the user pastes (trim handled by `runAuth`).
 */
function stdinPrompt(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Paste authorization code: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const account = process.argv[2];
  if (!account) {
    process.stderr.write(
      "Usage: calendar-smart-auth <account>\n" +
        "  account is the basename used under ~/.santo-agent/oauth/.\n",
    );
    process.exit(2);
  }
  const home = process.env.HOME;
  if (!home) {
    process.stderr.write("HOME environment variable is not set.\n");
    process.exit(2);
  }
  try {
    const result = await runAuth({
      account,
      home,
      codeReader: stdinPrompt,
      log: (line) => process.stdout.write(line + "\n"),
    });
    process.stdout.write(
      `OK. Wrote ${result.tokenPath} (expires ${result.expiry}).\n` +
        `Restart Claude Code to pick up calendar-smart.\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`calendar-smart-auth: ${msg}\n`);
    process.exit(1);
  }
}

// Only run main() when executed directly (not when imported by tests).
// `import.meta.url` matches `file://${process.argv[1]}` exactly when the file
// is the entry point under Node's ESM loader.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
