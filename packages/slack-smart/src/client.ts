import {
  loadCreds,
  fetchJson,
  AuthError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from "smart-mcp-core";
import { fetchRemoteFile } from "./safe-fetch.js";
import type { FetchRemoteFileOptions } from "./safe-fetch.js";

/**
 * A file's private download URL is where we attach the user's Bearer token, so
 * it MUST be a Slack-owned host. Never let a poisoned files.info response point
 * our token at an arbitrary server. Throws ValidationError otherwise.
 */
function assertSlackFileHost(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ValidationError(`Slack file URL is not a valid URL: ${rawUrl}`);
  }
  if (u.protocol !== "https:") {
    throw new ValidationError(
      `Slack file URL must use https, got "${u.protocol}"`,
    );
  }
  const host = u.hostname.toLowerCase();
  if (host !== "slack.com" && !host.endsWith(".slack.com")) {
    throw new ValidationError(
      `Refusing to fetch a Slack file from a non-Slack host ("${host}").`,
    );
  }
}

export type SlackCreds = {
  SLACK_USER_TOKEN: string;
  SLACK_BOT_TOKEN?: string;
};

// Pagination convention: methods that accept a cursor pass it as `cursor` in
// args and read `response_metadata.next_cursor` from the response to get the
// next page. No central pagination helper is needed — each method handles it.

type SlackEnvelope = {
  ok: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  response_metadata?: { next_cursor?: string };
};

export class SlackClient {
  private readonly creds: SlackCreds;

  constructor(creds?: SlackCreds) {
    this.creds =
      creds ??
      // loadCreds generic-variance wart: the inferred type is Record<string,string>
      // but we only ever fill the keys listed above, so the cast is safe.
      (loadCreds<Record<"SLACK_USER_TOKEN" | "SLACK_BOT_TOKEN", string>>({
        serviceName: "slack-smart",
        required: ["SLACK_USER_TOKEN"],
        optional: ["SLACK_BOT_TOKEN"],
      }) as SlackCreds);
  }

  private tokenFor(which: "user" | "bot"): string {
    if (which === "user") return this.creds.SLACK_USER_TOKEN;
    const bot = this.creds.SLACK_BOT_TOKEN;
    if (!bot || bot === "") {
      throw new AuthError(
        "This action needs a bot token. Set SLACK_BOT_TOKEN in ~/.config/smart-mcps/.env.",
      );
    }
    return bot;
  }

