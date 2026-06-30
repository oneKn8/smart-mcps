import { describe, it, expect, vi } from "vitest";
import {
  createDocFromMarkdownTool,
  buildAllTableFillRequests,
} from "../markdown-tool.js";
import { buildMarkdownPlan, parseMarkdown } from "../../markdown.js";

function makeClient(over: Record<string, unknown> = {}) {
  return {
    createDocument: vi.fn().mockResolvedValue({ documentId: "doc_md", title: "T" }),
    batchUpdate: vi.fn().mockResolvedValue({ replies: [] }),
    getDocument: vi.fn(),
    ...over,
  };
}
const ctx = (client: unknown) => ({ client: client as never });

// A real (post-insert) doc with one 2x2 table whose cell indexes are known.
const DOC_WITH_TABLE = {
  body: {
    content: [
      { sectionBreak: {} },
      {
        table: {
          tableRows: [
            {
              tableCells: [
                { content: [{ startIndex: 50 }] },
                { content: [{ startIndex: 54 }] },
              ],
            },
            {
              tableCells: [
                { content: [{ startIndex: 60 }] },
                { content: [{ startIndex: 64 }] },
              ],
            },
          ],
        },
      },
    ],
  },
};

const MD = [
  "# Title",
  "",
  "Body with **bold**.",
  "",
  "- one",
  "- two",
  "",
  "| A | B |",
  "| - | - |",
  "| 1 | 2 |",
].join("\n");

