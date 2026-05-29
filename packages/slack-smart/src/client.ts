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
}
