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

const USER_TOKEN = "xoxp-test-user-token";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedUserToken: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedUserToken = process.env.SLACK_USER_TOKEN;
  savedHome = process.env.HOME;
  process.env.SLACK_USER_TOKEN = USER_TOKEN;
  process.env.HOME = "/tmp/slack-smart-test-no-home";
});

afterEach(() => {
  if (savedUserToken === undefined) delete process.env.SLACK_USER_TOKEN;
  else process.env.SLACK_USER_TOKEN = savedUserToken;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

// ---------------------------------------------------------------------------
// searchMessages
// ---------------------------------------------------------------------------

describe("SlackClient.searchMessages", () => {
  it("sends bearer with user token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/search.messages", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          messages: { matches: [], total: 0 },
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.searchMessages({ query: "hello" });
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
  });

  it("passes query and cursor as query params", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/search.messages", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          messages: { matches: [], total: 0 },
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.searchMessages({ query: "bug report", cursor: "*" });
    expect(seenUrl).toContain("query=bug+report");
    expect(seenUrl).toContain("cursor=*");
  });

  it("parses matches array from response", async () => {
    const match = {
      ts: "1234567890.000001",
      text: "found message",
      user: "U001",
      username: "alice",
      channel: { id: "C001", name: "general" },
      permalink: "https://example.slack.com/archives/C001/p123",
    };
    server.use(
      http.get("https://slack.com/api/search.messages", () =>
        HttpResponse.json({
          ok: true,
          messages: { matches: [match], total: 1 },
          response_metadata: { next_cursor: "nextcursor" },
        }),
      ),
    );
    const client = new SlackClient();
    const result = await client.searchMessages({ query: "found" });
    expect(result.messages.matches).toHaveLength(1);
    expect(result.messages.total).toBe(1);
    expect(result.response_metadata?.next_cursor).toBe("nextcursor");
  });
});

// ---------------------------------------------------------------------------
// searchFiles
// ---------------------------------------------------------------------------

describe("SlackClient.searchFiles", () => {
  it("sends bearer with user token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/search.files", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          files: { matches: [], total: 0 },
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.searchFiles({ query: "report" });
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
  });

  it("passes query and cursor as query params", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/search.files", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          files: { matches: [], total: 0 },
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.searchFiles({ query: "design spec", cursor: "*" });
    expect(seenUrl).toContain("query=design+spec");
    expect(seenUrl).toContain("cursor=*");
  });
});

// ---------------------------------------------------------------------------
// addReaction
// ---------------------------------------------------------------------------

describe("SlackClient.addReaction", () => {
  it("sends POST to reactions.add with user token and correct body", async () => {
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/reactions.add", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new SlackClient();
    const result = await client.addReaction({
      channel: "C001",
      timestamp: "1234567890.000001",
      name: "thumbsup",
    });
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(seenBody?.channel).toBe("C001");
    expect(seenBody?.timestamp).toBe("1234567890.000001");
    expect(seenBody?.name).toBe("thumbsup");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// removeReaction
// ---------------------------------------------------------------------------

describe("SlackClient.removeReaction", () => {
  it("sends POST to reactions.remove with user token and correct body", async () => {
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post("https://slack.com/api/reactions.remove", async ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new SlackClient();
    const result = await client.removeReaction({
      channel: "C001",
      timestamp: "1234567890.000001",
      name: "thumbsup",
    });
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(seenBody?.channel).toBe("C001");
    expect(seenBody?.timestamp).toBe("1234567890.000001");
    expect(seenBody?.name).toBe("thumbsup");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getReactions
// ---------------------------------------------------------------------------

describe("SlackClient.getReactions", () => {
  it("sends GET to reactions.get with user token", async () => {
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/reactions.get", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          type: "message",
          message: {
            reactions: [
              { name: "thumbsup", count: 2, users: ["U001", "U002"] },
            ],
          },
        });
      }),
    );
    const client = new SlackClient();
    const result = await client.getReactions({
      channel: "C001",
      timestamp: "1234567890.000001",
    });
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(seenUrl).toContain("channel=C001");
    expect(seenUrl).toContain("timestamp=");
    expect(result.message?.reactions).toHaveLength(1);
    expect(result.message?.reactions?.[0]?.name).toBe("thumbsup");
  });

  it("passes full param when provided", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/reactions.get", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          type: "message",
          message: { reactions: [] },
        });
      }),
    );
    const client = new SlackClient();
    await client.getReactions({
      channel: "C001",
      timestamp: "1234567890.000001",
      full: true,
    });
    expect(seenUrl).toContain("full=true");
  });
});
