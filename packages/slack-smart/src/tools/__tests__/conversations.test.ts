import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import {
  list_channels,
  channel_history,
  thread_replies,
  channel_info,
  channel_members,
  open_dm,
  mark_read,
  invite_to_channel,
  set_channel_purpose,
  set_channel_topic,
  create_channel,
} from "../conversations.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  listChannels: ReturnType<typeof vi.fn>;
  getHistory: ReturnType<typeof vi.fn>;
  getReplies: ReturnType<typeof vi.fn>;
  getChannelInfo: ReturnType<typeof vi.fn>;
  getMembers: ReturnType<typeof vi.fn>;
  openDm: ReturnType<typeof vi.fn>;
  markConversation: ReturnType<typeof vi.fn>;
  inviteToChannel: ReturnType<typeof vi.fn>;
  setChannelPurpose: ReturnType<typeof vi.fn>;
  setChannelTopic: ReturnType<typeof vi.fn>;
  createConversation: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    listChannels: vi.fn(),
    getHistory: vi.fn(),
    getReplies: vi.fn(),
    getChannelInfo: vi.fn(),
    getMembers: vi.fn(),
    openDm: vi.fn(),
    markConversation: vi.fn(),
    inviteToChannel: vi.fn(),
    setChannelPurpose: vi.fn(),
    setChannelTopic: vi.fn(),
    createConversation: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

const publicChannelRaw = {
  id: "C001",
  name: "general",
  is_private: false,
  is_im: false,
  is_mpim: false,
  is_archived: false,
  is_member: true,
  num_members: 42,
  topic: { value: "Team updates" },
  purpose: { value: "General discussion" },
};

const imChannelRaw = {
  id: "D001",
  name: "",
  is_private: true,
  is_im: true,
  is_mpim: false,
  is_archived: false,
  user: "U999",
};

const plainMessageRaw = {
  ts: "1234567890.000001",
  type: "message",
  text: "Hello world",
  user: "U001",
};

const threadedMessageRaw = {
  ts: "1234567890.000002",
  type: "message",
  text: "Reply here",
  user: "U002",
  thread_ts: "1234567890.000001",
  reply_count: 3,
};

// ---------------------------------------------------------------------------
// list_channels
// ---------------------------------------------------------------------------

describe("list_channels — metadata", () => {
  it("has correct name and description", () => {
    expect(list_channels.name).toBe("list_channels");
    expect(list_channels.description.length).toBeGreaterThan(0);
    expect(list_channels.description.length).toBeLessThanOrEqual(120);
  });

  it("inputSchema is a ZodType instance", () => {
    expect(list_channels.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults: types='public_channel', exclude_archived=true, limit=100", () => {
    const parsed = list_channels.inputSchema.parse({}) as {
      types: string;
      exclude_archived: boolean;
      limit: number;
    };
    expect(parsed.types).toBe("public_channel");
    expect(parsed.exclude_archived).toBe(true);
    expect(parsed.limit).toBe(100);
  });
});

describe("list_channels — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("calls listChannels with defaults when no input provided", async () => {
    client.listChannels.mockResolvedValue({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const parsed = list_channels.inputSchema.parse({}) as Parameters<
      typeof list_channels.handler
    >[0];
    await list_channels.handler(parsed, ctx(client));
    expect(client.listChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        types: "public_channel",
        exclude_archived: true,
        limit: 100,
      }),
    );
  });

  it("maps channels to slim shape and strips extras", async () => {
    client.listChannels.mockResolvedValue({
      ok: true,
      channels: [{ ...publicChannelRaw, extra_field: "drop_me" }],
      response_metadata: { next_cursor: "" },
    });
    const parsed = list_channels.inputSchema.parse({}) as Parameters<
      typeof list_channels.handler
    >[0];
    const result = (await list_channels.handler(parsed, ctx(client))) as {
      channels: Record<string, unknown>[];
      count: number;
    };
    expect(result.count).toBe(1);
    expect(result.channels[0]).not.toHaveProperty("extra_field");
    expect(result.channels[0]?.id).toBe("C001");
    expect(result.channels[0]?.topic).toBe("Team updates");
  });

  it("surfaces next_cursor only when non-empty", async () => {
    client.listChannels.mockResolvedValueOnce({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "abc" },
    });
    const parsed = list_channels.inputSchema.parse({}) as Parameters<
      typeof list_channels.handler
    >[0];
    const withCursor = (await list_channels.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(withCursor).toHaveProperty("next_cursor", "abc");

    client.listChannels.mockResolvedValueOnce({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "" },
    });
    const withoutCursor = (await list_channels.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(withoutCursor).not.toHaveProperty("next_cursor");
  });
});