  async slackCall<T extends SlackEnvelope>(
    method: string,
    // Widened from Record<string, string|number|boolean|undefined> to support
    // array-valued fields (e.g. `files` in files.completeUploadExternal).
    // GET callers only pass primitives; POST path JSON.stringifies, so arrays
    // and objects serialize fine.
    args: Record<string, unknown> = {},
    opts: { token?: "user" | "bot"; http?: "GET" | "POST" } = {},
  ): Promise<T> {
    const url = `https://slack.com/api/${method}`;
    const token = this.tokenFor(opts.token ?? "user");
    const httpMethod = opts.http ?? "GET";

    let body: T;
    if (httpMethod === "GET") {
      // GET callers only ever pass primitives — cast is safe.
      body = await fetchJson<T>(url, {
        token,
        searchParams: args as Record<string, string | number | boolean | undefined>,
      });
    } else {
      // Drop undefined keys before sending as JSON body
      const cleanArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined) cleanArgs[k] = v;
      }
      body = await fetchJson<T>(url, { method: "POST", token, body: cleanArgs });
    }

    if (!body.ok) {
      const error = body.error ?? "unknown";
      switch (error) {
        case "not_authed":
        case "invalid_auth":
        case "token_revoked":
        case "account_inactive":
        case "no_permission":
          throw new AuthError(
            `Slack rejected the request (${error}). Check SLACK_USER_TOKEN/SLACK_BOT_TOKEN.`,
            { detail: body },
          );
        case "missing_scope":
          throw new AuthError(
            `Slack missing_scope: add the scope "${body.needed ?? "?"}" to your token and reinstall.`,
            { detail: body },
          );
        case "channel_not_found":
        case "user_not_found":
        case "users_not_found":
        case "message_not_found":
        case "thread_not_found":
        case "file_not_found":
        case "not_in_channel":
          throw new NotFoundError(`Slack: ${error}`, { detail: body });
        case "ratelimited":
          throw new RateLimitError("Slack rate limited", { detail: body });
        default:
          throw new UpstreamError(`Slack API error: ${error}`, { detail: body });
      }
    }

    return body;
  }

  async authTest(
    which: "user" | "bot" = "user",
  ): Promise<{
    ok: true;
    url: string;
    team: string;
    user: string;
    team_id: string;
    user_id: string;
    bot_id?: string;
  }> {
    const result = await this.slackCall<SlackEnvelope & {
      url: string;
      team: string;
      user: string;
      team_id: string;
      user_id: string;
      bot_id?: string;
    }>("auth.test", {}, { token: which, http: "GET" });
    // slackCall throws on ok:false, so this point is only reached when ok===true.
    return { ...result, ok: true };
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  async listChannels(args: {
    types?: string;
    exclude_archived?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{
    ok: true;
    channels: unknown[];
    response_metadata?: { next_cursor?: string };
  }> {
    return this.slackCall<
      SlackEnvelope & {
        channels: unknown[];
        response_metadata?: { next_cursor?: string };
      }
    >("conversations.list", {
      ...(args.types !== undefined ? { types: args.types } : {}),
      ...(args.exclude_archived !== undefined
        ? { exclude_archived: args.exclude_archived }
        : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    }) as Promise<{
      ok: true;
      channels: unknown[];
      response_metadata?: { next_cursor?: string };
    }>;
  }

  async getHistory(args: {
    channel: string;
    limit?: number;
    oldest?: string;
    latest?: string;
    inclusive?: boolean;
    cursor?: string;
  }): Promise<{
    ok: true;
    messages: unknown[];
    has_more?: boolean;
    response_metadata?: { next_cursor?: string };
  }> {
    return this.slackCall<
      SlackEnvelope & {
        messages: unknown[];
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      }
    >("conversations.history", {
      channel: args.channel,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.oldest !== undefined ? { oldest: args.oldest } : {}),
      ...(args.latest !== undefined ? { latest: args.latest } : {}),
      ...(args.inclusive !== undefined ? { inclusive: args.inclusive } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    }) as Promise<{
      ok: true;
      messages: unknown[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>;
  }

  async getReplies(args: {
    channel: string;
    ts: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    ok: true;
    messages: unknown[];
    response_metadata?: { next_cursor?: string };
  }> {
    return this.slackCall<
      SlackEnvelope & {
        messages: unknown[];
        response_metadata?: { next_cursor?: string };
      }
    >("conversations.replies", {
      channel: args.channel,
      ts: args.ts,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    }) as Promise<{
      ok: true;
      messages: unknown[];
      response_metadata?: { next_cursor?: string };
    }>;
  }

  async getChannelInfo(args: {
    channel: string;
    include_num_members?: boolean;
  }): Promise<{
    ok: true;
    channel: unknown;
  }> {
    return this.slackCall<SlackEnvelope & { channel: unknown }>(
      "conversations.info",
      {
        channel: args.channel,
        ...(args.include_num_members !== undefined
          ? { include_num_members: args.include_num_members }
          : {}),
      },
    ) as Promise<{ ok: true; channel: unknown }>;
  }

  async getMembers(args: {
    channel: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    ok: true;
    members: unknown[];
    response_metadata?: { next_cursor?: string };
  }> {
    return this.slackCall<
      SlackEnvelope & {
        members: unknown[];
        response_metadata?: { next_cursor?: string };
      }
    >("conversations.members", {
      channel: args.channel,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    }) as Promise<{
      ok: true;
      members: unknown[];
      response_metadata?: { next_cursor?: string };
    }>;
  }

  async openDm(args: { users?: string; channel?: string }): Promise<{
    ok: true;
    channel: { id: string };
  }> {
    return this.slackCall<SlackEnvelope & { channel: { id: string } }>(
      "conversations.open",
      {
        ...(args.users !== undefined ? { users: args.users } : {}),
        ...(args.channel !== undefined ? { channel: args.channel } : {}),
      },
      { http: "POST" },
    ) as Promise<{ ok: true; channel: { id: string } }>;
  }

  // ---------------------------------------------------------------------------
  // Conversations (write)
  // ---------------------------------------------------------------------------

  async markConversation(args: { channel: string; ts: string }): Promise<{
    ok: true;
  }> {
    return this.slackCall<SlackEnvelope>(
      "conversations.mark",
      { channel: args.channel, ts: args.ts },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true }>;
  }

  async inviteToChannel(args: { channel: string; users: string }): Promise<{
    ok: true;
    channel: unknown;
  }> {
    return this.slackCall<SlackEnvelope & { channel: unknown }>(
      "conversations.invite",
      { channel: args.channel, users: args.users },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true; channel: unknown }>;
  }

  async setChannelPurpose(args: {
    channel: string;
    purpose: string;
  }): Promise<{ ok: true }> {
    return this.slackCall<SlackEnvelope>(
      "conversations.setPurpose",
      { channel: args.channel, purpose: args.purpose },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true }>;
  }

  async setChannelTopic(args: {
    channel: string;
    topic: string;
  }): Promise<{ ok: true }> {
    return this.slackCall<SlackEnvelope>(
      "conversations.setTopic",
      { channel: args.channel, topic: args.topic },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true }>;
  }

  async createConversation(args: {
    name: string;
    is_private?: boolean;
    team_id?: string;
  }): Promise<{ ok: true; channel: unknown }> {
    return this.slackCall<SlackEnvelope & { channel: unknown }>(
      "conversations.create",
      {
        name: args.name,
        ...(args.is_private !== undefined ? { is_private: args.is_private } : {}),
        ...(args.team_id !== undefined ? { team_id: args.team_id } : {}),
      },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true; channel: unknown }>;
  }

  // ---------------------------------------------------------------------------
  // Messages (write)
  // ---------------------------------------------------------------------------
  //
  // All four methods accept a `token` parameter ("bot" | "user") so the caller
  // controls which identity sends the message. Slack's deprecated `as_user`
  // API param is intentionally NOT sent — token selection alone determines
  // posting identity on modern Slack apps.

  async postMessage(
    args: Record<string, string | number | boolean | undefined>,
    token: "bot" | "user",
  ): Promise<{ ok: true; channel: string; ts: string; message?: unknown }> {
    return this.slackCall<
      SlackEnvelope & { channel: string; ts: string; message?: unknown }
    >("chat.postMessage", args, { token, http: "POST" }) as Promise<{
      ok: true;
      channel: string;
      ts: string;
      message?: unknown;
    }>;
  }

  async updateMessage(
    args: Record<string, string | number | boolean | undefined>,
    token: "bot" | "user",
  ): Promise<{ ok: true; channel: string; ts: string }> {
    return this.slackCall<SlackEnvelope & { channel: string; ts: string }>(
      "chat.update",
      args,
      { token, http: "POST" },
    ) as Promise<{ ok: true; channel: string; ts: string }>;
  }

  async deleteMessage(
    args: Record<string, string | number | boolean | undefined>,
    token: "bot" | "user",
  ): Promise<{ ok: true; channel: string; ts: string }> {
    return this.slackCall<SlackEnvelope & { channel: string; ts: string }>(
      "chat.delete",
      args,
      { token, http: "POST" },
    ) as Promise<{ ok: true; channel: string; ts: string }>;
  }

  async scheduleMessage(
    args: Record<string, string | number | boolean | undefined>,
    token: "bot" | "user",
  ): Promise<{
    ok: true;
    channel: string;
    scheduled_message_id: string;
    post_at: number;
  }> {
    return this.slackCall<
      SlackEnvelope & {
        channel: string;
        scheduled_message_id: string;
        post_at: number;
      }
    >("chat.scheduleMessage", args, { token, http: "POST" }) as Promise<{
      ok: true;
      channel: string;
      scheduled_message_id: string;
      post_at: number;
    }>;
  }

  // Read: turn a (channel, ts) into a shareable archive link. GET, user token,
  // no special scope.
  async getPermalink(args: {
    channel: string;
    message_ts: string;
  }): Promise<{ ok: true; permalink: string; channel: string }> {
    return this.slackCall<
      SlackEnvelope & { permalink: string; channel: string }
    >(
      "chat.getPermalink",
      { channel: args.channel, message_ts: args.message_ts },
      { token: "user", http: "GET" },
    ) as Promise<{ ok: true; permalink: string; channel: string }>;
  }

  // ---------------------------------------------------------------------------
  // Search (user token, scope search:read)
  // ---------------------------------------------------------------------------

  async searchMessages(args: {
    query: string;
    count?: number;
    sort?: string;
    sort_dir?: string;
    highlight?: boolean;
    cursor?: string;
  }): Promise<{
    ok: true;
    messages: {
      matches: unknown[];
      total: number;
    };
    response_metadata?: { next_cursor?: string };
  }> {
    return this.slackCall<
      SlackEnvelope & {
        messages: { matches: unknown[]; total: number };
        response_metadata?: { next_cursor?: string };
      }
    >(
      "search.messages",
      {
        query: args.query,
        ...(args.count !== undefined ? { count: args.count } : {}),
        ...(args.sort !== undefined ? { sort: args.sort } : {}),
        ...(args.sort_dir !== undefined ? { sort_dir: args.sort_dir } : {}),
        ...(args.highlight !== undefined ? { highlight: args.highlight } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      },
      { token: "user", http: "GET" },
    ) as Promise<{
      ok: true;
      messages: { matches: unknown[]; total: number };
      response_metadata?: { next_cursor?: string };
    }>;
  }

  async searchFiles(args: {
    query: string;
    count?: number;
    sort?: string;
    sort_dir?: string;
    cursor?: string;
  }): Promise<{
    ok: true;
    files: {
      matches: unknown[];
      total: number;
    };
    response_metadata?: { next_cursor?: string };
  }> {
    return this.slackCall<
      SlackEnvelope & {
        files: { matches: unknown[]; total: number };
        response_metadata?: { next_cursor?: string };
      }
    >(
      "search.files",
      {
        query: args.query,
        ...(args.count !== undefined ? { count: args.count } : {}),
        ...(args.sort !== undefined ? { sort: args.sort } : {}),
        ...(args.sort_dir !== undefined ? { sort_dir: args.sort_dir } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      },
      { token: "user", http: "GET" },
    ) as Promise<{
      ok: true;
      files: { matches: unknown[]; total: number };
      response_metadata?: { next_cursor?: string };
    }>;
  }

  // ---------------------------------------------------------------------------
  // Reactions (user token)
  // ---------------------------------------------------------------------------

  async addReaction(args: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<{ ok: true }> {
    return this.slackCall<SlackEnvelope>(
      "reactions.add",
      { channel: args.channel, timestamp: args.timestamp, name: args.name },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true }>;
  }

  async removeReaction(args: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<{ ok: true }> {
    return this.slackCall<SlackEnvelope>(
      "reactions.remove",
      { channel: args.channel, timestamp: args.timestamp, name: args.name },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true }>;
  }

  async getReactions(args: {
    channel: string;
    timestamp: string;
    full?: boolean;
  }): Promise<{
    ok: true;
    type: string;
    message?: {
      reactions?: Array<{ name: string; count: number; users: string[] }>;
    };
  }> {
    return this.slackCall<
      SlackEnvelope & {
        type: string;
        message?: {
          reactions?: Array<{ name: string; count: number; users: string[] }>;
        };
      }
    >(
      "reactions.get",
      {
        channel: args.channel,
        timestamp: args.timestamp,
        ...(args.full !== undefined ? { full: args.full } : {}),
      },
      { token: "user", http: "GET" },
    ) as Promise<{
      ok: true;
      type: string;
      message?: {
        reactions?: Array<{ name: string; count: number; users: string[] }>;
      };
    }>;
  }

  // ---------------------------------------------------------------------------
  // Users (user token, scope users:read [+users:read.email for email field])
  // ---------------------------------------------------------------------------

  async listUsers(args: {
    limit?: number;
    cursor?: string;
  }): Promise<{
    ok: true;
    members: unknown[];
    response_metadata?: { next_cursor?: string };
  }> {
    return this.slackCall<
      SlackEnvelope & {
        members: unknown[];
        response_metadata?: { next_cursor?: string };
      }
    >("users.list", {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    }) as Promise<{
      ok: true;
      members: unknown[];
      response_metadata?: { next_cursor?: string };
    }>;
  }

  async getUserInfo(args: { user: string }): Promise<{
    ok: true;
    user: unknown;
  }> {
    return this.slackCall<SlackEnvelope & { user: unknown }>(
      "users.info",
      { user: args.user },
    ) as Promise<{ ok: true; user: unknown }>;
  }

  async getUserProfile(args: { user?: string }): Promise<{
    ok: true;
    profile: unknown;
  }> {
    return this.slackCall<SlackEnvelope & { profile: unknown }>(
      "users.profile.get",
      {
        ...(args.user !== undefined ? { user: args.user } : {}),
      },
    ) as Promise<{ ok: true; profile: unknown }>;
  }

  async lookupByEmail(args: { email: string }): Promise<{
    ok: true;
    user: unknown;
  }> {
    return this.slackCall<SlackEnvelope & { user: unknown }>(
      "users.lookupByEmail",
      { email: args.email },
    ) as Promise<{ ok: true; user: unknown }>;
  }

  async getPresence(args: { user?: string }): Promise<{
    ok: true;
    presence: string;
    online?: boolean;
    auto_away?: boolean;
    manual_away?: boolean;
  }> {
    return this.slackCall<
      SlackEnvelope & {
        presence: string;
        online?: boolean;
        auto_away?: boolean;
        manual_away?: boolean;
      }
    >("users.getPresence", {
      ...(args.user !== undefined ? { user: args.user } : {}),
    }) as Promise<{
      ok: true;
      presence: string;
      online?: boolean;
      auto_away?: boolean;
      manual_away?: boolean;
    }>;
  }

  // ---------------------------------------------------------------------------
  // Files (user token, scopes files:read / files:write)
  // ---------------------------------------------------------------------------

  async listFiles(args: {
    channel?: string;
    user?: string;
    count?: number;
    page?: number;
    ts_from?: string;
    ts_to?: string;
    types?: string;
  }): Promise<{
    ok: true;
    files: unknown[];
    paging?: { count: number; total: number; page: number; pages: number };
  }> {
    return this.slackCall<
      SlackEnvelope & {
        files: unknown[];
        paging?: { count: number; total: number; page: number; pages: number };
      }
    >("files.list", {
      ...(args.channel !== undefined ? { channel: args.channel } : {}),
      ...(args.user !== undefined ? { user: args.user } : {}),
      ...(args.count !== undefined ? { count: args.count } : {}),
      ...(args.page !== undefined ? { page: args.page } : {}),
      ...(args.ts_from !== undefined ? { ts_from: args.ts_from } : {}),
      ...(args.ts_to !== undefined ? { ts_to: args.ts_to } : {}),
      ...(args.types !== undefined ? { types: args.types } : {}),
    }) as Promise<{
      ok: true;
      files: unknown[];
      paging?: { count: number; total: number; page: number; pages: number };
    }>;
  }

  async getFileInfo(args: { file: string }): Promise<{
    ok: true;
    file: unknown;
  }> {
    return this.slackCall<SlackEnvelope & { file: unknown }>(
      "files.info",
      { file: args.file },
    ) as Promise<{ ok: true; file: unknown }>;
  }

  // Download a file's raw bytes. files.info gives the token-authed
  // url_private_download; we GET it with the USER Bearer token (only ever to a
  // Slack host — see assertSlackFileHost), capped at maxBytes. Returns the raw
  // files.info object alongside the bytes so the caller owns the slim mapping.
  async downloadFile(args: { file: string; maxBytes: number }): Promise<{
    file: Record<string, unknown>;
    bytes: Uint8Array;
  }> {
    const infoResp = await this.getFileInfo({ file: args.file });
    const f = (infoResp.file ?? {}) as Record<string, unknown>;
    const url =
      typeof f["url_private_download"] === "string"
        ? (f["url_private_download"] as string)
        : typeof f["url_private"] === "string"
          ? (f["url_private"] as string)
          : undefined;
    if (url === undefined) {
      throw new NotFoundError(
        "Slack file has no downloadable URL (it may be an externally hosted file).",
        { detail: f },
      );
    }
    assertSlackFileHost(url);

    const token = this.tokenFor("user");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new UpstreamError("Slack file download timed out");
      }
      throw new UpstreamError(
        `Slack file download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      if (!res.ok) {
        throw new UpstreamError(
          `Slack file download returned HTTP ${res.status}`,
        );
      }
      // Slack answers an unauthorized file GET with a 200 HTML sign-in page
      // rather than the bytes; surface that as an auth error, not markup.
      const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
      const expected =
        typeof f["mimetype"] === "string" ? (f["mimetype"] as string) : "";
      if (ctype.includes("text/html") && !expected.includes("html")) {
        throw new AuthError(
          "Slack returned an HTML page instead of file bytes — the user token likely lacks files:read or cannot access this file.",
        );
      }
      const declared = res.headers.get("content-length");
      if (declared !== null) {
        const n = Number(declared);
        if (Number.isFinite(n) && n > args.maxBytes) {
          throw new ValidationError(
            `Slack file is ${n} bytes, over the ${args.maxBytes}-byte limit; raise max_bytes (hard cap 10 MB).`,
          );
        }
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > args.maxBytes) {
        throw new ValidationError(
          `Slack file is ${buf.length} bytes, over the ${args.maxBytes}-byte limit; raise max_bytes (hard cap 10 MB).`,
        );
      }
      return { file: f, bytes: buf };
    } finally {
      clearTimeout(timer);
    }
  }

  async getUploadUrl(args: {
    filename: string;
    length: number;
  }): Promise<{
    ok: true;
    upload_url: string;
    file_id: string;
  }> {
    return this.slackCall<
      SlackEnvelope & { upload_url: string; file_id: string }
    >("files.getUploadURLExternal", {
      filename: args.filename,
      length: args.length,
    }) as Promise<{ ok: true; upload_url: string; file_id: string }>;
  }

  // uploadBytes does NOT use slackCall/fetchJson — it POSTs raw multipart to the
  // pre-signed upload_url returned by getUploadUrl. Node 22 has global FormData,
  // Blob, and fetch.
  async uploadBytes(
    uploadUrl: string,
    bytes: Uint8Array,
    filename: string,
  ): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([bytes]), filename);
    const res = await fetch(uploadUrl, { method: "POST", body: form });
    if (!res.ok) {
      throw new UpstreamError(`File upload POST failed: ${res.status}`);
    }
  }

  async completeUpload(args: {
    files: Array<{ id: string; title?: string }>;
    channel_id?: string;
    initial_comment?: string;
    thread_ts?: string;
  }): Promise<{
    ok: true;
    files?: unknown[];
  }> {
    return this.slackCall<SlackEnvelope & { files?: unknown[] }>(
      "files.completeUploadExternal",
      {
        files: args.files,
        ...(args.channel_id !== undefined ? { channel_id: args.channel_id } : {}),
        ...(args.initial_comment !== undefined
          ? { initial_comment: args.initial_comment }
          : {}),
        ...(args.thread_ts !== undefined ? { thread_ts: args.thread_ts } : {}),
      },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true; files?: unknown[] }>;
  }

  // Fetch bytes from a caller-supplied http(s) URL for upload. SSRF-hardened
  // (scheme allowlist, private-address rejection, redirect re-validation, size
  // cap, timeout) — see safe-fetch.ts. No Slack token is involved.
  async fetchRemoteFile(
    url: string,
    opts?: FetchRemoteFileOptions,
  ): Promise<{ bytes: Uint8Array }> {
    return fetchRemoteFile(url, opts);
  }

  // ---------------------------------------------------------------------------
  // Pins (user token, scopes pins:read / pins:write)
  // ---------------------------------------------------------------------------

  async listPins(args: { channel: string }): Promise<{
    ok: true;
    items: unknown[];
  }> {
    return this.slackCall<SlackEnvelope & { items: unknown[] }>(
      "pins.list",
      { channel: args.channel },
      { token: "user", http: "GET" },
    ) as Promise<{ ok: true; items: unknown[] }>;
  }

  async addPin(args: { channel: string; timestamp: string }): Promise<{ ok: true }> {
    return this.slackCall<SlackEnvelope>(
      "pins.add",
      { channel: args.channel, timestamp: args.timestamp },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true }>;
  }

  async removePin(args: { channel: string; timestamp: string }): Promise<{ ok: true }> {
    return this.slackCall<SlackEnvelope>(
      "pins.remove",
      { channel: args.channel, timestamp: args.timestamp },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true }>;
  }

  // ---------------------------------------------------------------------------
  // DND (user token, scopes dnd:read / dnd:write)
  // ---------------------------------------------------------------------------

  async dndInfo(args: { user?: string }): Promise<{
    ok: true;
    dnd_enabled: boolean;
    next_dnd_start_ts?: number;
    next_dnd_end_ts?: number;
    snooze_enabled?: boolean;
    snooze_endtime?: number;
    snooze_remaining?: number;
  }> {
    return this.slackCall<
      SlackEnvelope & {
        dnd_enabled: boolean;
        next_dnd_start_ts?: number;
        next_dnd_end_ts?: number;
        snooze_enabled?: boolean;
        snooze_endtime?: number;
        snooze_remaining?: number;
      }
    >(
      "dnd.info",
      { ...(args.user !== undefined ? { user: args.user } : {}) },
      { token: "user", http: "GET" },
    ) as Promise<{
      ok: true;
      dnd_enabled: boolean;
      next_dnd_start_ts?: number;
      next_dnd_end_ts?: number;
      snooze_enabled?: boolean;
      snooze_endtime?: number;
      snooze_remaining?: number;
    }>;
  }

  async setSnooze(args: { num_minutes: number }): Promise<{
    ok: true;
    snooze_enabled: boolean;
    snooze_endtime: number;
    snooze_remaining: number;
  }> {
    return this.slackCall<
      SlackEnvelope & {
        snooze_enabled: boolean;
        snooze_endtime: number;
        snooze_remaining: number;
      }
    >(
      "dnd.setSnooze",
      { num_minutes: args.num_minutes },
      { token: "user", http: "POST" },
    ) as Promise<{
      ok: true;
      snooze_enabled: boolean;
      snooze_endtime: number;
      snooze_remaining: number;
    }>;
  }

  async endSnooze(): Promise<{
    ok: true;
    dnd_enabled: boolean;
    next_dnd_start_ts?: number;
    next_dnd_end_ts?: number;
    snooze_enabled?: boolean;
  }> {
    return this.slackCall<
      SlackEnvelope & {
        dnd_enabled: boolean;
        next_dnd_start_ts?: number;
        next_dnd_end_ts?: number;
        snooze_enabled?: boolean;
      }
    >(
      "dnd.endSnooze",
      {},
      { token: "user", http: "POST" },
    ) as Promise<{
      ok: true;
      dnd_enabled: boolean;
      next_dnd_start_ts?: number;
      next_dnd_end_ts?: number;
      snooze_enabled?: boolean;
    }>;
  }

  // ---------------------------------------------------------------------------
  // Misc (user token)
  // ---------------------------------------------------------------------------

  async listUsergroups(args: { include_disabled?: boolean }): Promise<{
    ok: true;
    usergroups: unknown[];
  }> {
    return this.slackCall<SlackEnvelope & { usergroups: unknown[] }>(
      "usergroups.list",
      {
        ...(args.include_disabled !== undefined
          ? { include_disabled: args.include_disabled }
          : {}),
      },
      { token: "user", http: "GET" },
    ) as Promise<{ ok: true; usergroups: unknown[] }>;
  }

  async teamInfo(): Promise<{
    ok: true;
    team: unknown;
  }> {
    return this.slackCall<SlackEnvelope & { team: unknown }>(
      "team.info",
      {},
      { token: "user", http: "GET" },
    ) as Promise<{ ok: true; team: unknown }>;
  }

  async listEmoji(): Promise<{
    ok: true;
    emoji: Record<string, string>;
  }> {
    return this.slackCall<SlackEnvelope & { emoji: Record<string, string> }>(
      "emoji.list",
      {},
      { token: "user", http: "GET" },
    ) as Promise<{ ok: true; emoji: Record<string, string> }>;
  }

  // ---------------------------------------------------------------------------
  // Canvases (user token, scopes canvases:read / canvases:write)
  // ---------------------------------------------------------------------------

  async createCanvas(args: {
    title?: string;
    markdown?: string;
    channel_id?: string;
  }): Promise<{ ok: true; canvas_id: string }> {
    return this.slackCall<SlackEnvelope & { canvas_id: string }>(
      "canvases.create",
      {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.markdown !== undefined
          ? { document_content: { type: "markdown", markdown: args.markdown } }
          : {}),
        ...(args.channel_id !== undefined ? { channel_id: args.channel_id } : {}),
      },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true; canvas_id: string }>;
  }

  async editCanvas(args: {
    canvas_id: string;
    changes: unknown[];
  }): Promise<{ ok: true }> {
    return this.slackCall<SlackEnvelope>(
      "canvases.edit",
      { canvas_id: args.canvas_id, changes: args.changes },
      { token: "user", http: "POST" },
    ) as Promise<{ ok: true }>;
  }
}
