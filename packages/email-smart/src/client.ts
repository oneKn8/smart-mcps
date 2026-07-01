import {
  AuthError,
  NotFoundError,
  fetchJson,
  GoogleOAuthClient,
  ValidationError,
} from "smart-mcp-core";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_SEND_URL = `${GMAIL_API_BASE}/users/me/messages/send`;

// Gmail draft propagation: drafts.create / drafts.update return an id but the
// GET / POST/send / DELETE endpoints can 404 on that id for several seconds.
// Retry 404s with linear-backoff. 4 × 750ms covers a ~3s observed lag.
const DRAFT_OP_RETRIES = 4;
const DRAFT_OP_BACKOFF_MS = 750;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wrap a draft-keyed Gmail call with NotFoundError retry. Used by getDraft,
 * sendDraft, and deleteDraft — all of which can 404 immediately after the
 * draft is created or updated, even though the draft genuinely exists.
 */
async function retryOn404<T>(
  op: () => Promise<T>,
  account: string,
  id: string,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < DRAFT_OP_RETRIES; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw wrapDraftError(err, account, id);
      }
      lastErr = err;
      if (attempt < DRAFT_OP_RETRIES - 1) {
        await sleep(DRAFT_OP_BACKOFF_MS * (attempt + 1));
      }
    }
  }
  throw wrapDraftError(lastErr, account, id);
}

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

export type GmailLabel = {
  id: string;
  name: string;
  type: string;
};

export type GmailLabelDetail = GmailLabel & {
  messagesTotal?: number;
  messagesUnread?: number;
  threadsUnread?: number;
};

export type LabelVisibility = "labelShow" | "labelHide" | "labelShowIfUnread";

export type LabelMessageListVisibility = "show" | "hide";

export type CreateLabelOpts = {
  name: string;
  labelListVisibility?: LabelVisibility;
  messageListVisibility?: LabelMessageListVisibility;
};

export type UpdateLabelOpts = {
  name?: string;
  labelListVisibility?: LabelVisibility;
  messageListVisibility?: LabelMessageListVisibility;
};

export type BatchModifyOpts = {
  ids: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
};

export type GmailDraftRef = {
  id: string;
  messageId: string;
  threadId: string;
};

export type GmailDraftListResponse = {
  drafts: GmailDraftRef[];
  nextPageToken?: string;
  resultSizeEstimate: number;
};

export type ListDraftsOpts = {
  q?: string;
  maxResults?: number;
  pageToken?: string;
};

// ---- Settings surface: filters / vacation / imap / pop / language / sendAs ----
// These types are the camelCase Gmail wire shapes that client methods send.
// The snake_case slim shapes returned to MCP callers live in settings-mapper.ts.

export type GmailFilterCriteria = {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: "unspecified" | "smaller" | "larger";
};

export type GmailFilterAction = {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
};

export type CreateFilterOpts = {
  criteria: GmailFilterCriteria;
  action: GmailFilterAction;
};

export type GmailVacationSettings = {
  enableAutoReply?: boolean;
  responseSubject?: string;
  responseBodyPlainText?: string;
  responseBodyHtml?: string;
  restrictToContacts?: boolean;
  restrictToDomain?: boolean;
  startTime?: string;
  endTime?: string;
};

export type GmailImapSettings = {
  enabled?: boolean;
  autoExpunge?: boolean;
  expungeBehavior?: string;
  maxFolderSize?: number;
};

export type GmailPopSettings = {
  accessWindow?: string;
  disposition?: string;
};

export type UpdateSendAsOpts = {
  signature?: string;
  displayName?: string;
};

