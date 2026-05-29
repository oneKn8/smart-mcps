import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from "smart-mcp-core";
import { SlackClient } from "../client.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedUserToken: string | undefined;
let savedBotToken: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedUserToken = process.env.SLACK_USER_TOKEN;
  savedBotToken = process.env.SLACK_BOT_TOKEN;
  savedHome = process.env.HOME;
  delete process.env.SLACK_USER_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  // Point HOME at a non-existent directory so the shared ~/.config/smart-mcps/.env
  // fallback in loadCreds does not leak real-machine credentials into tests.
  process.env.HOME = "/tmp/slack-smart-test-no-home";
});

afterEach(() => {
  if (savedUserToken === undefined) delete process.env.SLACK_USER_TOKEN;
  else process.env.SLACK_USER_TOKEN = savedUserToken;
  if (savedBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = savedBotToken;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("SlackClient — constructor", () => {
  it("throws AuthError when SLACK_USER_TOKEN is missing", () => {
    expect(() => new SlackClient()).toThrowError(AuthError);
  });

  it("succeeds when SLACK_USER_TOKEN is set", () => {
    process.env.SLACK_USER_TOKEN = "xoxp-test";
    expect(() => new SlackClient()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// tokenFor("bot") with no SLACK_BOT_TOKEN
// ---------------------------------------------------------------------------

describe("SlackClient — bot token missing", () => {
  it("throws AuthError naming SLACK_BOT_TOKEN when bot token is absent", async () => {
    process.env.SLACK_USER_TOKEN = "xoxp-test";
    const client = new SlackClient();
    // No msw stub — onUnhandledRequest:"error" catches a regression where the
    // HTTP call fires before the token check, proving the guard runs first.
    try {
      await client.slackCall("auth.test", {}, { token: "bot" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("SLACK_BOT_TOKEN");
    }
  });
});

// ---------------------------------------------------------------------------
// slackCall — success path
// ---------------------------------------------------------------------------

describe("SlackClient.slackCall — success", () => {
  it("sends bearer header equal to the user token and returns parsed body", async () => {
    process.env.SLACK_USER_TOKEN = "xoxp-user-token";
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.list", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C001", name: "general" }],
        });
      }),
    );
    const client = new SlackClient();
    const result = await client.slackCall<{
      ok: boolean;
      channels: Array<{ id: string; name: string }>;
    }>("conversations.list");
    expect(seenAuth).toBe("Bearer xoxp-user-token");
    expect(result.ok).toBe(true);
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).toEqual({ id: "C001", name: "general" });
  });
});

// ---------------------------------------------------------------------------
// slackCall — {ok:false} error mapping (one test per branch)
// ---------------------------------------------------------------------------

describe("SlackClient.slackCall — {ok:false} error mapping", () => {
  function stubSlackError(method: string, error: string, extra: Record<string, unknown> = {}) {
    server.use(
      http.get(`https://slack.com/api/${method}`, () =>
        HttpResponse.json({ ok: false, error, ...extra }),
      ),
    );
  }

  beforeEach(() => {
    process.env.SLACK_USER_TOKEN = "xoxp-test";
  });

  it("invalid_auth -> AuthError mentioning SLACK_USER_TOKEN/SLACK_BOT_TOKEN", async () => {
    stubSlackError("conversations.list", "invalid_auth");
    const client = new SlackClient();
    try {
      await client.slackCall("conversations.list");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("SLACK_USER_TOKEN");
    }
  });

  it("missing_scope -> AuthError whose message contains the needed scope", async () => {
    stubSlackError("conversations.list", "missing_scope", {
      needed: "channels:read",
    });
    const client = new SlackClient();
    try {
      await client.slackCall("conversations.list");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("channels:read");
    }
  });

  it("channel_not_found -> NotFoundError", async () => {
    stubSlackError("conversations.info", "channel_not_found");
    const client = new SlackClient();
    await expect(
      client.slackCall("conversations.info"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("ratelimited -> RateLimitError", async () => {
    stubSlackError("conversations.list", "ratelimited");
    const client = new SlackClient();
    await expect(
      client.slackCall("conversations.list"),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("unknown error -> UpstreamError", async () => {
    stubSlackError("conversations.list", "some_other_error");
    const client = new SlackClient();
    await expect(
      client.slackCall("conversations.list"),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});

// ---------------------------------------------------------------------------
// slackCall — POST body undefined-key dropping
// ---------------------------------------------------------------------------

describe("SlackClient.slackCall — POST undefined-key stripping", () => {
  it("omits undefined-valued keys from the JSON body but keeps defined ones", async () => {
    process.env.SLACK_USER_TOKEN = "xoxp-test";
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new SlackClient();
    await client.slackCall(
      "chat.postMessage",
      { channel: "C001", text: "hi", thread_ts: undefined },
      { http: "POST" },
    );
    expect(capturedBody).not.toBeNull();
    expect(Object.keys(capturedBody!)).not.toContain("thread_ts");
    expect(capturedBody!.channel).toBe("C001");
  });
});

// ---------------------------------------------------------------------------
// authTest
// ---------------------------------------------------------------------------

describe("SlackClient.authTest", () => {
  it("returns parsed identity body", async () => {
    process.env.SLACK_USER_TOKEN = "xoxp-user-token";
    const identity = {
      ok: true,
      url: "https://example.slack.com/",
      team: "Example",
      user: "shifat",
      team_id: "T001",
      user_id: "U001",
    };
    server.use(
      http.get("https://slack.com/api/auth.test", () =>
        HttpResponse.json(identity),
      ),
    );
    const client = new SlackClient();
    const result = await client.authTest();
    expect(result).toEqual(identity);
  });
});