describe("createDocFromMarkdownTool — orchestration", () => {
  it("metadata budget", () => {
    expect(createDocFromMarkdownTool.name).toBe("create_doc_from_markdown");
    expect(
      createDocFromMarkdownTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("runs create -> Phase A (text+styles) -> Phase B (tables) -> get -> Phase C (fills)", async () => {
    const client = makeClient({
      getDocument: vi.fn().mockResolvedValue(DOC_WITH_TABLE),
    });
    const parsed = createDocFromMarkdownTool.inputSchema.parse({
      title: "T",
      markdown: MD,
    }) as Parameters<typeof createDocFromMarkdownTool.handler>[0];

    const out = await createDocFromMarkdownTool.handler(parsed, ctx(client));

    expect(client.createDocument).toHaveBeenCalledWith({ title: "T" });
    expect(client.batchUpdate).toHaveBeenCalledTimes(3);
    expect(client.getDocument).toHaveBeenCalledTimes(1);

    // Phase A: first request is the single insertText, then styling requests.
    const phaseA = client.batchUpdate.mock.calls[0]?.[0].requests as unknown[];
    expect((phaseA[0] as { insertText?: unknown }).insertText).toBeDefined();
    const laterInserts = phaseA
      .slice(1)
      .filter((r) => (r as { insertText?: unknown }).insertText);
    expect(laterInserts).toHaveLength(0); // strategy A: no insert after the first

    // Phase B: insertTable requests only.
    const phaseB = client.batchUpdate.mock.calls[1]?.[0].requests as unknown[];
    expect(phaseB.every((r) => (r as { insertTable?: unknown }).insertTable)).toBe(true);

    // Phase C: cell fills in strictly descending index (write-backwards).
    const phaseC = client.batchUpdate.mock.calls[2]?.[0].requests as Array<{
      insertText: { location: { index: number } };
    }>;
    const indexes = phaseC.map((r) => r.insertText.location.index);
    const sortedDesc = [...indexes].sort((a, b) => b - a);
    expect(indexes).toEqual(sortedDesc);
    expect(indexes).toEqual([64, 60, 54, 50]);

    expect(out).toEqual({
      document_id: "doc_md",
      title: "T",
      url: "https://docs.google.com/document/d/doc_md/edit",
      tables_filled: 1,
    });
  });

  it("a table-free doc never calls get or a Phase B/C batch", async () => {
    const client = makeClient();
    const parsed = createDocFromMarkdownTool.inputSchema.parse({
      title: "T",
      markdown: "# Just a heading\n\nAnd a paragraph.",
    }) as Parameters<typeof createDocFromMarkdownTool.handler>[0];
    const out = await createDocFromMarkdownTool.handler(parsed, ctx(client));
    expect(client.batchUpdate).toHaveBeenCalledTimes(1); // Phase A only
    expect(client.getDocument).not.toHaveBeenCalled();
    expect(out.tables_filled).toBe(0);
  });
});

describe("buildAllTableFillRequests — multi-table write-backwards", () => {
  it("collects fills across two tables and sorts all descending", () => {
    const doc = {
      body: {
        content: [
          { sectionBreak: {} },
          {
            table: {
              tableRows: [
                { tableCells: [{ content: [{ startIndex: 10 }] }] },
              ],
            },
          },
          {
            table: {
              tableRows: [
                { tableCells: [{ content: [{ startIndex: 30 }] }] },
              ],
            },
          },
        ],
      },
    };
    const tablesAsc = [
      { insertIndex: 5, rows: 1, columns: 1, cells: [["first"]] },
      { insertIndex: 25, rows: 1, columns: 1, cells: [["second"]] },
    ];
    const reqs = buildAllTableFillRequests(doc, tablesAsc);
    const indexes = reqs.map(
      (r) => (r as { insertText: { location: { index: number } } }).insertText.location.index,
    );
    expect(indexes).toEqual([30, 10]); // descending across both tables
  });
});

// ===========================================================================
// FINDING 1 (CRITICAL): adjacent tables, end-to-end through the renderer.
// Two source tables must each receive their OWN cells in the right physical
// table — no cross-contamination, no dropped cells — and Phase B must insert
// at distinct descending indices.
// ===========================================================================

const TWO_TABLE_MD = [
  "| a | b | c |",
  "| - | - | - |",
  "| d | e | f |",
  "",
  "| x |",
  "| - |",
  "| y |",
].join("\n");

// A realistic post-Phase-B document: table#0 is 2x3, table#1 is 2x1, with
// distinct, non-overlapping cell indexes.
const DOC_WITH_TWO_TABLES = {
  body: {
    content: [
      { sectionBreak: {} },
      {
        table: {
          tableRows: [
            {
              tableCells: [
                { content: [{ startIndex: 50 }] },
                { content: [{ startIndex: 54 }] },
                { content: [{ startIndex: 58 }] },
              ],
            },
            {
              tableCells: [
                { content: [{ startIndex: 64 }] },
                { content: [{ startIndex: 68 }] },
                { content: [{ startIndex: 72 }] },
              ],
            },
          ],
        },
      },
      {
        table: {
          tableRows: [
            { tableCells: [{ content: [{ startIndex: 100 }] }] },
            { tableCells: [{ content: [{ startIndex: 106 }] }] },
          ],
        },
      },
    ],
  },
};

describe("buildAllTableFillRequests — adjacent tables route cells correctly", () => {
  it("(c) each physical table receives its OWN cells (no cross-contamination, no dropped cells)", () => {
    const plan = buildMarkdownPlan(parseMarkdown(TWO_TABLE_MD));
    const tablesAsc = [...plan.tables].sort(
      (left, right) => left.insertIndex - right.insertIndex,
    );
    const reqs = buildAllTableFillRequests(DOC_WITH_TWO_TABLES, tablesAsc);
    const fills = reqs.map((r) => {
      const ins = (r as { insertText: { text: string; location: { index: number } } })
        .insertText;
      return { index: ins.location.index, text: ins.text };
    });
    // All 8 cells present, sorted strictly descending (write-backwards), and
    // each text lands in the cell index of the correct physical table.
    expect(fills).toEqual([
      { index: 106, text: "y" }, // table#1 row1
      { index: 100, text: "x" }, // table#1 row0
      { index: 72, text: "f" }, // table#0 r1c2
      { index: 68, text: "e" }, // table#0 r1c1
      { index: 64, text: "d" }, // table#0 r1c0
      { index: 58, text: "c" }, // table#0 r0c2
      { index: 54, text: "b" }, // table#0 r0c1
      { index: 50, text: "a" }, // table#0 r0c0
    ]);
  });
});

describe("createDocFromMarkdownTool — adjacent tables orchestration", () => {
  it("Phase B inserts both tables at distinct DESCENDING indices and routes Phase C cells per table", async () => {
    const client = makeClient({
      getDocument: vi.fn().mockResolvedValue(DOC_WITH_TWO_TABLES),
    });
    const parsed = createDocFromMarkdownTool.inputSchema.parse({
      title: "T",
      markdown: TWO_TABLE_MD,
    }) as Parameters<typeof createDocFromMarkdownTool.handler>[0];

    const out = await createDocFromMarkdownTool.handler(parsed, ctx(client));

    // Phase B: two insertTable requests at distinct, strictly-descending indexes.
    const phaseB = client.batchUpdate.mock.calls[1]?.[0].requests as Array<{
      insertTable: { location: { index: number } };
    }>;
    const tableIdx = phaseB.map((r) => r.insertTable.location.index);
    expect(tableIdx).toEqual([2, 1]); // body-start + separator, written backwards
    expect(new Set(tableIdx).size).toBe(tableIdx.length); // distinct

    // Phase C: 8 cell fills, all present, strictly descending.
    const phaseC = client.batchUpdate.mock.calls[2]?.[0].requests as Array<{
      insertText: { text: string; location: { index: number } };
    }>;
    expect(phaseC).toHaveLength(8);
    const idxs = phaseC.map((r) => r.insertText.location.index);
    expect(idxs).toEqual([...idxs].sort((a, b) => b - a));

    expect(out.tables_filled).toBe(2);
  });
});

// ===========================================================================
// FINDING 2 (LOW): tables_filled must count tables INSERTED (Phase B), not
// just tables whose cells happened to carry text. An all-empty-cell table
// inserts a grid but produces zero cell fills.
// ===========================================================================

const EMPTY_CELL_TABLE_DOC = {
  body: {
    content: [
      { sectionBreak: {} },
      {
        table: {
          tableRows: [
            {
              tableCells: [
                { content: [{ startIndex: 20 }] },
                { content: [{ startIndex: 24 }] },
              ],
            },
          ],
        },
      },
    ],
  },
};

describe("createDocFromMarkdownTool — tables_filled counts inserted tables", () => {
  it("reports the inserted-table count for an all-empty-cell table (grid inserted, no cell text)", async () => {
    const client = makeClient({
      getDocument: vi.fn().mockResolvedValue(EMPTY_CELL_TABLE_DOC),
    });
    // A 1x2 table whose cells are both empty -> Phase B inserts the grid,
    // Phase C produces zero fills.
    const md = ["|  |  |", "| - | - |"].join("\n");
    const parsed = createDocFromMarkdownTool.inputSchema.parse({
      title: "T",
      markdown: md,
    }) as Parameters<typeof createDocFromMarkdownTool.handler>[0];

    const out = await createDocFromMarkdownTool.handler(parsed, ctx(client));

    // No Phase C fill batch should be sent (no non-empty cells), but the table
    // WAS inserted, so the count is 1 — not 0.
    expect(out.tables_filled).toBe(1);
  });
});
