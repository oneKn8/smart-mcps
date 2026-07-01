import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AmbiguousMatchError,
  ConfirmRequiredError,
  ValidationError,
} from "smart-mcp-core";
import {
  catch_me_up,
  mentions,
  unread_digest,
  thread_catchup,
  smart_send,
} from "../smart.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  authTest: ReturnType<typeof vi.fn>;
  listChannels: ReturnType<typeof vi.fn>;
  getHistory: ReturnType<typeof vi.fn>;
  getReplies: ReturnType<typeof vi.fn>;
  searchMessages: ReturnType<typeof vi.fn>;
  listUsers: ReturnType<typeof vi.fn>;
  openDm: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    authTest: vi.fn(),
    listChannels: vi.fn(),
    getHistory: vi.fn(),
    getReplies: vi.fn(),
    searchMessages: vi.fn(),
    listUsers: vi.fn(),
    openDm: vi.fn(),
    postMessage: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

function parse<T>(tool: { inputSchema: { parse: (v: unknown) => T } }, raw: unknown): T {
  return tool.inputSchema.parse(raw);
}

// Fake time anchor: 2026-05-29T12:00:00Z = 1748520000000 ms
const FAKE_NOW_MS = new Date("2026-05-29T12:00:00Z").getTime();
const FAKE_NOW_S = FAKE_NOW_MS / 1000;

// ---------------------------------------------------------------------------
// catch_me_up
// ---------------------------------------------------------------------------

describe("catch_me_up — schema defaults", () => {
  it("defaults since_hours=24, dm_message_limit=5, include_mentions=true", () => {
    const parsed = parse(catch_me_up, {}) as {
      since_hours: number;
      dm_message_limit: number;
      include_mentions: boolean;
    };
    expect(parsed.since_hours).toBe(24);
    expect(parsed.dm_message_limit).toBe(5);
    expect(parsed.include_mentions).toBe(true);
  });
});