// ---------------------------------------------------------------------------
// channel_history
// ---------------------------------------------------------------------------

describe("channel_history — metadata", () => {
  it("has correct name and description", () => {
    expect(channel_history.name).toBe("channel_history");
    expect(channel_history.description.length).toBeGreaterThan(0);
  });

  it("defaults limit to 50", () => {
    const parsed = channel_history.inputSchema.parse({ channel: "C001" }) as {
      limit: number;
    };
    expect(parsed.limit).toBe(50);
  });
});

describe("channel_history — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("maps messages to slim shape", async () => {
    client.getHistory.mockResolvedValue({
      ok: true,
      messages: [{ ...plainMessageRaw, extra: "drop" }, threadedMessageRaw],
      has_more: false,
      response_metadata: { next_cursor: "" },
    });
    const parsed = channel_history.inputSchema.parse({ channel: "C001" }) as Parameters<
      typeof channel_history.handler
    >[0];
    const result = (await channel_history.handler(parsed, ctx(client))) as {
      messages: Record<string, unknown>[];
      count: number;
      has_more?: boolean;
    };
    expect(result.count).toBe(2);
    expect(result.messages[0]).not.toHaveProperty("extra");
    expect(result.messages[0]?.ts).toBe("1234567890.000001");
    expect(result.messages[1]?.thread_ts).toBe("1234567890.000001");
    expect(result.messages[1]?.reply_count).toBe(3);
  });

  it("surfaces has_more when present", async () => {
    client.getHistory.mockResolvedValue({
      ok: true,
      messages: [],
      has_more: true,
      response_metadata: { next_cursor: "p2" },
    });
    const parsed = channel_history.inputSchema.parse({ channel: "C001" }) as Parameters<
      typeof channel_history.handler
    >[0];
    const result = (await channel_history.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBe("p2");
  });

  it("omits has_more and next_cursor when absent / empty", async () => {
    client.getHistory.mockResolvedValue({
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    const parsed = channel_history.inputSchema.parse({ channel: "C001" }) as Parameters<
      typeof channel_history.handler
    >[0];
    const result = (await channel_history.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result).not.toHaveProperty("has_more");
    expect(result).not.toHaveProperty("next_cursor");
  });
});

// ---------------------------------------------------------------------------
// thread_replies
// ---------------------------------------------------------------------------

describe("thread_replies — handler", () => {
  it("maps all messages including parent", async () => {
    const client = makeClient();
    client.getReplies.mockResolvedValue({
      ok: true,
      messages: [plainMessageRaw, threadedMessageRaw],
      response_metadata: { next_cursor: "" },
    });
    const parsed = thread_replies.inputSchema.parse({
      channel: "C001",
      ts: "1234567890.000001",
    }) as Parameters<typeof thread_replies.handler>[0];
    const result = (await thread_replies.handler(parsed, ctx(client))) as {
      messages: unknown[];
      count: number;
    };
    expect(result.count).toBe(2);
  });

  it("omits next_cursor when empty", async () => {
    const client = makeClient();
    client.getReplies.mockResolvedValue({
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "" },
    });
    const parsed = thread_replies.inputSchema.parse({
      channel: "C001",
      ts: "1234567890.000001",
    }) as Parameters<typeof thread_replies.handler>[0];
    const result = (await thread_replies.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result).not.toHaveProperty("next_cursor");
  });
});

// ---------------------------------------------------------------------------
// channel_info
// ---------------------------------------------------------------------------

describe("channel_info — handler", () => {
  it("returns slim shape for a public channel", async () => {
    const client = makeClient();
    client.getChannelInfo.mockResolvedValue({
      ok: true,
      channel: { ...publicChannelRaw, upstream_extra: "remove" },
    });
    const parsed = channel_info.inputSchema.parse({ channel: "C001" }) as Parameters<
      typeof channel_info.handler
    >[0];
    const result = (await channel_info.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result.id).toBe("C001");
    expect(result.name).toBe("general");
    expect(result.is_private).toBe(false);
    expect(result.topic).toBe("Team updates");
    expect(result).not.toHaveProperty("upstream_extra");
  });

  it("returns slim shape for an IM (name null, user present)", async () => {
    const client = makeClient();
    client.getChannelInfo.mockResolvedValue({
      ok: true,
      channel: imChannelRaw,
    });
    const parsed = channel_info.inputSchema.parse({ channel: "D001" }) as Parameters<
      typeof channel_info.handler
    >[0];
    const result = (await channel_info.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result.id).toBe("D001");
    expect(result.name).toBeNull();
    expect(result.is_im).toBe(true);
    expect(result.user).toBe("U999");
  });
});

