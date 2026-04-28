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
    if (Number.isFinite(expiryMs) && expiryMs - Date.now() > CACHE_THRESHOLD_MS) {
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
    return JSON.parse(raw) as AuthorizedUserFile;
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
