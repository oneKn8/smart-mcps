import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfirmRequiredError } from "smart-mcp-core";
import { list_pins, pin_message, unpin_message } from "../pins.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  listPins: ReturnType<typeof vi.fn>;
  addPin: ReturnType<typeof vi.fn>;
  removePin: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    listPins: vi.fn(),
    addPin: vi.fn(),
    removePin: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

function parse<T>(tool: { inputSchema: { parse: (v: unknown) => T } }, raw: unknown): T {
  return tool.inputSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// list_pins
// ---------------------------------------------------------------------------

describe("list_pins — message and file item mapping", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("maps message-type items extracting ts, text, user", async () => {
    client.listPins.mockResolvedValue({
      ok: true,
      items: [
        {
          type: "message",
          message: { ts: "111.0", text: "hello", user: "U001" },
        },
      ],
    });
    const input = parse(list_pins, { channel: "C001" });
    const result = (await list_pins.handler(input, ctx(client))) as {
      items: Array<Record<string, unknown>>;
      count: number;
    };
    expect(result.count).toBe(1);
    expect(result.items[0]?.type).toBe("message");
    expect(result.items[0]?.ts).toBe("111.0");
    expect(result.items[0]?.text).toBe("hello");
    expect(result.items[0]?.user).toBe("U001");
    expect(result.items[0]).not.toHaveProperty("file_id");
  });

  it("maps file-type items extracting file_id", async () => {
    client.listPins.mockResolvedValue({
      ok: true,
      items: [
        {
          type: "file",
          file: { id: "F001", name: "design.png" },
        },
      ],
    });
    const input = parse(list_pins, { channel: "C001" });
    const result = (await list_pins.handler(input, ctx(client))) as {
      items: Array<Record<string, unknown>>;
      count: number;
    };
    expect(result.count).toBe(1);
    expect(result.items[0]?.type).toBe("file");
    expect(result.items[0]?.file_id).toBe("F001");
    expect(result.items[0]).not.toHaveProperty("ts");
    expect(result.items[0]).not.toHaveProperty("text");
  });

  it("handles mixed message and file items", async () => {
    client.listPins.mockResolvedValue({
      ok: true,
      items: [
        { type: "message", message: { ts: "111.0", text: "msg", user: "U001" } },
        { type: "file", file: { id: "F002", name: "x.pdf" } },
      ],
    });
    const input = parse(list_pins, { channel: "C001" });
    const result = (await list_pins.handler(input, ctx(client))) as {
      items: Array<Record<string, unknown>>;
      count: number;
    };
    expect(result.count).toBe(2);
    expect(result.items[0]?.type).toBe("message");
    expect(result.items[1]?.type).toBe("file");
    expect(result.items[1]?.file_id).toBe("F002");
  });

  it("returns count 0 for empty items array", async () => {
    client.listPins.mockResolvedValue({ ok: true, items: [] });
    const input = parse(list_pins, { channel: "C001" });
    const result = (await list_pins.handler(input, ctx(client))) as {
      items: unknown[];
      count: number;
    };
    expect(result.count).toBe(0);
    expect(result.items).toEqual([]);
  });

  it("calls listPins with channel arg", async () => {
    client.listPins.mockResolvedValue({ ok: true, items: [] });
    const input = parse(list_pins, { channel: "C999" });
    await list_pins.handler(input, ctx(client));
    const [args] = client.listPins.mock.calls[0] as [Record<string, unknown>];
    expect(args.channel).toBe("C999");
  });
});

// ---------------------------------------------------------------------------
// pin_message
// ---------------------------------------------------------------------------

describe("pin_message — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call addPin", async () => {
    const input = parse(pin_message, { channel: "C001", timestamp: "111.0" });
    await expect(pin_message.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.addPin).not.toHaveBeenCalled();
  });

  it("calls addPin with correct args when confirm:true", async () => {
    client.addPin.mockResolvedValue({ ok: true });
    const input = parse(pin_message, {
      channel: "C001",
      timestamp: "111.0",
      confirm: true,
    });
    const result = (await pin_message.handler(input, ctx(client))) as { ok: boolean };
    expect(client.addPin).toHaveBeenCalledTimes(1);
    const [args] = client.addPin.mock.calls[0] as [Record<string, unknown>];
    expect(args.channel).toBe("C001");
    expect(args.timestamp).toBe("111.0");
    expect(result.ok).toBe(true);
  });

  it("preview contains timestamp and channel", async () => {
    const input = parse(pin_message, { channel: "C001", timestamp: "111.0" });
    let preview = "";
    try {
      await pin_message.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("111.0");
    expect(preview).toContain("C001");
  });
});

// ---------------------------------------------------------------------------
// unpin_message
// ---------------------------------------------------------------------------

describe("unpin_message — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call removePin", async () => {
    const input = parse(unpin_message, { channel: "C001", timestamp: "222.0" });
    await expect(unpin_message.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.removePin).not.toHaveBeenCalled();
  });

  it("calls removePin with correct args when confirm:true", async () => {
    client.removePin.mockResolvedValue({ ok: true });
    const input = parse(unpin_message, {
      channel: "C001",
      timestamp: "222.0",
      confirm: true,
    });
    const result = (await unpin_message.handler(input, ctx(client))) as { ok: boolean };
    expect(client.removePin).toHaveBeenCalledTimes(1);
    const [args] = client.removePin.mock.calls[0] as [Record<string, unknown>];
    expect(args.channel).toBe("C001");
    expect(args.timestamp).toBe("222.0");
    expect(result.ok).toBe(true);
  });

  it("preview contains timestamp and channel", async () => {
    const input = parse(unpin_message, { channel: "C001", timestamp: "222.0" });
    let preview = "";
    try {
      await unpin_message.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("222.0");
    expect(preview).toContain("C001");
  });
});