export type GmailAutoForwarding = {
  enabled?: boolean;
  emailAddress?: string;
  disposition?: string;
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
      existing = new GoogleOAuthClient(account, { home: this.resolveHome() });
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
      throw mapGmailAuthError(err, account);
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
    let raw: {
      messages?: GmailMessageRef[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    };
    try {
      raw = await fetchJson(`${GMAIL_API_BASE}/users/me/messages`, {
        token: accessToken,
        searchParams,
      });
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
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
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(id)}`,
        {
          token: accessToken,
          searchParams: { format },
        },
      );
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
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
    let raw: {
      id?: string;
      snippet?: string;
      historyId?: string;
      messages?: unknown[];
    };
    try {
      raw = await fetchJson(
        `${GMAIL_API_BASE}/users/me/threads/${encodeURIComponent(id)}`,
        {
          token: accessToken,
          searchParams: { format },
        },
      );
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
    return {
      id: raw.id ?? id,
      ...(raw.snippet !== undefined ? { snippet: raw.snippet } : {}),
      ...(raw.historyId !== undefined ? { historyId: raw.historyId } : {}),
      messages: raw.messages ?? [],
    };
  }

  /**
   * POST /users/me/messages/batchModify — bulk apply/remove label IDs across
   * up to 1000 message IDs. Gmail returns 204 No Content on success;
   * fetchJson surfaces that as undefined. 403 is mapped to a scope-insufficient
   * AuthError pointing at the re-auth command.
   */
  async batchModify(account: string, opts: BatchModifyOpts): Promise<void> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    const body: Record<string, unknown> = { ids: opts.ids };
    if (opts.addLabelIds !== undefined) body["addLabelIds"] = opts.addLabelIds;
    if (opts.removeLabelIds !== undefined)
      body["removeLabelIds"] = opts.removeLabelIds;

    try {
      await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/messages/batchModify`,
        {
          method: "POST",
          body,
          token: accessToken,
        },
      );
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
  }

  /**
   * Bulk move up to 1000 message IDs into Trash. There is no `batchTrash`
   * endpoint in the Gmail REST API — moving to Trash is expressed as adding
   * the `TRASH` system label (and removing `INBOX` so the thread stops
   * appearing in the inbox view). Implemented via `batchModify`.
   */
  async batchTrash(account: string, ids: string[]): Promise<void> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/messages/batchModify`,
        {
          method: "POST",
          body: {
            ids,
            addLabelIds: ["TRASH"],
            removeLabelIds: ["INBOX"],
          },
          token: accessToken,
        },
      );
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
  }

  /**
   * GET /users/me/labels — list of all label resources for the account. Used
   * by tools that need to resolve a human-readable label name to its Gmail
   * label ID. Gmail omits `labels` on accounts with no user labels; we
   * normalize to an empty array.
   */
  async listLabels(account: string): Promise<GmailLabel[]> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    let raw: {
      labels?: Array<{ id?: unknown; name?: unknown; type?: unknown }>;
    };
    try {
      raw = await fetchJson(`${GMAIL_API_BASE}/users/me/labels`, {
        token: accessToken,
      });
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
    const out: GmailLabel[] = [];
    for (const label of raw.labels ?? []) {
      if (
        typeof label?.id === "string" &&
        typeof label?.name === "string" &&
        typeof label?.type === "string"
      ) {
        out.push({ id: label.id, name: label.name, type: label.type });
      }
    }
    return out;
  }

  /**
   * GET /users/me/labels/{id} — single label resource. Gmail returns
   * `messagesTotal` / `messagesUnread` / `threadsUnread` only on this
   * endpoint, not on the list endpoint, so callers needing counts must
   * fetch labels individually.
   */
  async getLabel(account: string, id: string): Promise<GmailLabelDetail> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    let raw: {
      id?: unknown;
      name?: unknown;
      type?: unknown;
      messagesTotal?: unknown;
      messagesUnread?: unknown;
      threadsUnread?: unknown;
    };
    try {
      raw = await fetchJson(
        `${GMAIL_API_BASE}/users/me/labels/${encodeURIComponent(id)}`,
        { token: accessToken },
      );
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
    const out: GmailLabelDetail = {
      id: typeof raw.id === "string" ? raw.id : id,
      name: typeof raw.name === "string" ? raw.name : "",
      type: typeof raw.type === "string" ? raw.type : "user",
    };
    if (typeof raw.messagesTotal === "number")
      out.messagesTotal = raw.messagesTotal;
    if (typeof raw.messagesUnread === "number")
      out.messagesUnread = raw.messagesUnread;
    if (typeof raw.threadsUnread === "number")
      out.threadsUnread = raw.threadsUnread;
    return out;
  }

  /**
   * POST /users/me/labels — create a new user label. Gmail rejects names that
   * collide with existing user labels (409) and names that collide with system
   * labels like INBOX/IMPORTANT (400). Both surface as upstream errors here;
   * the caller picks a different name.
   */
  async createLabel(
    account: string,
    opts: CreateLabelOpts,
  ): Promise<GmailLabel> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    const body: Record<string, unknown> = { name: opts.name };
    if (opts.labelListVisibility !== undefined)
      body["labelListVisibility"] = opts.labelListVisibility;
    if (opts.messageListVisibility !== undefined)
      body["messageListVisibility"] = opts.messageListVisibility;
    let raw: { id?: unknown; name?: unknown; type?: unknown };
    try {
      raw = await fetchJson(`${GMAIL_API_BASE}/users/me/labels`, {
        method: "POST",
        body,
        token: accessToken,
      });
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
    return {
      id: typeof raw.id === "string" ? raw.id : "",
      name: typeof raw.name === "string" ? raw.name : opts.name,
      type: typeof raw.type === "string" ? raw.type : "user",
    };
  }

  /**
   * PATCH /users/me/labels/{id} — rename or change visibility of a user label.
   * Gmail rejects PATCH on system labels (400); callers must check the label
   * type before invoking this.
   */
  async updateLabel(
    account: string,
    id: string,
    patch: UpdateLabelOpts,
  ): Promise<GmailLabel> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body["name"] = patch.name;
    if (patch.labelListVisibility !== undefined)
      body["labelListVisibility"] = patch.labelListVisibility;
    if (patch.messageListVisibility !== undefined)
      body["messageListVisibility"] = patch.messageListVisibility;
    let raw: { id?: unknown; name?: unknown; type?: unknown };
    try {
      raw = await fetchJson(
        `${GMAIL_API_BASE}/users/me/labels/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body,
          token: accessToken,
        },
      );
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
    return {
      id: typeof raw.id === "string" ? raw.id : id,
      name: typeof raw.name === "string" ? raw.name : "",
      type: typeof raw.type === "string" ? raw.type : "user",
    };
  }

  /**
   * DELETE /users/me/labels/{id} — permanently delete a user label. The label
   * is removed from all messages in addition to the label resource itself.
   * Gmail rejects DELETE on system labels (400).
   */
  async deleteLabel(account: string, id: string): Promise<void> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/labels/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          token: accessToken,
        },
      );
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
  }

  /**
   * POST /users/me/drafts — create a new draft from a base64url-encoded MIME
   * message. Gmail returns `{ id, message: { id, threadId } }`; we flatten to
   * the slim `GmailDraftRef` shape so callers don't need to navigate the
   * outer wrapping.
   */
  async createDraft(account: string, raw: string): Promise<GmailDraftRef> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    let response: { id?: unknown; message?: { id?: unknown; threadId?: unknown } };
    try {
      response = await fetchJson(`${GMAIL_API_BASE}/users/me/drafts`, {
        method: "POST",
        body: { message: { raw } },
        token: accessToken,
      });
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
    return {
      id: typeof response.id === "string" ? response.id : "",
      messageId:
        typeof response.message?.id === "string" ? response.message.id : "",
      threadId:
        typeof response.message?.threadId === "string"
          ? response.message.threadId
          : "",
    };
  }

  /**
   * GET /users/me/drafts — list draft refs with optional Gmail query and
   * pagination. Gmail omits `drafts` on zero-match responses; we normalize to
   * an empty array. Each entry's `message` wrapping is flattened to the slim
   * `GmailDraftRef` shape.
   */
  async listDrafts(
    account: string,
    opts: ListDraftsOpts = {},
  ): Promise<GmailDraftListResponse> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> = {
      q: opts.q,
      maxResults: opts.maxResults,
      pageToken: opts.pageToken,
    };
    let raw: {
      drafts?: Array<{
        id?: unknown;
        message?: { id?: unknown; threadId?: unknown };
      }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    };
    try {
      raw = await fetchJson(`${GMAIL_API_BASE}/users/me/drafts`, {
        token: accessToken,
        searchParams,
      });
    } catch (err) {
      throw mapGmailAuthError(err, account);
    }
    const drafts: GmailDraftRef[] = [];
    for (const d of raw.drafts ?? []) {
      drafts.push({
        id: typeof d.id === "string" ? d.id : "",
        messageId: typeof d.message?.id === "string" ? d.message.id : "",
        threadId:
          typeof d.message?.threadId === "string" ? d.message.threadId : "",
      });
    }
    return {
      drafts,
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
      resultSizeEstimate: raw.resultSizeEstimate ?? 0,
    };
  }

  /**
   * GET /users/me/drafts/{id} — single draft resource. `format` controls the
   * payload depth of the wrapped message (same enum as messages.get). Default
   * `metadata` returns headers + snippet. Returns the raw response so callers
   * decide what to extract.
   */
  async getDraft(
    account: string,
    id: string,
    format: GmailMessageFormat = "metadata",
  ): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    return retryOn404(
      () =>
        fetchJson<unknown>(
          `${GMAIL_API_BASE}/users/me/drafts/${encodeURIComponent(id)}`,
          {
            token: accessToken,
            searchParams: { format },
          },
        ),
      account,
      id,
    );
  }

  /**
   * PUT /users/me/drafts/{id} — replace the draft's MIME body. Same request
   * and response shape as `createDraft`; mapped to the slim `GmailDraftRef`.
   */
  async updateDraft(
    account: string,
    id: string,
    raw: string,
  ): Promise<GmailDraftRef> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    let response: { id?: unknown; message?: { id?: unknown; threadId?: unknown } };
    try {
      response = await fetchJson(
        `${GMAIL_API_BASE}/users/me/drafts/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          body: { message: { raw } },
          token: accessToken,
        },
      );
    } catch (err) {
      throw wrapDraftError(err, account, id);
    }
    return {
      id: typeof response.id === "string" ? response.id : "",
      messageId:
        typeof response.message?.id === "string" ? response.message.id : "",
      threadId:
        typeof response.message?.threadId === "string"
          ? response.message.threadId
          : "",
    };
  }

  /**
   * POST /users/me/drafts/{id}/send — promote a draft to a sent message.
   * Returns the same shape as `sendMessage` (id is the new message id, plus
   * threadId and labelIds).
   */
  async sendDraft(account: string, id: string): Promise<GmailSendResponse> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    // Gmail's drafts.send is a top-level endpoint; the draft id goes in the
    // body, NOT the path. (`POST /drafts/{id}/send` returns 404 — that path
    // does not exist.) Retry-on-404 still useful in case the body-id has
    // not yet propagated.
    return retryOn404(
      () =>
        fetchJson<GmailSendResponse>(
          `${GMAIL_API_BASE}/users/me/drafts/send`,
          {
            method: "POST",
            body: { id },
            token: accessToken,
          },
        ),
      account,
      id,
    );
  }

  /**
   * DELETE /users/me/drafts/{id} — permanently delete a draft. Gmail returns
   * 204 No Content on success.
   */
  async deleteDraft(account: string, id: string): Promise<void> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    await retryOn404(
      () =>
        fetchJson<unknown>(
          `${GMAIL_API_BASE}/users/me/drafts/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
            token: accessToken,
          },
        ),
      account,
      id,
    );
  }

  // --- Settings: filters -----------------------------------------------------
  // Path uses `me` (the authed user, selected by oauthFor(account)) to match the
  // existing send/read/label convention; Gmail's userId path param accepts "me".
  // 403 here means the token lacks gmail.settings.basic (not gmail.modify), so
  // these use a settings-specific scope-insufficient error mapper.

  /**
   * POST /users/me/settings/filters — create a mail filter. Body is a Filter
   * resource (criteria + action, no id); Gmail returns the created Filter with a
   * server-assigned id. Returns the raw resource for the tool layer to slim.
   */
  async createFilter(account: string, opts: CreateFilterOpts): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/filters`,
        {
          method: "POST",
          body: { criteria: opts.criteria, action: opts.action },
          token: accessToken,
        },
      );
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  /**
   * GET /users/me/settings/filters — list mail filters. Gmail returns
   * `{ filter: [...] }`; normalized to a bare array (empty when the field is
   * absent). Each element is a raw Filter for the tool layer to slim.
   */
  async listFilters(account: string): Promise<unknown[]> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    let raw: { filter?: unknown[] };
    try {
      raw = await fetchJson(`${GMAIL_API_BASE}/users/me/settings/filters`, {
        token: accessToken,
      });
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
    return Array.isArray(raw.filter) ? raw.filter : [];
  }

  /**
   * DELETE /users/me/settings/filters/{id} — remove a filter. Gmail returns 204.
   * Recoverable only by recreating the filter.
   */
  async deleteFilter(account: string, filterId: string): Promise<void> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/filters/${encodeURIComponent(filterId)}`,
        { method: "DELETE", token: accessToken },
      );
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  // --- Settings: vacation ----------------------------------------------------

  /** GET /users/me/settings/vacation — vacation auto-reply settings (raw). */
  async getVacation(account: string): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/vacation`,
        { token: accessToken },
      );
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  /**
   * PUT /users/me/settings/vacation — replace vacation auto-reply settings.
   * Body is a VacationSettings resource; PUT `{ enableAutoReply: false }` clears
   * it. Returns the updated resource (raw).
   */
  async updateVacation(
    account: string,
    settings: GmailVacationSettings,
  ): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/vacation`,
        { method: "PUT", body: settings, token: accessToken },
      );
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  // --- Settings: imap / pop / language --------------------------------------

  /** GET /users/me/settings/imap — IMAP access settings (raw). */
  async getImap(account: string): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/imap`,
        { token: accessToken },
      );
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  /** PUT /users/me/settings/imap — replace IMAP access settings (raw echo). */
  async updateImap(
    account: string,
    settings: GmailImapSettings,
  ): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/imap`,
        { method: "PUT", body: settings, token: accessToken },
      );
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  /** GET /users/me/settings/pop — POP access settings (raw). */
  async getPop(account: string): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/pop`,
        { token: accessToken },
      );
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  /** PUT /users/me/settings/pop — replace POP access settings (raw echo). */
  async updatePop(
    account: string,
    settings: GmailPopSettings,
  ): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/pop`,
        { method: "PUT", body: settings, token: accessToken },
      );
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  /**
   * PUT /users/me/settings/language — set the display language (RFC 3066 tag).
   * Body is `{ displayLanguage }`; Gmail may echo back a close stored variant.
   */
  async updateLanguage(
    account: string,
    displayLanguage: string,
  ): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/language`,
        { method: "PUT", body: { displayLanguage }, token: accessToken },
      );
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  // --- Settings: sendAs ------------------------------------------------------

  /**
   * GET /users/me/settings/sendAs — list send-as aliases. Gmail returns
   * `{ sendAs: [...] }`; normalized to a bare array (empty when absent). Each
   * element is a raw SendAs for the tool layer to slim.
   */
  async listSendAs(account: string): Promise<unknown[]> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    let raw: { sendAs?: unknown[] };
    try {
      raw = await fetchJson(`${GMAIL_API_BASE}/users/me/settings/sendAs`, {
        token: accessToken,
      });
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
    return Array.isArray(raw.sendAs) ? raw.sendAs : [];
  }

  /**
   * PATCH /users/me/settings/sendAs/{sendAsEmail} — partial update of an
   * existing alias's signature and/or display name. PATCH (not PUT) so unsent
   * fields like `replyToAddress` / `isDefault` are preserved; a PUT would
   * replace the whole resource and silently reset them. Only `signature` /
   * `displayName` are sent. Returns the updated SendAs (raw).
   */
  async updateSendAs(
    account: string,
    sendAsEmail: string,
    opts: UpdateSendAsOpts,
  ): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    const body: Record<string, unknown> = {};
    if (opts.signature !== undefined) body["signature"] = opts.signature;
    if (opts.displayName !== undefined) body["displayName"] = opts.displayName;
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/sendAs/${encodeURIComponent(sendAsEmail)}`,
        { method: "PATCH", body, token: accessToken },
      );
    } catch (err) {
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  // --- Settings: auto-forwarding (sharing scope) -----------------------------
  // 403 here means the token lacks gmail.settings.sharing (not just .basic), so
  // these use a sharing-specific scope-insufficient error mapper.

  /** GET /users/me/settings/autoForwarding — auto-forwarding settings (raw). */
  async getAutoForwarding(account: string): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/autoForwarding`,
        { token: accessToken },
      );
    } catch (err) {
      // READ: accepts gmail.settings.basic/modify/readonly — hint the lighter
      // scope, not the sensitive sharing scope (which only the WRITE needs).
      throw mapGmailSettingsAuthError(err, account);
    }
  }

  /**
   * PUT /users/me/settings/autoForwarding — replace auto-forwarding settings.
   * Body is an AutoForwarding resource; `emailAddress` must already be a
   * verified forwarding address when enabling. Returns the updated resource.
   */
  async updateAutoForwarding(
    account: string,
    settings: GmailAutoForwarding,
  ): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/autoForwarding`,
        { method: "PUT", body: settings, token: accessToken },
      );
    } catch (err) {
      throw mapGmailSharingAuthError(err, account);
    }
  }

  // --- Settings: forwarding addresses (sharing scope) ------------------------

  /**
   * GET /users/me/settings/forwardingAddresses — list forwarding addresses.
   * Gmail returns `{ forwardingAddresses: [...] }`; normalized to a bare array
   * (empty when absent). Each element is a raw ForwardingAddress to slim.
   */
  async listForwardingAddresses(account: string): Promise<unknown[]> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    let raw: { forwardingAddresses?: unknown[] };
    try {
      raw = await fetchJson(
        `${GMAIL_API_BASE}/users/me/settings/forwardingAddresses`,
        { token: accessToken },
      );
    } catch (err) {
      // READ: accepts gmail.settings.basic/modify/readonly — hint the lighter
      // scope, not the sensitive sharing scope (which only the WRITES need).
      throw mapGmailSettingsAuthError(err, account);
    }
    return Array.isArray(raw.forwardingAddresses) ? raw.forwardingAddresses : [];
  }

  /**
   * POST /users/me/settings/forwardingAddresses — register a forwarding
   * address. Body is `{ forwardingEmail }`; Gmail may set verificationStatus to
   * `pending` and mail the address to confirm ownership. Returns the raw
   * ForwardingAddress.
   */
  async createForwardingAddress(
    account: string,
    forwardingEmail: string,
  ): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/forwardingAddresses`,
        { method: "POST", body: { forwardingEmail }, token: accessToken },
      );
    } catch (err) {
      throw mapGmailSharingAuthError(err, account);
    }
  }

  /**
   * DELETE /users/me/settings/forwardingAddresses/{forwardingEmail} — remove a
   * forwarding address (revokes any verification). Gmail returns 204.
   */
  async deleteForwardingAddress(
    account: string,
    forwardingEmail: string,
  ): Promise<void> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/forwardingAddresses/${encodeURIComponent(forwardingEmail)}`,
        { method: "DELETE", token: accessToken },
      );
    } catch (err) {
      throw mapGmailSharingAuthError(err, account);
    }
  }

  // --- Settings: delegates (sharing scope) -----------------------------------

  /**
   * GET /users/me/settings/delegates — list mailbox delegates. Gmail returns
   * `{ delegates: [...] }`; normalized to a bare array (empty when absent). Each
   * element is a raw Delegate to slim.
   */
  async listDelegates(account: string): Promise<unknown[]> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    let raw: { delegates?: unknown[] };
    try {
      raw = await fetchJson(`${GMAIL_API_BASE}/users/me/settings/delegates`, {
        token: accessToken,
      });
    } catch (err) {
      // READ: accepts gmail.settings.basic/modify/readonly — hint the lighter
      // scope, not the sensitive sharing scope (which only the WRITES need).
      throw mapGmailSettingsAuthError(err, account);
    }
    return Array.isArray(raw.delegates) ? raw.delegates : [];
  }

  /**
   * POST /users/me/settings/delegates — grant a delegate read/send/delete
   * access to this mailbox. Body is `{ delegateEmail }`; Workspace-only and
   * domain-restricted. Returns the raw Delegate.
   */
  async createDelegate(
    account: string,
    delegateEmail: string,
  ): Promise<unknown> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/delegates`,
        { method: "POST", body: { delegateEmail }, token: accessToken },
      );
    } catch (err) {
      throw mapGmailSharingAuthError(err, account);
    }
  }

  /**
   * DELETE /users/me/settings/delegates/{delegateEmail} — revoke a delegate's
   * access. Gmail returns 204.
   */
  async deleteDelegate(
    account: string,
    delegateEmail: string,
  ): Promise<void> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/settings/delegates/${encodeURIComponent(delegateEmail)}`,
        { method: "DELETE", token: accessToken },
      );
    } catch (err) {
      throw mapGmailSharingAuthError(err, account);
    }
  }

  // --- Permanent delete (mail.google.com scope; IRREVERSIBLE) ----------------
  // These bypass Trash and cannot be undone. A 403 here means the token lacks
  // the full `https://mail.google.com/` scope (gmail.modify is insufficient),
  // so they use a delete-specific scope-insufficient error mapper.

  /**
   * DELETE /users/me/messages/{id} — immediately and PERMANENTLY delete a
   * message (bypasses Trash, cannot be undone). Gmail returns 204.
   */
  async deleteMessage(account: string, messageId: string): Promise<void> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(messageId)}`,
        { method: "DELETE", token: accessToken },
      );
    } catch (err) {
      throw mapGmailDeleteAuthError(err, account);
    }
  }

  /**
   * POST /users/me/messages/batchDelete — PERMANENTLY delete many messages by
   * id (bypasses Trash, cannot be undone). Body is `{ ids }`; Gmail returns 204
   * and gives no per-id error for already-deleted / nonexistent ids. Chunk to
   * <=1000 ids per call (caller's responsibility).
   */
  async batchDeleteMessages(account: string, ids: string[]): Promise<void> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/messages/batchDelete`,
        { method: "POST", body: { ids }, token: accessToken },
      );
    } catch (err) {
      throw mapGmailDeleteAuthError(err, account);
    }
  }

  /**
   * DELETE /users/me/threads/{id} — immediately and PERMANENTLY delete a thread
   * and every message in it (bypasses Trash, cannot be undone). Gmail returns
   * 204.
   */
  async deleteThread(account: string, threadId: string): Promise<void> {
    const accessToken = await this.oauthFor(account).getAccessToken();
    try {
      await fetchJson<unknown>(
        `${GMAIL_API_BASE}/users/me/threads/${encodeURIComponent(threadId)}`,
        { method: "DELETE", token: accessToken },
      );
    } catch (err) {
      throw mapGmailDeleteAuthError(err, account);
    }
  }
}

