import { AuthError, fetchJson, ValidationError } from "smart-mcp-core";
import { GoogleOAuthClient } from "./oauth.js";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_SEND_URL = `${GMAIL_API_BASE}/users/me/messages/send`;

export type GmailSendResponse = {
  id: string;
  threadId: string;
  labelIds: string[];
};

export type GmailMessageRef = { id: string; threadId: string };

export type GmailListMessagesResponse = {
  messages: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate: number;
};

export type GmailMessageFormat = "metadata" | "full" | "raw" | "minimal";

export type ListMessagesOpts = {
  q?: string;
  maxResults?: number;
  pageToken?: string;
  labelIds?: string;
};

export type GmailThreadResponse = {
  id: string;
  snippet?: string;
  historyId?: string;
  messages: unknown[];
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

  /**
   * GET /users/me/messages — list message refs (id + threadId only) with
   * optional Gmail query, label filter, and pagination cursor. Always returns
   * `messages` as an array; Gmail omits the field on zero-match responses.
   */
  async listMessages(
    account: string,
    opts: ListMessagesOpts = {},
  ): Promise<GmailListMessagesResponse> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> = {
      q: opts.q,
      maxResults: opts.maxResults,
      pageToken: opts.pageToken,
      labelIds: opts.labelIds,
    };
    const raw = await fetchJson<{
      messages?: GmailMessageRef[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(`${GMAIL_API_BASE}/users/me/messages`, {
      token: accessToken,
      searchParams,
    });
    return {
      messages: raw.messages ?? [],
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
      resultSizeEstimate: raw.resultSizeEstimate ?? 0,
    };
  }

  /**
   * GET /users/me/messages/{id} — single message resource. `format` controls
   * how much of the payload tree Gmail returns. Default `metadata` gives
   * headers + snippet but no body; use `full` for body extraction.
   */
  async getMessage(
    account: string,
    id: string,
    format: GmailMessageFormat = "metadata",
  ): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    return fetchJson<unknown>(
      `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(id)}`,
      {
        token: accessToken,
        searchParams: { format },
      },
    );
  }

  /**
   * GET /users/me/threads/{id} — full thread including its message list.
   */
  async getThread(
    account: string,
    id: string,
    format: GmailMessageFormat = "metadata",
  ): Promise<GmailThreadResponse> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    const raw = await fetchJson<{
      id?: string;
      snippet?: string;
      historyId?: string;
      messages?: unknown[];
    }>(`${GMAIL_API_BASE}/users/me/threads/${encodeURIComponent(id)}`, {
      token: accessToken,
      searchParams: { format },
    });
    return {
      id: raw.id ?? id,
      ...(raw.snippet !== undefined ? { snippet: raw.snippet } : {}),
      ...(raw.historyId !== undefined ? { historyId: raw.historyId } : {}),
      messages: raw.messages ?? [],
    };
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
