import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfirmRequiredError } from "smart-mcp-core";
import { add_reaction, remove_reaction, get_reactions } from "../reactions.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  addReaction: ReturnType<typeof vi.fn>;
  removeReaction: ReturnType<typeof vi.fn>;
  getReactions: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    getReactions: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

function parse<T>(tool: { inputSchema: { parse: (v: unknown) => T } }, raw: unknown): T {
  return tool.inputSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// add_reaction
// ---------------------------------------------------------------------------

describe("add_reaction — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call addReaction", async () => {
    const input = parse(add_reaction, {
      channel: "C001",
      timestamp: "1234567890.000001",
      name: "thumbsup",
    });
    await expect(add_reaction.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.addReaction).not.toHaveBeenCalled();
  });

  it("calls addReaction with correct args when confirm:true", async () => {
    client.addReaction.mockResolvedValue({ ok: true });
    const input = parse(add_reaction, {
      channel: "C001",
      timestamp: "1234567890.000001",
      name: "thumbsup",
      confirm: true,
    });
    const result = (await add_reaction.handler(input, ctx(client))) as { ok: boolean };
    expect(client.addReaction).toHaveBeenCalledTimes(1);
    const [args] = client.addReaction.mock.calls[0] as [Record<string, unknown>];
    expect(args.channel).toBe("C001");
    expect(args.timestamp).toBe("1234567890.000001");
    expect(args.name).toBe("thumbsup");
    expect(result.ok).toBe(true);
  });

  it("preview contains name, timestamp and channel", async () => {
    const input = parse(add_reaction, {
      channel: "C001",
      timestamp: "1234567890.000001",
      name: "rocket",
    });
    let preview = "";
    try {
      await add_reaction.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("rocket");
    expect(preview).toContain("1234567890.000001");
    expect(preview).toContain("C001");
  });
});

// ---------------------------------------------------------------------------
// remove_reaction
// ---------------------------------------------------------------------------

describe("remove_reaction — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call removeReaction", async () => {
    const input = parse(remove_reaction, {
      channel: "C001",
      timestamp: "1234567890.000001",
      name: "thumbsup",
    });
    await expect(remove_reaction.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.removeReaction).not.toHaveBeenCalled();
  });

  it("calls removeReaction with correct args when confirm:true", async () => {
    client.removeReaction.mockResolvedValue({ ok: true });
    const input = parse(remove_reaction, {
      channel: "C001",
      timestamp: "1234567890.000001",
      name: "thumbsup",
      confirm: true,
    });
    const result = (await remove_reaction.handler(input, ctx(client))) as { ok: boolean };
    expect(client.removeReaction).toHaveBeenCalledTimes(1);
    const [args] = client.removeReaction.mock.calls[0] as [Record<string, unknown>];
    expect(args.channel).toBe("C001");
    expect(args.timestamp).toBe("1234567890.000001");
    expect(args.name).toBe("thumbsup");
    expect(result.ok).toBe(true);
  });

  it("preview contains name, timestamp and channel", async () => {
    const input = parse(remove_reaction, {
      channel: "C001",
      timestamp: "1234567890.000001",
      name: "wave",
    });
    let preview = "";
    try {
      await remove_reaction.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("wave");
    expect(preview).toContain("1234567890.000001");
    expect(preview).toContain("C001");
  });
});

// ---------------------------------------------------------------------------
// get_reactions
// ---------------------------------------------------------------------------

describe("get_reactions — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("returns slim reactions from message.reactions", async () => {
    client.getReactions.mockResolvedValue({
      ok: true,
      type: "message",
      message: {
        reactions: [
          { name: "thumbsup", count: 3, users: ["U001", "U002", "U003"] },
          { name: "wave", count: 1, users: ["U004"] },
        ],
      },
    });
    const input = parse(get_reactions, {
      channel: "C001",
      timestamp: "1234567890.000001",
    });
    const result = (await get_reactions.handler(input, ctx(client))) as {
      reactions: Array<{ name: string; count: number; users?: string[] }>;
    };
    expect(result.reactions).toHaveLength(2);
    expect(result.reactions[0]?.name).toBe("thumbsup");
    expect(result.reactions[0]?.count).toBe(3);
    expect(result.reactions[0]?.users).toEqual(["U001", "U002", "U003"]);
    expect(result.reactions[1]?.name).toBe("wave");
  });

  it("returns empty reactions array when message.reactions is absent", async () => {
    client.getReactions.mockResolvedValue({
      ok: true,
      type: "message",
      message: {},
    });
    const input = parse(get_reactions, {
      channel: "C001",
      timestamp: "1234567890.000001",
    });
    const result = (await get_reactions.handler(input, ctx(client))) as {
      reactions: unknown[];
    };
    expect(result.reactions).toEqual([]);
  });

  it("returns empty reactions array when message is absent", async () => {
    client.getReactions.mockResolvedValue({
      ok: true,
      type: "message",
    });
    const input = parse(get_reactions, {
      channel: "C001",
      timestamp: "1234567890.000001",
    });
    const result = (await get_reactions.handler(input, ctx(client))) as {
      reactions: unknown[];
    };
    expect(result.reactions).toEqual([]);
  });

  it("omits users field when reactions array is empty", async () => {
    client.getReactions.mockResolvedValue({
      ok: true,
      type: "message",
      message: {
        reactions: [{ name: "fire", count: 1, users: [] }],
      },
    });
    const input = parse(get_reactions, {
      channel: "C001",
      timestamp: "1234567890.000001",
    });
    const result = (await get_reactions.handler(input, ctx(client))) as {
      reactions: Record<string, unknown>[];
    };
    // users array is empty — should be omitted per mapReaction logic
    expect(result.reactions[0]).not.toHaveProperty("users");
  });

  it("passes full param to client when provided", async () => {
    client.getReactions.mockResolvedValue({
      ok: true,
      type: "message",
      message: { reactions: [] },
    });
    const input = parse(get_reactions, {
      channel: "C001",
      timestamp: "1234567890.000001",
      full: true,
    });
    await get_reactions.handler(input, ctx(client));
    const [args] = client.getReactions.mock.calls[0] as [Record<string, unknown>];
    expect(args.full).toBe(true);
  });
});
