import { describe, it, expect, vi } from "vitest";
import {
  createDocFromMarkdownTool,
  buildAllTableFillRequests,
} from "../markdown-tool.js";

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
