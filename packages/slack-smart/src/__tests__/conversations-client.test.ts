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

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedUserToken: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedUserToken = process.env.SLACK_USER_TOKEN;
  savedHome = process.env.HOME;
  process.env.SLACK_USER_TOKEN = "xoxp-test-token";
  // Point HOME at a non-existent directory so the shared ~/.config/smart-mcps/.env
  // fallback in loadCreds does not leak real-machine credentials into tests.
  process.env.HOME = "/tmp/slack-smart-test-no-home";
});

afterEach(() => {
  if (savedUserToken === undefined) delete process.env.SLACK_USER_TOKEN;
  else process.env.SLACK_USER_TOKEN = savedUserToken;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

// ---------------------------------------------------------------------------
// listChannels
// ---------------------------------------------------------------------------

describe("SlackClient.listChannels", () => {
  it("sends bearer header with user token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.list", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C001", name: "general" }],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.listChannels({});
    expect(seenAuth).toBe("Bearer xoxp-test-token");
  });

  it("passes types and exclude_archived as query params", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.list", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.listChannels({ types: "private_channel", exclude_archived: true, limit: 50 });
    expect(seenUrl).toContain("types=private_channel");
    expect(seenUrl).toContain("exclude_archived=true");
    expect(seenUrl).toContain("limit=50");
  });

  it("passes cursor when provided", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.list", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          channels: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.listChannels({ cursor: "abc123" });
    expect(seenUrl).toContain("cursor=abc123");
  });

  it("returns parsed channels and response_metadata", async () => {
    server.use(
      http.get("https://slack.com/api/conversations.list", () =>
        HttpResponse.json({
          ok: true,
          channels: [{ id: "C001", name: "general" }],
          response_metadata: { next_cursor: "nextpage" },
        }),
      ),
    );
    const client = new SlackClient();
    const result = await client.listChannels({});
    expect(result.channels).toHaveLength(1);
    expect(result.response_metadata?.next_cursor).toBe("nextpage");
  });
});

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

describe("SlackClient.getHistory", () => {
  it("sends bearer header and includes channel param", async () => {
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.history", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          messages: [],
          has_more: false,
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.getHistory({ channel: "C001" });
    expect(seenAuth).toBe("Bearer xoxp-test-token");
    expect(seenUrl).toContain("channel=C001");
  });

  it("passes optional params oldest, latest, inclusive", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.history", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          messages: [],
          has_more: false,
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.getHistory({
      channel: "C001",
      oldest: "1234567890.000001",
      latest: "1234567899.000001",
      inclusive: true,
    });
    expect(seenUrl).toContain("oldest=");
    expect(seenUrl).toContain("latest=");
    expect(seenUrl).toContain("inclusive=true");
  });

  it("cursor passthrough: sends cursor and returns next_cursor", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.history", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          messages: [],
          has_more: true,
          response_metadata: { next_cursor: "page2cursor" },
        });
      }),
    );
    const client = new SlackClient();
    const result = await client.getHistory({ channel: "C001", cursor: "page1cursor" });
    expect(seenUrl).toContain("cursor=page1cursor");
    expect(result.response_metadata?.next_cursor).toBe("page2cursor");
  });
});

// ---------------------------------------------------------------------------
// getReplies
// ---------------------------------------------------------------------------

describe("SlackClient.getReplies", () => {
  it("includes channel and ts params", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.replies", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          messages: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.getReplies({ channel: "C001", ts: "1234567890.000001" });
    expect(seenUrl).toContain("channel=C001");
    expect(seenUrl).toContain("ts=");
  });

  it("cursor passthrough", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.replies", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          messages: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.getReplies({ channel: "C001", ts: "1234567890.000001", cursor: "replycursor" });
    expect(seenUrl).toContain("cursor=replycursor");
  });
});

// ---------------------------------------------------------------------------
// getChannelInfo
// ---------------------------------------------------------------------------

describe("SlackClient.getChannelInfo", () => {
  it("includes channel param and returns channel object", async () => {
    let seenUrl: string | null = null;
    const channelData = { id: "C001", name: "general", is_private: false };
    server.use(
      http.get("https://slack.com/api/conversations.info", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ ok: true, channel: channelData });
      }),
    );
    const client = new SlackClient();
    const result = await client.getChannelInfo({ channel: "C001" });
    expect(seenUrl).toContain("channel=C001");
    expect(result.channel).toEqual(channelData);
  });
});

// ---------------------------------------------------------------------------
// getMembers
// ---------------------------------------------------------------------------

describe("SlackClient.getMembers", () => {
  it("includes channel param and returns members array", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.members", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          members: ["U001", "U002"],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    const result = await client.getMembers({ channel: "C001" });
    expect(seenUrl).toContain("channel=C001");
    expect(result.members).toEqual(["U001", "U002"]);
  });

  it("cursor passthrough", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/conversations.members", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          members: [],
          response_metadata: { next_cursor: "membercursor2" },
        });
      }),
    );
    const client = new SlackClient();
    const result = await client.getMembers({ channel: "C001", cursor: "membercursor1" });
    expect(seenUrl).toContain("cursor=membercursor1");
    expect(result.response_metadata?.next_cursor).toBe("membercursor2");
  });
});

// ---------------------------------------------------------------------------
// openDm (POST)
// ---------------------------------------------------------------------------

describe("SlackClient.openDm", () => {
  it("uses POST method and includes users in body", async () => {
    let seenMethod: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    let seenAuth: string | null = null;
    server.use(
      http.post("https://slack.com/api/conversations.open", async ({ request }) => {
        seenMethod = request.method;
        seenAuth = request.headers.get("authorization");
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, channel: { id: "D001" } });
      }),
    );
    const client = new SlackClient();
    const result = await client.openDm({ users: "U001,U002" });
    expect(seenMethod).toBe("POST");
    expect(seenAuth).toBe("Bearer xoxp-test-token");
    expect(seenBody?.users).toBe("U001,U002");
    expect(result.channel.id).toBe("D001");
  });
});

describe("SlackClient.markConversation", () => {
  it("POSTs to conversations.mark with channel + ts and the user token", async () => {
    let seenBody: Record<string, unknown> | null = null;
    let seenAuth: string | null = null;
    server.use(
      http.post(
        "https://slack.com/api/conversations.mark",
        async ({ request }) => {
          seenAuth = request.headers.get("authorization");
          seenBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ ok: true });
        },
      ),
    );
    const client = new SlackClient();
    const result = await client.markConversation({
      channel: "D001",
      ts: "111.222",
    });
    expect(seenAuth).toBe("Bearer xoxp-test-token");
    expect(seenBody?.["channel"]).toBe("D001");
    expect(seenBody?.["ts"]).toBe("111.222");
    expect(result.ok).toBe(true);
  });
});
