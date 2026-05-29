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
import { SlackClient } from "../client.js";

const BOT_TOKEN = "xoxb-test-bot-token";
const USER_TOKEN = "xoxp-test-user-token";

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
  process.env.SLACK_USER_TOKEN = USER_TOKEN;
  process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
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
// postMessage
// ---------------------------------------------------------------------------

describe("SlackClient.postMessage — bot token", () => {
  it("sends bearer header with bot token and JSON body", async () => {
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, channel: "C001", ts: "1234567890.000001", message: {} });
      }),
    );
    const client = new SlackClient();
    const result = await client.postMessage(
      { channel: "C001", text: "hello" },
      "bot",
    );
    expect(seenAuth).toBe(`Bearer ${BOT_TOKEN}`);
    expect(seenBody?.channel).toBe("C001");
    expect(seenBody?.text).toBe("hello");
    expect(result.channel).toBe("C001");
    expect(result.ts).toBe("1234567890.000001");
  });

  it("does not send undefined keys in body", async () => {
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, channel: "C001", ts: "1234567890.000002", message: {} });
      }),
    );
    const client = new SlackClient();
    await client.postMessage(
      { channel: "C001", text: "hi", thread_ts: undefined },
      "bot",
    );
    expect(seenBody).not.toHaveProperty("thread_ts");
  });
});

describe("SlackClient.postMessage — user token", () => {
  it("sends bearer header with user token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true, channel: "C001", ts: "1234567890.000003", message: {} });
      }),
    );
    const client = new SlackClient();
    await client.postMessage({ channel: "C001", text: "user post" }, "user");
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// updateMessage
// ---------------------------------------------------------------------------

describe("SlackClient.updateMessage", () => {
  it("sends POST to chat.update with bot token and correct body", async () => {
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/chat.update", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, channel: "C001", ts: "1234567890.000001" });
      }),
    );
    const client = new SlackClient();
    const result = await client.updateMessage(
      { channel: "C001", ts: "1234567890.000001", text: "updated" },
      "bot",
    );
    expect(seenAuth).toBe(`Bearer ${BOT_TOKEN}`);
    expect(seenBody?.channel).toBe("C001");
    expect(seenBody?.ts).toBe("1234567890.000001");
    expect(seenBody?.text).toBe("updated");
    expect(result.ok).toBe(true);
  });

  it("sends user token when requested", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.post("https://slack.com/api/chat.update", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true, channel: "C001", ts: "1234567890.000001" });
      }),
    );
    const client = new SlackClient();
    await client.updateMessage(
      { channel: "C001", ts: "1234567890.000001", text: "updated as user" },
      "user",
    );
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// deleteMessage
// ---------------------------------------------------------------------------

describe("SlackClient.deleteMessage", () => {
  it("sends POST to chat.delete with bot token", async () => {
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/chat.delete", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, channel: "C001", ts: "1234567890.000001" });
      }),
    );
    const client = new SlackClient();
    const result = await client.deleteMessage(
      { channel: "C001", ts: "1234567890.000001" },
      "bot",
    );
    expect(seenAuth).toBe(`Bearer ${BOT_TOKEN}`);
    expect(seenBody?.channel).toBe("C001");
    expect(seenBody?.ts).toBe("1234567890.000001");
    expect(result.ok).toBe(true);
    expect(result.ts).toBe("1234567890.000001");
  });

  it("sends user token when requested", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.post("https://slack.com/api/chat.delete", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true, channel: "C001", ts: "1234567890.000001" });
      }),
    );
    const client = new SlackClient();
    await client.deleteMessage(
      { channel: "C001", ts: "1234567890.000001" },
      "user",
    );
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// scheduleMessage
// ---------------------------------------------------------------------------

describe("SlackClient.scheduleMessage", () => {
  it("sends POST to chat.scheduleMessage with correct body and bot token", async () => {
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/chat.scheduleMessage", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ok: true,
          channel: "C001",
          scheduled_message_id: "Q123",
          post_at: 1893456000,
        });
      }),
    );
    const client = new SlackClient();
    const result = await client.scheduleMessage(
      { channel: "C001", text: "future message", post_at: 1893456000 },
      "bot",
    );
    expect(seenAuth).toBe(`Bearer ${BOT_TOKEN}`);
    expect(seenBody?.channel).toBe("C001");
    expect(seenBody?.post_at).toBe(1893456000);
    expect(seenBody?.text).toBe("future message");
    expect(result.scheduled_message_id).toBe("Q123");
    expect(result.post_at).toBe(1893456000);
  });

  it("sends user token when requested", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.post("https://slack.com/api/chat.scheduleMessage", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          channel: "C001",
          scheduled_message_id: "Q124",
          post_at: 1893456000,
        });
      }),
    );
    const client = new SlackClient();
    await client.scheduleMessage(
      { channel: "C001", text: "future", post_at: 1893456000 },
      "user",
    );
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
  });
});
