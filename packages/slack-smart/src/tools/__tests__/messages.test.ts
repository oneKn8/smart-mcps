import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import {
  post_message,
  reply_in_thread,
  update_message,
  delete_message,
  schedule_message,
} from "../messages.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  postMessage: ReturnType<typeof vi.fn>;
  updateMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  scheduleMessage: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    postMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    scheduleMessage: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

// Standard msw-free parse helper: parse via the tool's inputSchema so defaults
// are filled in exactly as the real MCP runtime would do it.
function parse<T>(tool: { inputSchema: { parse: (v: unknown) => T } }, raw: unknown): T {
  return tool.inputSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// post_message
// ---------------------------------------------------------------------------

describe("post_message — schema defaults", () => {
  it("defaults send_as to user and confirm to false", () => {
    const parsed = parse(post_message, { channel: "C001", text: "hi" }) as {
      send_as: string;
      confirm: boolean;
    };
    expect(parsed.send_as).toBe("user");
    expect(parsed.confirm).toBe(false);
  });
});

describe("post_message — validation", () => {
  it("throws ValidationError when both text and blocks_json are absent", async () => {
    const client = makeClient();
    const input = parse(post_message, { channel: "C001" });
    await expect(post_message.handler(input, ctx(client))).rejects.toThrow(
      ValidationError,
    );
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("throws ValidationError when blocks_json is invalid JSON", async () => {
    const client = makeClient();
    const input = parse(post_message, {
      channel: "C001",
      blocks_json: "{not json",
      confirm: true,
    });
    await expect(post_message.handler(input, ctx(client))).rejects.toThrow(
      ValidationError,
    );
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("throws ValidationError when blocks_json is valid JSON but not an array", async () => {
    const client = makeClient();
    const input = parse(post_message, {
      channel: "C001",
      blocks_json: '{"type":"section"}',
      confirm: true,
    });
    await expect(post_message.handler(input, ctx(client))).rejects.toThrow(
      ValidationError,
    );
    expect(client.postMessage).not.toHaveBeenCalled();
  });
});

describe("post_message — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call postMessage", async () => {
    const input = parse(post_message, { channel: "C001", text: "hello" });
    await expect(post_message.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("calls postMessage with correct args and defaults to the user token when confirm:true", async () => {
    client.postMessage.mockResolvedValue({
      ok: true,
      channel: "C001",
      ts: "1234567890.000001",
      message: {},
    });
    const input = parse(post_message, {
      channel: "C001",
      text: "hello",
      confirm: true,
    });
    const result = (await post_message.handler(input, ctx(client))) as {
      ok: boolean;
      channel: string;
      ts: string;
    };
    expect(client.postMessage).toHaveBeenCalledTimes(1);
    const [args, token] = client.postMessage.mock.calls[0] as [Record<string, unknown>, string];
    expect(args.channel).toBe("C001");
    expect(args.text).toBe("hello");
    // Default send_as is "user" (bot app is often absent in target workspaces).
    expect(token).toBe("user");
    expect(result.ok).toBe(true);
    expect(result.channel).toBe("C001");
    expect(result.ts).toBe("1234567890.000001");
  });

  it("uses user token when send_as is user", async () => {
    client.postMessage.mockResolvedValue({
      ok: true,
      channel: "C001",
      ts: "1234567890.000002",
      message: {},
    });
    const input = parse(post_message, {
      channel: "C001",
      text: "as user",
      send_as: "user",
      confirm: true,
    });
    await post_message.handler(input, ctx(client));
    const [, token] = client.postMessage.mock.calls[0] as [unknown, string];
    expect(token).toBe("user");
  });

  it("uses bot token when send_as is explicitly bot", async () => {
    client.postMessage.mockResolvedValue({
      ok: true,
      channel: "C001",
      ts: "1234567890.000009",
      message: {},
    });
    const input = parse(post_message, {
      channel: "C001",
      text: "as bot",
      send_as: "bot",
      confirm: true,
    });
    await post_message.handler(input, ctx(client));
    const [, token] = client.postMessage.mock.calls[0] as [unknown, string];
    expect(token).toBe("bot");
  });

  it("preview shows the bot identity label when send_as is bot", async () => {
    const input = parse(post_message, {
      channel: "C001",
      text: "preview test",
      send_as: "bot",
    });
    let preview = "";
    try {
      await post_message.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("C001");
    expect(preview).toContain("the bot app");
  });

  it("preview says 'you' when send_as is user", async () => {
    const input = parse(post_message, {
      channel: "C001",
      text: "preview user",
      send_as: "user",
    });
    let preview = "";
    try {
      await post_message.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("you");
  });

  it("parses blocks_json and passes blocks array when valid", async () => {
    client.postMessage.mockResolvedValue({
      ok: true,
      channel: "C001",
      ts: "1234567890.000003",
      message: {},
    });
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
    const input = parse(post_message, {
      channel: "C001",
      blocks_json: JSON.stringify(blocks),
      confirm: true,
    });
    await post_message.handler(input, ctx(client));
    const [args] = client.postMessage.mock.calls[0] as [Record<string, unknown>, string];
    expect(args.blocks).toEqual(blocks);
  });
});

// ---------------------------------------------------------------------------
// reply_in_thread
// ---------------------------------------------------------------------------

describe("reply_in_thread — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call postMessage", async () => {
    const input = parse(reply_in_thread, {
      channel: "C001",
      thread_ts: "1234567890.000001",
      text: "reply here",
    });
    await expect(reply_in_thread.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.postMessage).not.toHaveBeenCalled();
  });

  it("calls postMessage with thread_ts when confirm:true", async () => {
    client.postMessage.mockResolvedValue({
      ok: true,
      channel: "C001",
      ts: "1234567890.000002",
      message: {},
    });
    const input = parse(reply_in_thread, {
      channel: "C001",
      thread_ts: "1234567890.000001",
      text: "reply here",
      confirm: true,
    });
    await reply_in_thread.handler(input, ctx(client));
    const [args, token] = client.postMessage.mock.calls[0] as [Record<string, unknown>, string];
    expect(args.thread_ts).toBe("1234567890.000001");
    expect(args.text).toBe("reply here");
    // Default send_as is "user".
    expect(token).toBe("user");
  });

  it("preview contains thread_ts and channel", async () => {
    const input = parse(reply_in_thread, {
      channel: "C001",
      thread_ts: "1234567890.000001",
      text: "reply",
    });
    let preview = "";
    try {
      await reply_in_thread.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("1234567890.000001");
    expect(preview).toContain("C001");
  });
});

// ---------------------------------------------------------------------------
// update_message
// ---------------------------------------------------------------------------

describe("update_message — content validation", () => {
  it("throws ValidationError when both text and blocks_json are absent, and does NOT call updateMessage", async () => {
    const client = makeClient();
    const input = parse(update_message, { channel: "C001", ts: "1234567890.000001" });
    await expect(update_message.handler(input, ctx(client))).rejects.toThrow(
      ValidationError,
    );
    expect(client.updateMessage).not.toHaveBeenCalled();
  });
});

describe("update_message — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call updateMessage", async () => {
    const input = parse(update_message, {
      channel: "C001",
      ts: "1234567890.000001",
      text: "new text",
    });
    await expect(update_message.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.updateMessage).not.toHaveBeenCalled();
  });

  it("calls updateMessage with correct args when confirm:true", async () => {
    client.updateMessage.mockResolvedValue({
      ok: true,
      channel: "C001",
      ts: "1234567890.000001",
    });
    const input = parse(update_message, {
      channel: "C001",
      ts: "1234567890.000001",
      text: "updated text",
      confirm: true,
    });
    const result = (await update_message.handler(input, ctx(client))) as {
      ok: boolean;
      channel: string;
      ts: string;
    };
    const [args, token] = client.updateMessage.mock.calls[0] as [Record<string, unknown>, string];
    expect(args.channel).toBe("C001");
    expect(args.ts).toBe("1234567890.000001");
    expect(args.text).toBe("updated text");
    // Default send_as is "user".
    expect(token).toBe("user");
    expect(result.ok).toBe(true);
  });

  it("preview contains ts and channel", async () => {
    const input = parse(update_message, {
      channel: "C001",
      ts: "1234567890.000001",
      text: "x",
    });
    let preview = "";
    try {
      await update_message.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("1234567890.000001");
    expect(preview).toContain("C001");
  });
});

// ---------------------------------------------------------------------------
// delete_message
// ---------------------------------------------------------------------------

describe("delete_message — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call deleteMessage", async () => {
    const input = parse(delete_message, {
      channel: "C001",
      ts: "1234567890.000001",
    });
    await expect(delete_message.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.deleteMessage).not.toHaveBeenCalled();
  });

  it("calls deleteMessage with correct args when confirm:true", async () => {
    client.deleteMessage.mockResolvedValue({
      ok: true,
      channel: "C001",
      ts: "1234567890.000001",
    });
    const input = parse(delete_message, {
      channel: "C001",
      ts: "1234567890.000001",
      confirm: true,
    });
    const result = (await delete_message.handler(input, ctx(client))) as {
      ok: boolean;
      channel: string;
      ts: string;
    };
    const [args, token] = client.deleteMessage.mock.calls[0] as [Record<string, unknown>, string];
    expect(args.channel).toBe("C001");
    expect(args.ts).toBe("1234567890.000001");
    // Default send_as is "user".
    expect(token).toBe("user");
    expect(result.ok).toBe(true);
    expect(result.ts).toBe("1234567890.000001");
  });

  it("uses user token when send_as is user", async () => {
    client.deleteMessage.mockResolvedValue({
      ok: true,
      channel: "C001",
      ts: "1234567890.000001",
    });
    const input = parse(delete_message, {
      channel: "C001",
      ts: "1234567890.000001",
      send_as: "user",
      confirm: true,
    });
    await delete_message.handler(input, ctx(client));
    const [, token] = client.deleteMessage.mock.calls[0] as [unknown, string];
    expect(token).toBe("user");
  });

  it("preview contains ts, channel and identity wording", async () => {
    const input = parse(delete_message, {
      channel: "C001",
      ts: "1234567890.000001",
    });
    let preview = "";
    try {
      await delete_message.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("1234567890.000001");
    expect(preview).toContain("C001");
    // default send_as = user
    expect(preview).toContain("you");
  });
});

// ---------------------------------------------------------------------------
// schedule_message
// ---------------------------------------------------------------------------

describe("schedule_message — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call scheduleMessage", async () => {
    const input = parse(schedule_message, {
      channel: "C001",
      post_at: 1893456000,
      text: "future",
    });
    await expect(schedule_message.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.scheduleMessage).not.toHaveBeenCalled();
  });

  it("calls scheduleMessage with correct args when confirm:true", async () => {
    client.scheduleMessage.mockResolvedValue({
      ok: true,
      channel: "C001",
      scheduled_message_id: "Q001",
      post_at: 1893456000,
    });
    const input = parse(schedule_message, {
      channel: "C001",
      post_at: 1893456000,
      text: "future message",
      confirm: true,
    });
    const result = (await schedule_message.handler(input, ctx(client))) as {
      ok: boolean;
      channel: string;
      scheduled_message_id: string;
      post_at: number;
    };
    const [args, token] = client.scheduleMessage.mock.calls[0] as [Record<string, unknown>, string];
    expect(args.channel).toBe("C001");
    expect(args.post_at).toBe(1893456000);
    expect(args.text).toBe("future message");
    // Default send_as is "user".
    expect(token).toBe("user");
    expect(result.scheduled_message_id).toBe("Q001");
    expect(result.post_at).toBe(1893456000);
  });

  it("preview contains channel, post_at and text snippet", async () => {
    const input = parse(schedule_message, {
      channel: "C001",
      post_at: 1893456000,
      text: "future message",
    });
    let preview = "";
    try {
      await schedule_message.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("C001");
    expect(preview).toContain("1893456000");
    expect(preview).toContain("future message");
  });

  it("defaults send_as to user", () => {
    const parsed = parse(schedule_message, {
      channel: "C001",
      post_at: 1893456000,
      text: "x",
    }) as { send_as: string };
    expect(parsed.send_as).toBe("user");
  });
});
