import { AuthError, fetchJson, ValidationError } from "smart-mcp-core";
import { GoogleOAuthClient } from "./oauth.js";

const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export type GmailSendResponse = {
  id: string;
  threadId: string;
  labelIds: string[];
};

export class EmailClient {
  private readonly oauthClients = new Map<string, GoogleOAuthClient>();
  private readonly home: string | undefined;

  /**
   * Constructor is side-effect-free. HOME is resolved lazily on first use so
   * the server can boot in environments where HOME is provided later (or
   * never — for testing). Matches `audit.ts` and `identities.ts` resolution.
   */
  constructor(home?: string) {
    this.home = home;
  }

  private resolveHome(): string {
    if (this.home !== undefined) return this.home;
    const env = process.env.HOME;
    if (!env) {
      throw new ValidationError(
        "HOME environment variable is not set; cannot locate ~/.santo-agent/oauth",
      );
    }
    return env;
  }

  /**
   * Lazy-instantiate (and cache) one GoogleOAuthClient per account so the
   * in-memory access-token cache survives across calls within a single MCP
   * process.
   */
  oauthFor(account: string): GoogleOAuthClient {
    let existing = this.oauthClients.get(account);
    if (existing === undefined) {
      existing = new GoogleOAuthClient(account, this.resolveHome());
      this.oauthClients.set(account, existing);
    }
    return existing;
  }

  async sendMessage(account: string, raw: string): Promise<GmailSendResponse> {
    const accessToken = await this.oauthFor(account).getAccessToken();

    try {
      return await fetchJson<GmailSendResponse>(GMAIL_SEND_URL, {
        method: "POST",
        body: { raw },
        token: accessToken,
      });
    } catch (err) {
      throw mapSendError(err, account);
    }
  }
}

/**
 * Friendlier error messages for Gmail send failures. fetchJson maps 401/403
 * to AuthError with a generic "<METHOD> <URL> → <status>" message; we promote
 * 403 in particular to a specific scope-insufficient hint with the exact
 * `bin/auth.py` re-auth command, since that's the most common failure when a
 * caller has only `gmail.readonly` and tries to send.
 */
function mapSendError(err: unknown, account: string): unknown {
  if (!(err instanceof AuthError)) return err;
  const msg = err.message;
  if (msg.includes("→ 403")) {
    return new AuthError(
      `scope insufficient for account ${account} — re-run python3 ~/.santo-agent/bin/auth.py --account ${account} after expanding scope to gmail.modify`,
      { cause: err },
    );
  }
  if (msg.includes("→ 401")) {
    return new AuthError(
      `access token rejected for account ${account}; re-run python3 ~/.santo-agent/bin/auth.py --account ${account}`,
      { cause: err },
    );
  }
  return err;
}
