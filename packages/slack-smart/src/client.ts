import {
  loadCreds,
  fetchJson,
  AuthError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from "smart-mcp-core";

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
    args: Record<string, string | number | boolean | undefined> = {},
    opts: { token?: "user" | "bot"; http?: "GET" | "POST" } = {},
  ): Promise<T> {
    const url = `https://slack.com/api/${method}`;
    const token = this.tokenFor(opts.token ?? "user");
    const httpMethod = opts.http ?? "GET";

    let body: T;
    if (httpMethod === "GET") {
      body = await fetchJson<T>(url, { token, searchParams: args });
    } else {
      // Drop undefined keys before sending as JSON body
      const cleanArgs: Record<string, string | number | boolean> = {};
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
}