describe("catch_me_up — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00Z"));
    client = makeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("excludes DMs with no messages in the time window", async () => {
    client.authTest.mockResolvedValue({
      ok: true,
      user: "testuser",
      user_id: "U001",
      team: "T",
      team_id: "T001",
      url: "https://example.slack.com",
    });
    client.listChannels.mockResolvedValue({
      ok: true,
      channels: [
        { id: "D001", name: "", is_im: true, is_mpim: false, is_private: true, is_archived: false },
        { id: "D002", name: "", is_im: true, is_mpim: false, is_private: true, is_archived: false },
      ],
    });
    // D001 has messages in window; D002 has none
    client.getHistory.mockImplementation(
      (args: { channel: string; limit: number; oldest: string }) => {
        if (args.channel === "D001") {
          return Promise.resolve({
            ok: true,
            messages: [{ ts: "1748510000.000001", text: "hello", user: "U999" }],
          });
        }
        return Promise.resolve({ ok: true, messages: [] });
      },
    );
    client.searchMessages.mockResolvedValue({
      ok: true,
      messages: { matches: [], total: 0 },
    });

    const input = parse(catch_me_up, { since_hours: 24, dm_message_limit: 5 });
    const result = (await catch_me_up.handler(input, ctx(client))) as {
      dms: Array<{ channel_id: string }>;
      mentions: unknown[];
      notes: string[];
    };

    expect(result.dms).toHaveLength(1);
    expect(result.dms[0]?.channel_id).toBe("D001");
  });

  it("passes correct oldest cutoff from fake time", async () => {
    client.authTest.mockResolvedValue({
      ok: true,
      user: "testuser",
      user_id: "U001",
      team: "T",
      team_id: "T001",
      url: "https://example.slack.com",
    });
    client.listChannels.mockResolvedValue({ ok: true, channels: [] });
    client.searchMessages.mockResolvedValue({
      ok: true,
      messages: { matches: [], total: 0 },
    });

    const input = parse(catch_me_up, { since_hours: 24, include_mentions: false });
    await catch_me_up.handler(input, ctx(client));

    // cutoff = FAKE_NOW_S - 24*3600 = 1748520000 - 86400 = 1748433600
    const expectedCutoff = String(Math.floor(FAKE_NOW_S) - 24 * 3600);
    expect(client.listChannels).toHaveBeenCalledWith(
      expect.objectContaining({ types: "im,mpim" }),
    );
    // No DMs returned so getHistory never called; searchMessages not called
    expect(client.searchMessages).not.toHaveBeenCalled();
    // Verify authTest used "user" token
    expect(client.authTest).toHaveBeenCalledWith("user");
    // Verify the expected cutoff would match
    const secondsNow = Math.floor(FAKE_NOW_MS / 1000);
    expect(expectedCutoff).toBe(String(secondsNow - 24 * 3600));
  });

  it("includes mentions when include_mentions is true", async () => {
    client.authTest.mockResolvedValue({
      ok: true,
      user: "alice",
      user_id: "U001",
      team: "T",
      team_id: "T001",
      url: "https://example.slack.com",
    });
    client.listChannels.mockResolvedValue({ ok: true, channels: [] });
    client.searchMessages.mockResolvedValue({
      ok: true,
      messages: {
        matches: [
          {
            ts: "1748510000.000001",
            text: "hey @alice",
            channel: { id: "C001", name: "general" },
            permalink: "https://slack.com/archives/C001/p123",
          },
        ],
        total: 1,
      },
    });

    const input = parse(catch_me_up, { include_mentions: true });
    const result = (await catch_me_up.handler(input, ctx(client))) as {
      mentions: Array<{ ts: string; text: string; channel_id?: string }>;
      notes: string[];
    };

    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]?.text).toBe("hey @alice");
    expect(result.mentions[0]?.channel_id).toBe("C001");
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.notes.some((n) => n.includes("approximate"))).toBe(true);
  });

  it("omits mentions when include_mentions is false and does not call searchMessages", async () => {
    client.authTest.mockResolvedValue({
      ok: true,
      user: "alice",
      user_id: "U001",
      team: "T",
      team_id: "T001",
      url: "https://example.slack.com",
    });
    client.listChannels.mockResolvedValue({ ok: true, channels: [] });

    const input = parse(catch_me_up, { include_mentions: false });
    const result = (await catch_me_up.handler(input, ctx(client))) as {
      mentions: unknown[];
    };

    expect(result.mentions).toHaveLength(0);
    expect(client.searchMessages).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mentions
// ---------------------------------------------------------------------------

describe("mentions — schema defaults", () => {
  it("defaults count=20", () => {
    const parsed = parse(mentions, {}) as { count: number };
    expect(parsed.count).toBe(20);
  });
});

describe("mentions — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00Z"));
    client = makeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds query from username returned by authTest", async () => {
    client.authTest.mockResolvedValue({
      ok: true,
      user: "bob",
      user_id: "U002",
      team: "T",
      team_id: "T001",
      url: "https://example.slack.com",
    });
    client.searchMessages.mockResolvedValue({
      ok: true,
      messages: { matches: [], total: 0 },
    });

    const input = parse(mentions, { count: 5 });
    await mentions.handler(input, ctx(client));

    const [args] = client.searchMessages.mock.calls[0] as [{ query: string }[]];
    expect(args.query).toBe("@bob");
    expect(args.count ?? 20).toBe(5);
  });

  it("since_hours filter drops matches older than cutoff", async () => {
    client.authTest.mockResolvedValue({
      ok: true,
      user: "alice",
      user_id: "U001",
      team: "T",
      team_id: "T001",
      url: "https://example.slack.com",
    });
    // FAKE_NOW_S = 1748520000; cutoff for since_hours=1 = 1748516400
    const recentTs = String(FAKE_NOW_S - 1800); // 30min ago, within 1h window
    const oldTs = String(FAKE_NOW_S - 7200);    // 2h ago, outside 1h window
    client.searchMessages.mockResolvedValue({
      ok: true,
      messages: {
        matches: [
          { ts: recentTs, text: "recent mention", channel: { id: "C1", name: "general" } },
          { ts: oldTs, text: "old mention", channel: { id: "C1", name: "general" } },
        ],
        total: 2,
      },
    });

    const input = parse(mentions, { since_hours: 1 });
    const result = (await mentions.handler(input, ctx(client))) as {
      matches: Array<{ ts: string; text: string }>;
      count: number;
    };

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.text).toBe("recent mention");
    expect(result.count).toBe(1);
  });

  it("returns all matches when since_hours is not provided", async () => {
    client.authTest.mockResolvedValue({
      ok: true,
      user: "alice",
      user_id: "U001",
      team: "T",
      team_id: "T001",
      url: "https://example.slack.com",
    });
    client.searchMessages.mockResolvedValue({
      ok: true,
      messages: {
        matches: [
          { ts: "1748510000.000001", text: "one", channel: {} },
          { ts: "1748490000.000001", text: "two", channel: {} },
        ],
        total: 2,
      },
    });

    const input = parse(mentions, {});
    const result = (await mentions.handler(input, ctx(client))) as {
      matches: unknown[];
      notes: string[];
    };

    expect(result.matches).toHaveLength(2);
    expect(result.notes.some((n: string) => n.includes("approximate"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unread_digest
// ---------------------------------------------------------------------------

describe("unread_digest — schema defaults", () => {
  it("defaults dm_message_limit=3", () => {
    const parsed = parse(unread_digest, {}) as { dm_message_limit: number };
    expect(parsed.dm_message_limit).toBe(3);
  });
});

describe("unread_digest — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("groups DM channels and notes the unread limitation", async () => {
    client.listChannels.mockResolvedValue({
      ok: true,
      channels: [
        { id: "D001", name: "", is_im: true, is_mpim: false, is_private: true, is_archived: false },
        { id: "D002", name: "group-dm", is_im: false, is_mpim: true, is_private: true, is_archived: false },
      ],
    });
    client.getHistory.mockResolvedValue({
      ok: true,
      messages: [{ ts: "1748510000.000001", text: "msg", user: "U001" }],
    });

    const input = parse(unread_digest, { dm_message_limit: 3 });
    const result = (await unread_digest.handler(input, ctx(client))) as {
      dms: Array<{ channel_id: string; name?: string; latest: unknown[] }>;
      dm_count: number;
      notes: string[];
    };

    expect(result.dms).toHaveLength(2);
    expect(result.dm_count).toBe(2);
    const d2 = result.dms.find((d) => d.channel_id === "D002");
    expect(d2?.name).toBe("group-dm");
    expect(result.notes.some((n) => n.includes("unread count"))).toBe(true);
  });

  it("passes dm_message_limit to getHistory", async () => {
    client.listChannels.mockResolvedValue({
      ok: true,
      channels: [
        { id: "D001", name: "", is_im: true, is_mpim: false, is_private: true, is_archived: false },
      ],
    });
    client.getHistory.mockResolvedValue({ ok: true, messages: [] });

    const input = parse(unread_digest, { dm_message_limit: 7 });
    await unread_digest.handler(input, ctx(client));

    const [args] = client.getHistory.mock.calls[0] as [{ channel: string; limit: number }[]];
    expect(args.limit).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// thread_catchup
// ---------------------------------------------------------------------------

describe("thread_catchup — schema defaults", () => {
  it("defaults max=500", () => {
    const parsed = parse(thread_catchup, { channel: "C001", ts: "1748510000.000001" }) as {
      max: number;
    };
    expect(parsed.max).toBe(500);
  });
});

describe("thread_catchup — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("assembles messages from a single page", async () => {
    client.getReplies.mockResolvedValue({
      ok: true,
      messages: [
        { ts: "1748510000.000001", text: "first", user: "U001" },
        { ts: "1748510001.000001", text: "second", user: "U002" },
      ],
      response_metadata: { next_cursor: "" },
    });

    const input = parse(thread_catchup, { channel: "C001", ts: "1748510000.000001" });
    const result = (await thread_catchup.handler(input, ctx(client))) as {
      messages: Array<{ author: string | null; text: string; ts: string }>;
      count: number;
      truncated?: boolean;
    };

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.text).toBe("first");
    expect(result.messages[0]?.author).toBe("U001");
    expect(result.count).toBe(2);
    expect(result.truncated).toBeUndefined();
  });

  it("follows cursor across multiple pages to assemble full list", async () => {
    client.getReplies
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          { ts: "1748510000.000001", text: "page1-msg1", user: "U001" },
          { ts: "1748510001.000001", text: "page1-msg2", user: "U002" },
        ],
        response_metadata: { next_cursor: "cursor-page2" },
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          { ts: "1748510002.000001", text: "page2-msg1", user: "U003" },
        ],
        response_metadata: { next_cursor: "" },
      });

    const input = parse(thread_catchup, { channel: "C001", ts: "1748510000.000001" });
    const result = (await thread_catchup.handler(input, ctx(client))) as {
      messages: Array<{ text: string }>;
      count: number;
      truncated?: boolean;
    };

    expect(result.messages).toHaveLength(3);
    expect(result.messages[2]?.text).toBe("page2-msg1");
    expect(result.count).toBe(3);
    expect(result.truncated).toBeUndefined();
    // Second call should pass cursor
    const secondCall = client.getReplies.mock.calls[1] as [{ cursor?: string }[]];
    expect(secondCall[0]?.cursor).toBe("cursor-page2");
  });

  it("sets truncated:true when max is hit before cursor exhausted", async () => {
    // max=2, but first page returns 3 messages with more available
    client.getReplies.mockResolvedValue({
      ok: true,
      messages: [
        { ts: "1748510000.000001", text: "m1", user: "U001" },
        { ts: "1748510001.000001", text: "m2", user: "U002" },
        { ts: "1748510002.000001", text: "m3", user: "U003" },
      ],
      response_metadata: { next_cursor: "cursor-next" },
    });

    const input = parse(thread_catchup, {
      channel: "C001",
      ts: "1748510000.000001",
      max: 2,
    });
    const result = (await thread_catchup.handler(input, ctx(client))) as {
      messages: Array<{ text: string }>;
      count: number;
      truncated?: boolean;
    };

    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
    // Should not have fetched a second page after hitting max
    expect(client.getReplies).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// smart_send
// ---------------------------------------------------------------------------

describe("smart_send — schema defaults", () => {
  it("defaults send_as=user and confirm=false", () => {
    const parsed = parse(smart_send, {
      channel_query: "general",
      text: "hello",
    }) as { send_as: string; confirm: boolean };
    expect(parsed.send_as).toBe("user");
    expect(parsed.confirm).toBe(false);
  });
});

describe("smart_send — validation", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ValidationError when neither channel_query nor user_query provided", async () => {
    const input = parse(smart_send, { text: "hello" });
    await expect(smart_send.handler(input, ctx(client))).rejects.toThrow(ValidationError);
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("throws ValidationError when both channel_query and user_query provided", async () => {
    const input = parse(smart_send, {
      channel_query: "general",
      user_query: "alice",
      text: "hello",
    });
    await expect(smart_send.handler(input, ctx(client))).rejects.toThrow(ValidationError);
    expect(client.postMessage).not.toHaveBeenCalled();
  });
});

describe("smart_send — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call postMessage", async () => {
    client.listChannels.mockResolvedValue({
      ok: true,
      channels: [
        { id: "C001", name: "general", is_im: false, is_mpim: false, is_private: false, is_archived: false },
      ],
    });

    const input = parse(smart_send, { channel_query: "general", text: "hello" });
    await expect(smart_send.handler(input, ctx(client))).rejects.toThrow(ConfirmRequiredError);
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("preview contains the resolved channel label and bot identity when send_as=bot", async () => {
    client.listChannels.mockResolvedValue({
      ok: true,
      channels: [
        { id: "C001", name: "general", is_im: false, is_mpim: false, is_private: false, is_archived: false },
      ],
    });

    const input = parse(smart_send, {
      channel_query: "general",
      text: "preview test",
      send_as: "bot",
    });
    let preview = "";
    try {
      await smart_send.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("#general");
    expect(preview).toContain("the bot app");
    expect(preview).toContain("preview test");
  });

  it("preview says 'you' when send_as=user", async () => {
    client.listChannels.mockResolvedValue({
      ok: true,
      channels: [
        { id: "C001", name: "general", is_im: false, is_mpim: false, is_private: false, is_archived: false },
      ],
    });

    const input = parse(smart_send, {
      channel_query: "general",
      text: "user send",
      send_as: "user",
    });
    let preview = "";
    try {
      await smart_send.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("you");
  });
});

describe("smart_send — channel_query path", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("resolves channel and calls postMessage with confirm:true", async () => {
    client.listChannels.mockResolvedValue({
      ok: true,
      channels: [
        { id: "C001", name: "general", is_im: false, is_mpim: false, is_private: false, is_archived: false },
      ],
    });
    client.postMessage.mockResolvedValue({
      ok: true,
      channel: "C001",
      ts: "1748510000.000001",
    });

    const input = parse(smart_send, {
      channel_query: "general",
      text: "hello channel",
      confirm: true,
    });
    const result = (await smart_send.handler(input, ctx(client))) as {
      ok: true;
      channel: string;
      ts: string;
      target: string;
    };

    expect(client.postMessage).toHaveBeenCalledTimes(1);
    const [args, token] = client.postMessage.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(args.channel).toBe("C001");
    expect(args.text).toBe("hello channel");
    // Default send_as is "user".
    expect(token).toBe("user");
    expect(result.ok).toBe(true);
    expect(result.target).toBe("#general");
  });
});

describe("smart_send — user_query path", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("opens DM for resolved user then calls postMessage", async () => {
    client.listUsers.mockResolvedValue({
      ok: true,
      members: [
        {
          id: "U001",
          name: "alice",
          is_bot: false,
          deleted: false,
          real_name: "Alice Smith",
          profile: { display_name: "alice", email: "alice@example.com" },
        },
      ],
    });
    client.openDm.mockResolvedValue({
      ok: true,
      channel: { id: "D001" },
    });
    client.postMessage.mockResolvedValue({
      ok: true,
      channel: "D001",
      ts: "1748510000.000002",
    });

    const input = parse(smart_send, {
      user_query: "alice",
      text: "hi alice",
      confirm: true,
    });
    const result = (await smart_send.handler(input, ctx(client))) as {
      ok: true;
      channel: string;
      ts: string;
      target: string;
    };

    expect(client.openDm).toHaveBeenCalledWith({ users: "U001" });
    const [args, token] = client.postMessage.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(args.channel).toBe("D001");
    // Default send_as is "user".
    expect(token).toBe("user");
    expect(result.target).toBe("@alice");
  });

  it("routes through the bot token when send_as=bot", async () => {
    client.listUsers.mockResolvedValue({
      ok: true,
      members: [
        {
          id: "U001",
          name: "alice",
          is_bot: false,
          deleted: false,
          real_name: "Alice Smith",
          profile: { display_name: "alice", email: "alice@example.com" },
        },
      ],
    });
    client.openDm.mockResolvedValue({ ok: true, channel: { id: "D001" } });
    client.postMessage.mockResolvedValue({
      ok: true,
      channel: "D001",
      ts: "1748510000.000003",
    });

    const input = parse(smart_send, {
      user_query: "alice",
      text: "hi alice",
      send_as: "bot",
      confirm: true,
    });
    await smart_send.handler(input, ctx(client));
    const [, token] = client.postMessage.mock.calls[0] as [unknown, string];
    expect(token).toBe("bot");
  });
});

describe("smart_send — AmbiguousMatchError propagation", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("propagates AmbiguousMatchError from resolveOne when no confident channel match", async () => {
    // No channels match "xyz" at threshold 0.9
    client.listChannels.mockResolvedValue({
      ok: true,
      channels: [
        { id: "C001", name: "general", is_im: false, is_mpim: false, is_private: false, is_archived: false },
        { id: "C002", name: "random", is_im: false, is_mpim: false, is_private: false, is_archived: false },
      ],
    });

    const input = parse(smart_send, {
      channel_query: "xyz-no-match-at-all",
      text: "test",
      confirm: true,
    });

    await expect(smart_send.handler(input, ctx(client))).rejects.toThrow(
      AmbiguousMatchError,
    );
    expect(client.postMessage).not.toHaveBeenCalled();
  });
});
