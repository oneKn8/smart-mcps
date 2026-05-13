#!/usr/bin/env node
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { AddressInfo } from "node:net";

/**
 * OAuth 2.0 token-mint CLI for calendar-smart. Reads
 * `~/.santo-agent/oauth/client.json` for the Google OAuth client id/secret,
 * spins up a localhost loopback HTTP server, prints an authorization URL with
 * the calendar scope and a `redirect_uri=http://127.0.0.1:<port>` parameter,
 * waits for Google to redirect back with the code, exchanges it at the Google
 * token endpoint, and writes the result to
 * `~/.santo-agent/oauth/<account>.calendar.json` at mode 0600.
 *
 * Loopback (not OOB) — Google deprecated `urn:ietf:wg:oauth:2.0:oob` in
 * October 2022 for installed apps. The user's existing Desktop OAuth client
 * already has `http://localhost` (and `http://127.0.0.1`) registered as
 * redirect URIs, matching this flow.
 *
 * The exchange logic is factored out into `runAuth(...)` so unit tests can
 * inject a deterministic `codeReader` and `now` clock without driving real
 * HTTP or wall-time.
 */

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const AUTHORIZATION_URL_BASE =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

const CLIENT_JSON_RELATIVE = path.join(".santo-agent", "oauth", "client.json");
const TOKEN_FILE_SUFFIX = ".calendar.json";

export type RunAuthOpts = {
  account: string;
  home: string;
  /** The redirect URI registered on the Google OAuth client; passed back to Google in the token exchange. */
  redirectUri: string;
  /** Async reader for the authorization code. In production, the loopback server resolves this. */
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
 * Build the consent-screen URL the user opens in their browser. `redirectUri`
 * must match a value registered on the Google OAuth client.
 */
export function buildAuthorizationUrl(clientId: string, redirectUri: string): string {
  const url = new URL(AUTHORIZATION_URL_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", CALENDAR_SCOPE);
  return url.toString();
}

export async function runAuth(opts: RunAuthOpts): Promise<RunAuthResult> {
  if (!opts.account || opts.account.length === 0) {
    throw new Error(
      "calendar-smart-auth: missing account argument. Usage: calendar-smart-auth <account>",
    );
  }
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());

  const { client_id, client_secret } = readClientJson(opts.home);

  const authUrl = buildAuthorizationUrl(client_id, opts.redirectUri);
  log(`Open this URL in your browser, sign in, and grant access:\n\n${authUrl}\n`);
  log("Waiting for the redirect to complete...");

  const code = (await opts.codeReader()).trim();
  if (!code) {
    throw new Error("calendar-smart-auth: empty authorization code; aborting.");
  }

  const body = new URLSearchParams({
    code,
    client_id,
    client_secret,
    redirect_uri: opts.redirectUri,
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
      "Token exchange response invalid: missing refresh_token. Revoke the app at https://myaccount.google.com/permissions and re-run consent.",
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
 * Spin up a localhost HTTP server to catch Google's OAuth redirect. Returns
 * `{ redirectUri, codeReader, close }`. The codeReader resolves with the
 * `code` query parameter as soon as Google redirects to the loopback URL.
 *
 * Binds to 127.0.0.1 explicitly so the registered redirect (which Google
 * accepts on either `http://localhost` or `http://127.0.0.1`) matches.
 */
export function startLoopbackServer(): Promise<{
  redirectUri: string;
  codeReader: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end(`OAuth error: ${error}. You can close this tab.`);
          rejectCode(new Error(`OAuth error from Google: ${error}`));
          return;
        }
        if (code) {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(
            "calendar-smart-auth: authorization received. You can close this tab and return to the terminal.",
          );
          resolveCode(code);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`server error: ${msg}`);
        rejectCode(err instanceof Error ? err : new Error(msg));
      }
    });

    server.once("error", (err) => reject(err));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${addr.port}`;
      resolve({
        redirectUri,
        codeReader: () => codePromise,
        close: () => server.close(),
      });
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

  let loopback: Awaited<ReturnType<typeof startLoopbackServer>> | undefined;
  try {
    loopback = await startLoopbackServer();
    const result = await runAuth({
      account,
      home,
      redirectUri: loopback.redirectUri,
      codeReader: loopback.codeReader,
      log: (line) => process.stdout.write(line + "\n"),
    });
    process.stdout.write(
      `\nOK. Wrote ${result.tokenPath} (expires ${result.expiry}).\n` +
        `Restart Claude Code to pick up calendar-smart.\n`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`calendar-smart-auth: ${msg}\n`);
    process.exit(1);
  } finally {
    loopback?.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
