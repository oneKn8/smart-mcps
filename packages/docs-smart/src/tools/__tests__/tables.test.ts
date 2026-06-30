import { describe, it, expect, vi } from "vitest";
import { ValidationError } from "smart-mcp-core";
import { insertTableTool, fillTableTool, buildFillRequests } from "../tables.js";

function makeClient(over: Record<string, unknown> = {}) {
  return {
    getDocument: vi.fn(),
    batchUpdate: vi.fn().mockResolvedValue({ replies: [] }),
    ...over,
  };
}
const ctx = (client: unknown) => ({ client: client as never });

// 2x2 table: cell insert indexes ascending across rows.
const DOC_WITH_TABLE = {
  body: {
    content: [
      { sectionBreak: {} },
      {
        table: {
          tableRows: [
            {
              tableCells: [
                { content: [{ startIndex: 4 }] },
                { content: [{ startIndex: 8 }] },
              ],
            },
            {
              tableCells: [
                { content: [{ startIndex: 14 }] },
                { content: [{ startIndex: 18 }] },
              ],
            },
          ],
        },
      },
    ],
  },
};

describe("insertTableTool", () => {
  it("inserts at an index", async () => {
    const client = makeClient();
    const parsed = insertTableTool.inputSchema.parse({
      document_id: "d",
      rows: 2,
      columns: 3,
      index: 1,
    }) as Parameters<typeof insertTableTool.handler>[0];
    await insertTableTool.handler(parsed, ctx(client));
    expect(client.batchUpdate).toHaveBeenCalledWith({
      documentId: "d",
      requests: [{ insertTable: { rows: 2, columns: 3, location: { index: 1 } } }],
    });
  });

  it("inserts at end when at_end is set", async () => {
    const client = makeClient();
    const parsed = insertTableTool.inputSchema.parse({
      document_id: "d",
      rows: 1,
      columns: 1,
      at_end: true,
    }) as Parameters<typeof insertTableTool.handler>[0];
    await insertTableTool.handler(parsed, ctx(client));
    expect(client.batchUpdate).toHaveBeenCalledWith({
      documentId: "d",
      requests: [{ insertTable: { rows: 1, columns: 1, endOfSegmentLocation: {} } }],
    });
  });

  it("rejects when neither index nor at_end is given", async () => {
    const client = makeClient();
    const parsed = insertTableTool.inputSchema.parse({
      document_id: "d",
      rows: 1,
      columns: 1,
    }) as Parameters<typeof insertTableTool.handler>[0];
    await expect(insertTableTool.handler(parsed, ctx(client))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("buildFillRequests — WRITE-BACKWARDS", () => {
  it("emits cell inserts in strictly descending index order", () => {
    const reqs = buildFillRequests(DOC_WITH_TABLE, 0, [
      ["A1", "B1"],
      ["A2", "B2"],
    ]);
    const indexes = reqs.map(
      (r) => (r as { insertText: { location: { index: number } } }).insertText.location.index,
    );
    // 18, 14, 8, 4 — descending so earlier (lower) cells stay valid.
    expect(indexes).toEqual([18, 14, 8, 4]);
    // and each carries the right cell text
    const texts = reqs.map((r) => (r as { insertText: { text: string } }).insertText.text);
    expect(texts).toEqual(["B2", "A2", "B1", "A1"]);
  });

  it("skips empty cells", () => {
    const reqs = buildFillRequests(DOC_WITH_TABLE, 0, [
      ["A1", ""],
      ["", "B2"],
    ]);
    expect(reqs).toHaveLength(2);
  });

  it("rejects more rows/columns than the table has", () => {
    expect(() =>
      buildFillRequests(DOC_WITH_TABLE, 0, [["a"], ["b"], ["c"]]),
    ).toThrow(ValidationError);
    expect(() =>
      buildFillRequests(DOC_WITH_TABLE, 0, [["a", "b", "c"]]),
    ).toThrow(ValidationError);
  });
});

describe("fillTableTool", () => {
  it("gets the doc then batchUpdates the fills", async () => {
    const client = makeClient({
      getDocument: vi.fn().mockResolvedValue(DOC_WITH_TABLE),
    });
    const parsed = fillTableTool.inputSchema.parse({
      document_id: "d",
      cells: [
        ["A1", "B1"],
        ["A2", "B2"],
      ],
    }) as Parameters<typeof fillTableTool.handler>[0];
    const out = await fillTableTool.handler(parsed, ctx(client));
    expect(client.getDocument).toHaveBeenCalledWith({ documentId: "d" });
    expect(client.batchUpdate).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ document_id: "d", cells_filled: 4 });
  });

  it("no-ops cleanly when all cells are empty", async () => {
    const client = makeClient({
      getDocument: vi.fn().mockResolvedValue(DOC_WITH_TABLE),
    });
    const parsed = fillTableTool.inputSchema.parse({
      document_id: "d",
      cells: [["", ""]],
    }) as Parameters<typeof fillTableTool.handler>[0];
    const out = await fillTableTool.handler(parsed, ctx(client));
    expect(client.batchUpdate).not.toHaveBeenCalled();
    expect(out).toEqual({ document_id: "d", cells_filled: 0 });
  });
});
