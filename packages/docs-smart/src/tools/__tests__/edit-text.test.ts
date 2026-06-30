import { describe, it, expect, vi } from "vitest";
import { ValidationError } from "smart-mcp-core";
import {
  insertTextTool,
  appendTextTool,
  deleteRangeTool,
  replaceAllTextTool,
} from "../edit-text.js";

function makeClient(over: Record<string, unknown> = {}) {
  return {
    getDocument: vi.fn(),
    batchUpdate: vi.fn().mockResolvedValue({ replies: [] }),
    ...over,
  };
}
const ctx = (client: unknown) => ({ client: client as never });

// A doc whose body ends at index 30 and has a table starting at index 10.
const DOC = {
  body: {
    content: [
      { startIndex: 0, endIndex: 1, sectionBreak: {} },
      {
        startIndex: 1,
        endIndex: 10,
        paragraph: { elements: [{ textRun: { content: "abcdefgh\n" } }] },
      },
      { startIndex: 10, endIndex: 28, table: { tableRows: [] } },
      {
        startIndex: 28,
        endIndex: 30,
        paragraph: { elements: [{ textRun: { content: "z\n" } }] },
      },
    ],
  },
};

describe("insertTextTool", () => {
  it("rejects index 0 before any network call", async () => {
    const client = makeClient();
    const parsed = insertTextTool.inputSchema.parse({
      document_id: "d",
      text: "x",
      index: 0,
    }) as Parameters<typeof insertTextTool.handler>[0];
    await expect(insertTextTool.handler(parsed, ctx(client))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(client.getDocument).not.toHaveBeenCalled();
  });

  it("rejects inserting at a table's start index", async () => {
    const client = makeClient({ getDocument: vi.fn().mockResolvedValue(DOC) });
    const parsed = insertTextTool.inputSchema.parse({
      document_id: "d",
      text: "x",
      index: 10,
    }) as Parameters<typeof insertTextTool.handler>[0];
    await expect(insertTextTool.handler(parsed, ctx(client))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(client.batchUpdate).not.toHaveBeenCalled();
  });

  it("inserts at a valid index", async () => {
    const client = makeClient({ getDocument: vi.fn().mockResolvedValue(DOC) });
    const parsed = insertTextTool.inputSchema.parse({
      document_id: "d",
      text: "x",
      index: 3,
    }) as Parameters<typeof insertTextTool.handler>[0];
    const out = await insertTextTool.handler(parsed, ctx(client));
    expect(client.batchUpdate).toHaveBeenCalledWith({
      documentId: "d",
      requests: [{ insertText: { text: "x", location: { index: 3 } } }],
    });
    expect(out).toEqual({ document_id: "d" });
  });
});

describe("appendTextTool", () => {
  it("appends via endOfSegmentLocation with no get", async () => {
    const client = makeClient();
    const parsed = appendTextTool.inputSchema.parse({
      document_id: "d",
      text: "tail",
    }) as Parameters<typeof appendTextTool.handler>[0];
    await appendTextTool.handler(parsed, ctx(client));
    expect(client.getDocument).not.toHaveBeenCalled();
    expect(client.batchUpdate).toHaveBeenCalledWith({
      documentId: "d",
      requests: [{ insertText: { text: "tail", endOfSegmentLocation: {} } }],
    });
  });
});

describe("deleteRangeTool", () => {
  it("rejects deleting the body's final newline", async () => {
    const client = makeClient({ getDocument: vi.fn().mockResolvedValue(DOC) });
    const parsed = deleteRangeTool.inputSchema.parse({
      document_id: "d",
      start_index: 1,
      end_index: 30, // reaches body end -> would delete final newline
    }) as Parameters<typeof deleteRangeTool.handler>[0];
    await expect(deleteRangeTool.handler(parsed, ctx(client))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(client.batchUpdate).not.toHaveBeenCalled();
  });

  it("deletes a valid range", async () => {
    const client = makeClient({ getDocument: vi.fn().mockResolvedValue(DOC) });
    const parsed = deleteRangeTool.inputSchema.parse({
      document_id: "d",
      start_index: 1,
      end_index: 5,
    }) as Parameters<typeof deleteRangeTool.handler>[0];
    await deleteRangeTool.handler(parsed, ctx(client));
    expect(client.batchUpdate).toHaveBeenCalledWith({
      documentId: "d",
      requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } }],
    });
  });
});

describe("replaceAllTextTool", () => {
  it("returns occurrences_changed from the reply", async () => {
    const client = makeClient({
      batchUpdate: vi.fn().mockResolvedValue({
        replies: [{ replaceAllText: { occurrencesChanged: 4 } }],
      }),
    });
    const parsed = replaceAllTextTool.inputSchema.parse({
      document_id: "d",
      find: "{{name}}",
      replace: "Ada",
    }) as Parameters<typeof replaceAllTextTool.handler>[0];
    const out = await replaceAllTextTool.handler(parsed, ctx(client));
    expect(client.batchUpdate).toHaveBeenCalledWith({
      documentId: "d",
      requests: [
        {
          replaceAllText: {
            containsText: { text: "{{name}}", matchCase: true },
            replaceText: "Ada",
          },
        },
      ],
    });
    expect(out).toEqual({ document_id: "d", occurrences_changed: 4 });
  });

  it("defaults occurrences_changed to 0 when the reply lacks the field", async () => {
    const client = makeClient({
      batchUpdate: vi.fn().mockResolvedValue({ replies: [{}] }),
    });
    const parsed = replaceAllTextTool.inputSchema.parse({
      document_id: "d",
      find: "x",
      replace: "y",
    }) as Parameters<typeof replaceAllTextTool.handler>[0];
    const out = await replaceAllTextTool.handler(parsed, ctx(client));
    expect(out.occurrences_changed).toBe(0);
  });
});
