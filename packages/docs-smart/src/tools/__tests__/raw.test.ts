import { describe, it, expect, vi } from "vitest";
import { batchUpdateTool } from "../raw.js";

function makeClient(over: Record<string, unknown> = {}) {
  return {
    batchUpdate: vi.fn().mockResolvedValue({ replies: [{}] }),
    ...over,
  };
}
const ctx = (client: unknown) => ({ client: client as never });

describe("batchUpdateTool — raw escape hatch", () => {
  it("forwards the requests array verbatim and returns replies", async () => {
    const client = makeClient({
      batchUpdate: vi.fn().mockResolvedValue({
        replies: [{ insertInlineImage: { objectId: "img1" } }],
      }),
    });
    const requests = [
      { insertText: { text: "Hi", location: { index: 1 } } },
      { updateTextStyle: { range: { startIndex: 1, endIndex: 3 }, textStyle: { bold: true }, fields: "bold" } },
    ];
    const parsed = batchUpdateTool.inputSchema.parse({
      document_id: "d",
      requests,
    }) as Parameters<typeof batchUpdateTool.handler>[0];
    const out = await batchUpdateTool.handler(parsed, ctx(client));
    expect(client.batchUpdate).toHaveBeenCalledWith({
      documentId: "d",
      requests,
    });
    expect(out).toEqual({
      document_id: "d",
      replies: [{ insertInlineImage: { objectId: "img1" } }],
    });
  });

  it("forwards write_control when supplied", async () => {
    const client = makeClient();
    const parsed = batchUpdateTool.inputSchema.parse({
      document_id: "d",
      requests: [{ insertText: { text: "x", endOfSegmentLocation: {} } }],
      write_control: { targetRevisionId: "rev_2" },
    }) as Parameters<typeof batchUpdateTool.handler>[0];
    await batchUpdateTool.handler(parsed, ctx(client));
    expect(client.batchUpdate).toHaveBeenCalledWith({
      documentId: "d",
      requests: [{ insertText: { text: "x", endOfSegmentLocation: {} } }],
      writeControl: { targetRevisionId: "rev_2" },
    });
  });

  it("schema rejects an empty requests array", () => {
    expect(() =>
      batchUpdateTool.inputSchema.parse({ document_id: "d", requests: [] }),
    ).toThrow();
  });
});