// ---------------------------------------------------------------------------
// channel_members
// ---------------------------------------------------------------------------

describe("channel_members — handler", () => {
  it("filters to string members only and surfaces next_cursor when non-empty", async () => {
    const client = makeClient();
    client.getMembers.mockResolvedValue({
      ok: true,
      members: ["U001", "U002", 999, null],
      response_metadata: { next_cursor: "nextmembers" },
    });
    const parsed = channel_members.inputSchema.parse({ channel: "C001" }) as Parameters<
      typeof channel_members.handler
    >[0];
    const result = (await channel_members.handler(parsed, ctx(client))) as {
      members: string[];
      count: number;
      next_cursor?: string;
    };
    expect(result.members).toEqual(["U001", "U002"]);
    expect(result.count).toBe(2);
    expect(result.next_cursor).toBe("nextmembers");
  });

  it("omits next_cursor when empty string", async () => {
    const client = makeClient();
    client.getMembers.mockResolvedValue({
      ok: true,
      members: ["U001"],
      response_metadata: { next_cursor: "" },
    });
    const parsed = channel_members.inputSchema.parse({ channel: "C001" }) as Parameters<
      typeof channel_members.handler
    >[0];
    const result = (await channel_members.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(result).not.toHaveProperty("next_cursor");
  });
});

// ---------------------------------------------------------------------------
// open_dm
// ---------------------------------------------------------------------------

describe("open_dm — metadata", () => {
  it("has correct name and description", () => {
    expect(open_dm.name).toBe("open_dm");
    expect(open_dm.description.length).toBeGreaterThan(0);
  });
});

describe("open_dm — handler", () => {
  it("returns channel_id from upstream response", async () => {
    const client = makeClient();
    client.openDm.mockResolvedValue({ ok: true, channel: { id: "D001" } });
    const parsed = open_dm.inputSchema.parse({ users: "U001,U002" }) as Parameters<
      typeof open_dm.handler
    >[0];
    const result = (await open_dm.handler(parsed, ctx(client))) as { channel_id: string };
    expect(result.channel_id).toBe("D001");
    expect(client.openDm).toHaveBeenCalledWith({ users: "U001,U002" });
  });

  it("strips any upstream extras beyond channel_id", async () => {
    const client = makeClient();
    client.openDm.mockResolvedValue({
      ok: true,
      channel: { id: "D001", name: "directmessage", is_im: true },
    });
    const parsed = open_dm.inputSchema.parse({ users: "U001" }) as Parameters<
      typeof open_dm.handler
    >[0];
    const result = (await open_dm.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["channel_id"]);
  });
});

// ---------------------------------------------------------------------------
// invite_to_channel
// ---------------------------------------------------------------------------

describe("invite_to_channel — confirm gate + handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call inviteToChannel", async () => {
    const parsed = invite_to_channel.inputSchema.parse({
      channel: "C001",
      users: "U001,U002",
    }) as Parameters<typeof invite_to_channel.handler>[0];
    await expect(invite_to_channel.handler(parsed, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.inviteToChannel).not.toHaveBeenCalled();
  });

  it("invites and returns slim channel when confirm:true", async () => {
    client.inviteToChannel.mockResolvedValue({ ok: true, channel: publicChannelRaw });
    const parsed = invite_to_channel.inputSchema.parse({
      channel: "C001",
      users: "U001,U002",
      confirm: true,
    }) as Parameters<typeof invite_to_channel.handler>[0];
    const result = (await invite_to_channel.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(client.inviteToChannel).toHaveBeenCalledWith({
      channel: "C001",
      users: "U001,U002",
    });
    expect(result.id).toBe("C001");
    expect(result).not.toHaveProperty("confirm");
  });
});

// ---------------------------------------------------------------------------
// set_channel_purpose
// ---------------------------------------------------------------------------

describe("set_channel_purpose — confirm gate + handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm", async () => {
    const parsed = set_channel_purpose.inputSchema.parse({
      channel: "C001",
      purpose: "hi",
    }) as Parameters<typeof set_channel_purpose.handler>[0];
    await expect(set_channel_purpose.handler(parsed, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.setChannelPurpose).not.toHaveBeenCalled();
  });

  it("sets purpose and echoes it when confirm:true", async () => {
    client.setChannelPurpose.mockResolvedValue({ ok: true });
    const parsed = set_channel_purpose.inputSchema.parse({
      channel: "C001",
      purpose: "Team brief",
      confirm: true,
    }) as Parameters<typeof set_channel_purpose.handler>[0];
    const result = (await set_channel_purpose.handler(parsed, ctx(client))) as {
      ok: boolean;
      purpose: string;
    };
    expect(client.setChannelPurpose).toHaveBeenCalledWith({
      channel: "C001",
      purpose: "Team brief",
    });
    expect(result.ok).toBe(true);
    expect(result.purpose).toBe("Team brief");
  });
});