/**
 * Same as `mapGmailAuthError` for 401/403, but additionally rewrites
 * NotFoundError messages to include the draft id for friendlier surface to
 * MCP callers. Used by per-id draft methods (get/update/send/delete).
 */
function wrapDraftError(err: unknown, account: string, id: string): unknown {
  if (err instanceof NotFoundError) {
    return new NotFoundError(`draft not found: ${id}`, { cause: err });
  }
  return mapGmailAuthError(err, account);
}

/**
 * Friendlier error messages for Gmail API failures. fetchJson maps 401/403
 * to AuthError with a generic "<METHOD> <URL> → <status>" message; we promote
 * 403 to a specific scope-insufficient hint with the exact `bin/auth.py`
 * re-auth command. Used uniformly across send/read/modify methods.
 */
function mapGmailAuthError(err: unknown, account: string): unknown {
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

/**
 * Settings/filters variant of `mapGmailAuthError`. The settings surface needs
 * the `gmail.settings.basic` scope, which is NOT implied by `gmail.modify` /
 * `mail.google.com`, so a 403 here means a different scope bump than the
 * send/read/modify surface. Promotes 403 to a scope-insufficient hint naming
 * that scope; 401 to a token-rejected hint.
 */
function mapGmailSettingsAuthError(err: unknown, account: string): unknown {
  if (!(err instanceof AuthError)) return err;
  const msg = err.message;
  if (msg.includes("→ 403")) {
    return new AuthError(
      `scope insufficient for account ${account} — re-run python3 ~/.santo-agent/bin/auth.py --account ${account} after expanding scope to gmail.settings.basic`,
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

/**
 * Shared body for the scope-specific settings/delete auth mappers: promote a
 * 403 to a scope-insufficient hint naming the exact scope this surface needs,
 * and a 401 to a token-rejected hint. `scopeHint` is the scope string quoted in
 * the re-auth guidance (e.g. `gmail.settings.sharing`, `https://mail.google.com/`).
 */
function mapScopeAuthError(
  err: unknown,
  account: string,
  scopeHint: string,
): unknown {
  if (!(err instanceof AuthError)) return err;
  const msg = err.message;
  if (msg.includes("→ 403")) {
    return new AuthError(
      `scope insufficient for account ${account} — re-run python3 ~/.santo-agent/bin/auth.py --account ${account} after expanding scope to ${scopeHint}`,
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

/**
 * Sharing-scope variant. Auto-forwarding, forwarding addresses, and delegates
 * need `gmail.settings.sharing`, which is NOT implied by `gmail.settings.basic`
 * / `mail.google.com`. A 403 here names that scope.
 */
function mapGmailSharingAuthError(err: unknown, account: string): unknown {
  return mapScopeAuthError(err, account, "gmail.settings.sharing");
}

/**
 * Permanent-delete variant. messages.delete / batchDelete / threads.delete need
 * the full `https://mail.google.com/` scope; `gmail.modify` is rejected. A 403
 * here names that scope.
 */
function mapGmailDeleteAuthError(err: unknown, account: string): unknown {
  return mapScopeAuthError(err, account, "https://mail.google.com/");
}
