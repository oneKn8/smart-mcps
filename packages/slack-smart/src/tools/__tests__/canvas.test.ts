import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfirmRequiredError } from "smart-mcp-core";
import { create_canvas, update_canvas } from "../canvas.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  createCanvas: ReturnType<typeof vi.fn>;
  editCanvas: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    createCanvas: vi.fn(),
    editCanvas: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

// ---------------------------------------------------------------------------
// create_canvas
// ---------------------------------------------------------------------------

describe("create_canvas — confirm gate + handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call createCanvas", async () => {
    const parsed = create_canvas.inputSchema.parse({ title: "Notes" }) as Parameters<
      typeof create_canvas.handler
    >[0];
    await expect(create_canvas.handler(parsed, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.createCanvas).not.toHaveBeenCalled();
  });

  it("creates a canvas and returns canvas_id when confirm:true", async () => {
    client.createCanvas.mockResolvedValue({ ok: true, canvas_id: "F123" });
    const parsed = create_canvas.inputSchema.parse({
      title: "Notes",
      markdown: "# Hello",
      confirm: true,
    }) as Parameters<typeof create_canvas.handler>[0];
    const result = (await create_canvas.handler(parsed, ctx(client))) as {
      ok: boolean;
      canvas_id: string;
    };
    expect(client.createCanvas).toHaveBeenCalledWith({
      title: "Notes",
      markdown: "# Hello",
    });
    expect(result.ok).toBe(true);
    expect(result.canvas_id).toBe("F123");
  });

  it("omits undefined optionals when calling createCanvas", async () => {
    client.createCanvas.mockResolvedValue({ ok: true, canvas_id: "F1" });
    const parsed = create_canvas.inputSchema.parse({ confirm: true }) as Parameters<
      typeof create_canvas.handler
    >[0];
    await create_canvas.handler(parsed, ctx(client));
    const [args] = client.createCanvas.mock.calls[0] as [Record<string, unknown>];
    expect(args).not.toHaveProperty("title");
    expect(args).not.toHaveProperty("markdown");
    expect(args).not.toHaveProperty("channel_id");
  });
});

// ---------------------------------------------------------------------------
// update_canvas
// ---------------------------------------------------------------------------

describe("update_canvas — confirm gate + handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT call editCanvas", async () => {
    const parsed = update_canvas.inputSchema.parse({
      canvas_id: "F123",
      changes: [{ operation: "insert_at_end", markdown: "more" }],
    }) as Parameters<typeof update_canvas.handler>[0];
    await expect(update_canvas.handler(parsed, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.editCanvas).not.toHaveBeenCalled();
  });

  it("wraps markdown into document_content and forwards changes when confirm:true", async () => {
    client.editCanvas.mockResolvedValue({ ok: true });
    const parsed = update_canvas.inputSchema.parse({
      canvas_id: "F123",
      changes: [
        { operation: "insert_at_end", markdown: "more text" },
        { operation: "delete", section_id: "sec_1" },
      ],
      confirm: true,
    }) as Parameters<typeof update_canvas.handler>[0];
    const result = (await update_canvas.handler(parsed, ctx(client))) as { ok: boolean };
    expect(result.ok).toBe(true);
    const [args] = client.editCanvas.mock.calls[0] as [
      { canvas_id: string; changes: Array<Record<string, unknown>> },
    ];
    expect(args.canvas_id).toBe("F123");
    expect(args.changes[0]).toEqual({
      operation: "insert_at_end",
      document_content: { type: "markdown", markdown: "more text" },
    });
    expect(args.changes[1]).toEqual({ operation: "delete", section_id: "sec_1" });
  });

  it("rejects an empty changes array at schema parse", () => {
    expect(() =>
      update_canvas.inputSchema.parse({ canvas_id: "F1", changes: [], confirm: true }),
    ).toThrow();
  });
});