// ---------------------------------------------------------------------------
// set_channel_topic
// ---------------------------------------------------------------------------

describe("set_channel_topic — confirm gate + handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm", async () => {
    const parsed = set_channel_topic.inputSchema.parse({
      channel: "C001",
      topic: "hi",
    }) as Parameters<typeof set_channel_topic.handler>[0];
    await expect(set_channel_topic.handler(parsed, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.setChannelTopic).not.toHaveBeenCalled();
  });

  it("sets topic and echoes it when confirm:true", async () => {
    client.setChannelTopic.mockResolvedValue({ ok: true });
    const parsed = set_channel_topic.inputSchema.parse({
      channel: "C001",
      topic: "Daily standup",
      confirm: true,
    }) as Parameters<typeof set_channel_topic.handler>[0];
    const result = (await set_channel_topic.handler(parsed, ctx(client))) as {
      ok: boolean;
      topic: string;
    };
    expect(result.ok).toBe(true);
    expect(result.topic).toBe("Daily standup");
  });
});

// ---------------------------------------------------------------------------
// create_channel
// ---------------------------------------------------------------------------

describe("create_channel — confirm gate + handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm", async () => {
    const parsed = create_channel.inputSchema.parse({
      name: "new-channel",
    }) as Parameters<typeof create_channel.handler>[0];
    await expect(create_channel.handler(parsed, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.createConversation).not.toHaveBeenCalled();
  });

  it("creates and returns slim channel when confirm:true", async () => {
    client.createConversation.mockResolvedValue({
      ok: true,
      channel: { ...publicChannelRaw, id: "C777", name: "new-channel" },
    });
    const parsed = create_channel.inputSchema.parse({
      name: "new-channel",
      is_private: true,
      confirm: true,
    }) as Parameters<typeof create_channel.handler>[0];
    const result = (await create_channel.handler(parsed, ctx(client))) as Record<string, unknown>;
    expect(client.createConversation).toHaveBeenCalledWith({
      name: "new-channel",
      is_private: true,
    });
    expect(result.id).toBe("C777");
    expect(result.name).toBe("new-channel");
  });
});

// ---------------------------------------------------------------------------
// mark_read
// ---------------------------------------------------------------------------

describe("mark_read", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does not mark", async () => {
    const parsed = mark_read.inputSchema.parse({
      channel: "D001",
      ts: "111.222",
    }) as Parameters<typeof mark_read.handler>[0];
    await expect(mark_read.handler(parsed, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.markConversation).not.toHaveBeenCalled();
  });

  it("marks the conversation read at an explicit ts", async () => {
    client.markConversation.mockResolvedValue({ ok: true });
    const parsed = mark_read.inputSchema.parse({
      channel: "D001",
      ts: "111.222",
      confirm: true,
    }) as Parameters<typeof mark_read.handler>[0];
    const result = (await mark_read.handler(parsed, ctx(client))) as {
      ok: boolean;
      channel: string;
      ts: string;
    };
    expect(client.markConversation).toHaveBeenCalledWith({
      channel: "D001",
      ts: "111.222",
    });
    expect(client.getHistory).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, channel: "D001", ts: "111.222" });
  });

  it("resolves the latest ts when ts is omitted", async () => {
    client.getHistory.mockResolvedValue({
      ok: true,
      messages: [{ ts: "999.111", text: "latest", user: "U1" }],
    });
    client.markConversation.mockResolvedValue({ ok: true });
    const parsed = mark_read.inputSchema.parse({
      channel: "D002",
      confirm: true,
    }) as Parameters<typeof mark_read.handler>[0];
    const result = (await mark_read.handler(parsed, ctx(client))) as {
      ts: string;
    };
    const [histArgs] = client.getHistory.mock.calls[0] as [
      { channel: string; limit: number },
    ];
    expect(histArgs).toEqual({ channel: "D002", limit: 1 });
    expect(client.markConversation).toHaveBeenCalledWith({
      channel: "D002",
      ts: "999.111",
    });
    expect(result.ts).toBe("999.111");
  });

  it("throws ValidationError when the channel has no messages", async () => {
    client.getHistory.mockResolvedValue({ ok: true, messages: [] });
    const parsed = mark_read.inputSchema.parse({
      channel: "D003",
      confirm: true,
    }) as Parameters<typeof mark_read.handler>[0];
    await expect(mark_read.handler(parsed, ctx(client))).rejects.toThrow(
      ValidationError,
    );
    expect(client.markConversation).not.toHaveBeenCalled();
  });
});
