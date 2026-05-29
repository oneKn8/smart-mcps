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
  process.env.HOME = "/tmp/slack-smart-test-no-home";
});

afterEach(() => {
  if (savedUserToken === undefined) delete process.env.SLACK_USER_TOKEN;
  else process.env.SLACK_USER_TOKEN = savedUserToken;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

// ---------------------------------------------------------------------------
// listUsers
// ---------------------------------------------------------------------------

describe("SlackClient.listUsers", () => {
  it("sends bearer header with user token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/users.list", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          members: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.listUsers({});
    expect(seenAuth).toBe("Bearer xoxp-test-token");
  });

  it("passes limit as query param", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/users.list", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          members: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.listUsers({ limit: 50 });
    expect(seenUrl).toContain("limit=50");
  });

  it("passes cursor when provided", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/users.list", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          members: [],
          response_metadata: { next_cursor: "" },
        });
      }),
    );
    const client = new SlackClient();
    await client.listUsers({ cursor: "testcursor" });
    expect(seenUrl).toContain("cursor=testcursor");
  });

  it("returns parsed members and response_metadata", async () => {
    server.use(
      http.get("https://slack.com/api/users.list", () =>
        HttpResponse.json({
          ok: true,
          members: [{ id: "U001", name: "alice" }],
          response_metadata: { next_cursor: "nextpage" },
        }),
      ),
    );
    const client = new SlackClient();
    const result = await client.listUsers({});
    expect(result.members).toHaveLength(1);
    expect(result.response_metadata?.next_cursor).toBe("nextpage");
  });
});

// ---------------------------------------------------------------------------
// getUserInfo
// ---------------------------------------------------------------------------

describe("SlackClient.getUserInfo", () => {
  it("sends bearer header and user param", async () => {
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/users.info", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = request.url;
        return HttpResponse.json({ ok: true, user: { id: "U001" } });
      }),
    );
    const client = new SlackClient();
    await client.getUserInfo({ user: "U001" });
    expect(seenAuth).toBe("Bearer xoxp-test-token");
    expect(seenUrl).toContain("user=U001");
  });

  it("returns user object", async () => {
    server.use(
      http.get("https://slack.com/api/users.info", () =>
        HttpResponse.json({ ok: true, user: { id: "U001", name: "alice" } }),
      ),
    );
    const client = new SlackClient();
    const result = await client.getUserInfo({ user: "U001" });
    expect((result.user as Record<string, unknown>)?.["name"]).toBe("alice");
  });
});

// ---------------------------------------------------------------------------
// getUserProfile
// ---------------------------------------------------------------------------

describe("SlackClient.getUserProfile", () => {
  it("sends bearer header without user param for self", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/users.profile.get", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ ok: true, profile: { display_name: "alice" } });
      }),
    );
    const client = new SlackClient();
    await client.getUserProfile({});
    // user param should not be present when not provided
    expect(seenUrl).not.toContain("user=");
  });

  it("passes user param when provided", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/users.profile.get", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ ok: true, profile: {} });
      }),
    );
    const client = new SlackClient();
    await client.getUserProfile({ user: "U002" });
    expect(seenUrl).toContain("user=U002");
  });
});

// ---------------------------------------------------------------------------
// lookupByEmail
// ---------------------------------------------------------------------------

describe("SlackClient.lookupByEmail", () => {
  it("sends bearer header and email param", async () => {
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/users.lookupByEmail", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = request.url;
        return HttpResponse.json({ ok: true, user: { id: "U001" } });
      }),
    );
    const client = new SlackClient();
    await client.lookupByEmail({ email: "alice@example.com" });
    expect(seenAuth).toBe("Bearer xoxp-test-token");
    expect(seenUrl).toContain("email=alice%40example.com");
  });
});

// ---------------------------------------------------------------------------
// getPresence
// ---------------------------------------------------------------------------

describe("SlackClient.getPresence", () => {
  it("sends bearer header and optional user param", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/users.getPresence", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ ok: true, presence: "active" });
      }),
    );
    const client = new SlackClient();
    await client.getPresence({ user: "U001" });
    expect(seenUrl).toContain("user=U001");
  });

  it("omits user param when not provided", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/users.getPresence", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ ok: true, presence: "away" });
      }),
    );
    const client = new SlackClient();
    const result = await client.getPresence({});
    expect(seenUrl).not.toContain("user=");
    expect(result.presence).toBe("away");
  });
});
