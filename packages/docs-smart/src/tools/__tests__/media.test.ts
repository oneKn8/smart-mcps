import { describe, it, expect, vi } from "vitest";
import { ValidationError } from "smart-mcp-core";
import { insertImageTool, insertPageBreakTool } from "../media.js";

function makeClient() {
  return { batchUpdate: vi.fn().mockResolvedValue({ replies: [] }) };
}
const ctx = (client: unknown) => ({ client: client as never });
function firstRequest(client: { batchUpdate: ReturnType<typeof vi.fn> }): unknown {
  return client.batchUpdate.mock.calls[0]?.[0].requests[0];
}

describe("insertImageTool", () => {
  it("inserts an inline image with size at an index", async () => {
    const client = makeClient();
    const parsed = insertImageTool.inputSchema.parse({
      document_id: "d",
      uri: "https://x/y.png",
      index: 1,
      width: 120,
      height: 80,
    }) as Parameters<typeof insertImageTool.handler>[0];
    await insertImageTool.handler(parsed, ctx(client));
    expect(firstRequest(client)).toEqual({
      insertInlineImage: {
        uri: "https://x/y.png",
        objectSize: {
          width: { magnitude: 120, unit: "PT" },
          height: { magnitude: 80, unit: "PT" },
        },
        location: { index: 1 },
      },
    });
  });

  it("rejects when neither index nor at_end is given", async () => {
    const client = makeClient();
    const parsed = insertImageTool.inputSchema.parse({
      document_id: "d",
      uri: "https://x/y.png",
    }) as Parameters<typeof insertImageTool.handler>[0];
    await expect(insertImageTool.handler(parsed, ctx(client))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("insertPageBreakTool", () => {
  it("inserts a page break at the end", async () => {
    const client = makeClient();
    const parsed = insertPageBreakTool.inputSchema.parse({
      document_id: "d",
      at_end: true,
    }) as Parameters<typeof insertPageBreakTool.handler>[0];
    await insertPageBreakTool.handler(parsed, ctx(client));
    expect(firstRequest(client)).toEqual({
      insertPageBreak: { endOfSegmentLocation: {} },
    });
  });
});
