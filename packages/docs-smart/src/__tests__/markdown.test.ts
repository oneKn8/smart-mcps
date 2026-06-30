import { describe, it, expect } from "vitest";
import {
  assertDistinctTableInsertIndices,
  buildMarkdownPlan,
  parseInline,
  parseMarkdown,
  tablesWriteBackwards,
  type Block,
} from "../markdown.js";
import { BODY_START_INDEX } from "../request-builders.js";
import { ValidationError } from "smart-mcp-core";
import { readDocumentText } from "../doc-mapper.js";

// ===========================================================================
// Inline parser
// ===========================================================================

describe("parseInline", () => {
  it("plain text -> single span", () => {
    expect(parseInline("hello")).toEqual([{ text: "hello" }]);
  });
  it("bold via ** **", () => {
    expect(parseInline("a **b** c")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " c" },
    ]);
  });
  it("italic via * *", () => {
    expect(parseInline("a *b* c")).toEqual([
      { text: "a " },
      { text: "b", italic: true },
      { text: " c" },
    ]);
  });
  it("inline code via backticks", () => {
    expect(parseInline("run `npm test` now")).toEqual([
      { text: "run " },
      { text: "npm test", code: true },
      { text: " now" },
    ]);
  });
  it("bold is matched before italic so **x** is not mis-parsed", () => {
    expect(parseInline("**x**")).toEqual([{ text: "x", bold: true }]);
  });
  it("unmatched marker falls through as literal text", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ text: "2 * 3 = 6" }]);
  });
});

// ===========================================================================
// Inline parser — CommonMark backslash escapes (injection hardening)
//
// A backslash before an ASCII PUNCTUATION char renders that char literally and
// suppresses any formatting it would trigger, consuming the backslash. A
// backslash before a non-punctuation char (or at end-of-string) stays literal.
// This is what makes flow-smart's `mdInline` escaping effective at render time.
// ===========================================================================

describe("parseInline — backslash escapes (CommonMark)", () => {
  it("escaped asterisks render literally and suppress italic", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([
      { text: "*not italic*" },
    ]);
  });

  it("escaped backticks render literally and suppress code", () => {
    expect(parseInline("\\`not code\\`")).toEqual([{ text: "`not code`" }]);
  });

  it("escaped underscores render literally and suppress italic", () => {
    expect(parseInline("\\_x\\_")).toEqual([{ text: "_x_" }]);
  });

  it("escaped hash renders literally", () => {
    expect(parseInline("\\# x")).toEqual([{ text: "# x" }]);
  });

  it("escaped pipe renders literally", () => {
    expect(parseInline("a \\| b")).toEqual([{ text: "a | b" }]);
  });

  it("escaped bracket renders literally", () => {
    expect(parseInline("\\[link]")).toEqual([{ text: "[link]" }]);
  });

  it("escaped dash renders literally", () => {
    expect(parseInline("\\- item")).toEqual([{ text: "- item" }]);
  });

  it("a double backslash collapses to one literal backslash", () => {
    expect(parseInline("\\\\")).toEqual([{ text: "\\" }]);
  });

  it("backslash before a letter is preserved (e.g. a Windows path)", () => {
    expect(parseInline("C:\\Users")).toEqual([{ text: "C:\\Users" }]);
  });

  it("backslash before a digit is preserved", () => {
    expect(parseInline("100\\200")).toEqual([{ text: "100\\200" }]);
  });

  it("a trailing backslash is preserved", () => {
    expect(parseInline("end\\")).toEqual([{ text: "end\\" }]);
  });

  it("mixed line: escaped markers stay literal, real markers still format", () => {
    expect(parseInline("\\*not\\* but **yes**")).toEqual([
      { text: "*not* but " },
      { text: "yes", bold: true },
    ]);
  });

  it("an escaped marker cannot close an emphasis run", () => {
    expect(parseInline("*a \\* b*")).toEqual([
      { text: "a * b", italic: true },
    ]);
  });
});

// ===========================================================================
// Block parser
// ===========================================================================

describe("parseMarkdown — blocks", () => {
  it("headings of each level", () => {
    const blocks = parseMarkdown("# Title\n\n### Sub");
    expect(blocks).toEqual([
      { type: "heading", level: 1, spans: [{ text: "Title" }] },
      { type: "heading", level: 3, spans: [{ text: "Sub" }] },
    ]);
  });

  it("paragraph joins wrapped lines", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks[0]).toEqual({
      type: "paragraph",
      spans: [{ text: "one" }, { text: " " }, { text: "two" }],
    });
    expect(blocks[1]).toEqual({ type: "paragraph", spans: [{ text: "three" }] });
  });

  it("unordered list with nesting via indentation", () => {
    const blocks = parseMarkdown("- a\n  - b\n- c");
    expect(blocks[0]).toEqual({
      type: "list",
      ordered: false,
      items: [
        { level: 0, spans: [{ text: "a" }] },
        { level: 1, spans: [{ text: "b" }] },
        { level: 0, spans: [{ text: "c" }] },
      ],
    });
  });

  it("ordered list", () => {
    const blocks = parseMarkdown("1. first\n2. second");
    expect(blocks[0]).toEqual({
      type: "list",
      ordered: true,
      items: [
        { level: 0, spans: [{ text: "first" }] },
        { level: 0, spans: [{ text: "second" }] },
      ],
    });
  });

  it("a leading escaped list marker renders as a literal paragraph, not a list", () => {
    const blocks = parseMarkdown("\\- item");
    expect(blocks).toEqual([
      { type: "paragraph", spans: [{ text: "- item" }] },
    ]);
  });

  it("a leading escaped heading marker renders as a literal paragraph, not a heading", () => {
    const blocks = parseMarkdown("\\# Title");
    expect(blocks).toEqual([
      { type: "paragraph", spans: [{ text: "# Title" }] },
    ]);
  });

  it("pipe table with header + rows", () => {
    const md = "| Name | Role |\n| --- | --- |\n| Ada | Eng |\n| Bob | PM |";
    const blocks = parseMarkdown(md);
    expect(blocks[0]).toEqual({
      type: "table",
      rows: [
        ["Name", "Role"],
        ["Ada", "Eng"],
        ["Bob", "PM"],
      ],
    });
  });
});

// ===========================================================================
// Renderer — strategy A correctness (the core anti-corruption guarantees)
// ===========================================================================

type UpdateTextStyleReq = {
  updateTextStyle?: {
    range: { startIndex: number; endIndex: number };
    textStyle: Record<string, unknown>;
    fields: string;
  };
};

describe("buildMarkdownPlan — strategy A invariants", () => {
  const md = [
    "# Heading One",
    "",
    "A paragraph with **bold** and *italic* words.",
    "",
    "- first",
    "  - nested",
    "- second",
  ].join("\n");
  const plan = buildMarkdownPlan(parseMarkdown(md));

  it("emits exactly ONE insertText, and it is the first request", () => {
    const inserts = plan.flowRequests.filter(
      (r) => (r as { insertText?: unknown }).insertText,
    );
    expect(inserts).toHaveLength(1);
    expect((plan.flowRequests[0] as { insertText?: unknown }).insertText).toBeDefined();
  });

  it("the single insert carries the full flow text at BODY_START_INDEX", () => {
    const first = plan.flowRequests[0] as {
      insertText: { text: string; location: { index: number } };
    };
    expect(first.insertText.text).toBe(plan.flowText);
    expect(first.insertText.location.index).toBe(BODY_START_INDEX);
  });

  it("every styling request comes AFTER the insert (no index reuse across a mutation)", () => {
    const idxOfInsert = plan.flowRequests.findIndex(
      (r) => (r as { insertText?: unknown }).insertText,
    );
    const laterInserts = plan.flowRequests
      .slice(idxOfInsert + 1)
      .filter((r) => (r as { insertText?: unknown }).insertText);
    expect(laterInserts).toHaveLength(0);
  });

  it("each updateTextStyle range slices the EXACT styled substring from the final layout", () => {
    const styleReqs = plan.flowRequests.filter(
      (r): r is UpdateTextStyleReq => Boolean((r as UpdateTextStyleReq).updateTextStyle),
    );
    // body starts at index 1; flowText[0] is doc index 1.
    const sliceAt = (start: number, end: number): string =>
      plan.flowText.slice(start - BODY_START_INDEX, end - BODY_START_INDEX);

    const bold = styleReqs.find((r) => r.updateTextStyle?.fields === "bold");
    const italic = styleReqs.find((r) => r.updateTextStyle?.fields === "italic");
    expect(bold).toBeDefined();
    expect(italic).toBeDefined();
    const b = bold!.updateTextStyle!.range;
    const i = italic!.updateTextStyle!.range;
    expect(sliceAt(b.startIndex, b.endIndex)).toBe("bold");
    expect(sliceAt(i.startIndex, i.endIndex)).toBe("italic");
  });

  it("applies a heading paragraph style over the heading line", () => {
    const para = plan.flowRequests.find(
      (r) =>
        (r as { updateParagraphStyle?: { paragraphStyle?: { namedStyleType?: string } } })
          .updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_1",
    ) as {
      updateParagraphStyle: {
        range: { startIndex: number; endIndex: number };
        fields: string;
      };
    };
    expect(para).toBeDefined();
    expect(para.updateParagraphStyle.fields).toBe("namedStyleType");
    const r = para.updateParagraphStyle.range;
    expect(plan.flowText.slice(r.startIndex - 1, r.endIndex - 1)).toBe(
      "Heading One\n",
    );
  });

  it("emits createParagraphBullets over the whole list block, with nesting tabs in the text", () => {
    const bullets = plan.flowRequests.find(
      (r) => (r as { createParagraphBullets?: unknown }).createParagraphBullets,
    ) as {
      createParagraphBullets: {
        range: { startIndex: number; endIndex: number };
        bulletPreset: string;
      };
    };
    expect(bullets).toBeDefined();
    expect(bullets.createParagraphBullets.bulletPreset).toBe(
      "BULLET_DISC_CIRCLE_SQUARE",
    );
    const r = bullets.createParagraphBullets.range;
    const listText = plan.flowText.slice(r.startIndex - 1, r.endIndex - 1);
    expect(listText).toBe("first\n\tnested\nsecond\n");
  });

  it("ordered list uses the numbered preset", () => {
    const p = buildMarkdownPlan(parseMarkdown("1. a\n2. b"));
    const bullets = p.flowRequests.find(
      (r) => (r as { createParagraphBullets?: { bulletPreset?: string } }).createParagraphBullets,
    ) as { createParagraphBullets: { bulletPreset: string } };
    expect(bullets.createParagraphBullets.bulletPreset).toBe(
      "NUMBERED_DECIMAL_ALPHA_ROMAN",
    );
  });
});

// ===========================================================================
// Renderer — round-trip the flow text through read_text (proves no corruption)
// ===========================================================================

/** Build a Google-shaped Document from a flow-text string (one paragraph per line). */
function docFromFlowText(flowText: string): unknown {
  const content: unknown[] = [{ sectionBreak: {} }];
  // Each "...\n" segment becomes a paragraph whose textRun keeps the newline.
  const parts = flowText.split("\n");
  parts.forEach((part, idx) => {
    const isLast = idx === parts.length - 1;
    const text = isLast ? part : part + "\n";
    if (text.length === 0) return;
    content.push({ paragraph: { elements: [{ textRun: { content: text } }] } });
  });
  // The original blank doc keeps a trailing empty paragraph.
  content.push({ paragraph: { elements: [{ textRun: { content: "\n" } }] } });
  return { body: { content } };
}

describe("buildMarkdownPlan — round-trip through read_text", () => {
  it("the laid-out flow text reconstructs verbatim (+ trailing newline)", () => {
    const md = [
      "# Plan",
      "",
      "Intro with **bold**.",
      "",
      "- one",
      "- two",
    ].join("\n");
    const plan = buildMarkdownPlan(parseMarkdown(md));
    const doc = docFromFlowText(plan.flowText);
    expect(readDocumentText(doc)).toBe(plan.flowText + "\n");
  });
});

// ===========================================================================
// Tables — write-backwards ordering + source order preservation
// ===========================================================================

describe("buildMarkdownPlan — tables", () => {
  it("records a table descriptor with normalized cells and no flow text", () => {
    const md = "| A | B |\n| - | - |\n| 1 | 2 |";
    const plan = buildMarkdownPlan(parseMarkdown(md));
    expect(plan.flowText).toBe(""); // table contributes no flow text
    expect(plan.tables).toHaveLength(1);
    expect(plan.tables[0]).toMatchObject({
      insertIndex: BODY_START_INDEX,
      rows: 2,
      columns: 2,
      cells: [
        ["A", "B"],
        ["1", "2"],
      ],
    });
  });

  it("preserves source order: text-before-table-before-text keeps split points", () => {
    const md = [
      "Intro line",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "Outro line",
    ].join("\n");
    const plan = buildMarkdownPlan(parseMarkdown(md));
    // Intro line "Intro line\n" occupies indexes [1,12); table insert at 12;
    // outro then follows in the contiguous flow.
    expect(plan.flowText).toBe("Intro line\nOutro line\n");
    expect(plan.tables[0]?.insertIndex).toBe(1 + "Intro line\n".length);
  });

  it("tablesWriteBackwards sorts descending by insertIndex", () => {
    const tables = [
      { insertIndex: 5, rows: 1, columns: 1, cells: [["a"]] },
      { insertIndex: 30, rows: 1, columns: 1, cells: [["b"]] },
      { insertIndex: 12, rows: 1, columns: 1, cells: [["c"]] },
    ];
    expect(tablesWriteBackwards(tables).map((t) => t.insertIndex)).toEqual([
      30, 12, 5,
    ]);
  });
});

// ===========================================================================
// FINDING 1 (CRITICAL): two adjacent tables MUST NOT collide on insertIndex.
// Without a separating paragraph, a table block emits no flow text, so the
// cursor does not advance; two tables separated only by a blank line would be
// recorded at the SAME insertIndex. Phase B would then insert both at one point
// and Phase C's positional table<->descriptor match would mis-place cells.
// ===========================================================================

describe("buildMarkdownPlan — adjacent tables (collision regression)", () => {
  // The exact reproduction from the review finding: two tables, blank line
  // between, no surrounding flow text.
  const TWO_TABLES = [
    "| a | b | c |",
    "| - | - | - |",
    "| d | e | f |",
    "",
    "| x |",
    "| - |",
    "| y |",
  ].join("\n");

  it("records TWO table descriptors", () => {
    const plan = buildMarkdownPlan(parseMarkdown(TWO_TABLES));
    expect(plan.tables).toHaveLength(2);
  });

  it("(a) gives each table a strictly-ascending DISTINCT insertIndex", () => {
    const plan = buildMarkdownPlan(parseMarkdown(TWO_TABLES));
    const idxs = plan.tables.map((t) => t.insertIndex);
    expect(new Set(idxs).size).toBe(idxs.length); // distinct
    expect(idxs[1]).toBeGreaterThan(idxs[0] as number); // ascending
    // First table anchors at the body start; a single separating paragraph
    // ("\n") advances the cursor by one before the second table is recorded.
    expect(idxs).toEqual([BODY_START_INDEX, BODY_START_INDEX + 1]);
  });

  it("inserts a separating empty paragraph into the flow between the tables", () => {
    const plan = buildMarkdownPlan(parseMarkdown(TWO_TABLES));
    expect(plan.flowText).toBe("\n");
  });

  it("(b) Phase B insert order (tablesWriteBackwards) is strictly DESCENDING and at distinct indices", () => {
    const plan = buildMarkdownPlan(parseMarkdown(TWO_TABLES));
    const order = tablesWriteBackwards(plan.tables).map((t) => t.insertIndex);
    expect(order).toEqual([BODY_START_INDEX + 1, BODY_START_INDEX]);
    // strictly descending => no two equal
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i] as number).toBeLessThan(order[i - 1] as number);
    }
  });

  it("scales to THREE adjacent tables with distinct ascending anchors [1,2,3]", () => {
    const THREE = [
      "| a |",
      "| - |",
      "| 1 |",
      "",
      "| b |",
      "| - |",
      "| 2 |",
      "",
      "| c |",
      "| - |",
      "| 3 |",
    ].join("\n");
    const plan = buildMarkdownPlan(parseMarkdown(THREE));
    expect(plan.tables.map((t) => t.insertIndex)).toEqual([
      BODY_START_INDEX,
      BODY_START_INDEX + 1,
      BODY_START_INDEX + 2,
    ]);
    expect(plan.flowText).toBe("\n\n"); // one separator per adjacency
    // Each descriptor keeps its OWN source cells (no cross-contamination).
    expect(plan.tables[0]?.cells).toEqual([["a"], ["1"]]);
    expect(plan.tables[1]?.cells).toEqual([["b"], ["2"]]);
    expect(plan.tables[2]?.cells).toEqual([["c"], ["3"]]);
  });

  it("a table separated from the next by REAL text keeps distinct anchors without an extra separator", () => {
    const md = [
      "| a |",
      "| - |",
      "| 1 |",
      "",
      "Some prose between the tables.",
      "",
      "| b |",
      "| - |",
      "| 2 |",
    ].join("\n");
    const plan = buildMarkdownPlan(parseMarkdown(md));
    const idxs = plan.tables.map((t) => t.insertIndex);
    expect(new Set(idxs).size).toBe(2);
    expect(plan.flowText).toBe("Some prose between the tables.\n");
  });

  it("a lone table is unaffected (no spurious separator)", () => {
    const plan = buildMarkdownPlan(parseMarkdown("| A | B |\n| - | - |\n| 1 | 2 |"));
    expect(plan.flowText).toBe("");
    expect(plan.tables).toHaveLength(1);
    expect(plan.tables[0]?.insertIndex).toBe(BODY_START_INDEX);
  });
});

describe("assertDistinctTableInsertIndices — loud defensive guard", () => {
  it("passes a distinct ascending set", () => {
    expect(() =>
      assertDistinctTableInsertIndices([
        { insertIndex: 1 },
        { insertIndex: 2 },
        { insertIndex: 9 },
      ]),
    ).not.toThrow();
  });

  it("throws on a duplicated insertIndex (the corruption invariant)", () => {
    expect(() =>
      assertDistinctTableInsertIndices([
        { insertIndex: 5 },
        { insertIndex: 5 },
      ]),
    ).toThrow(ValidationError);
  });

  it("tablesWriteBackwards throws LOUD on colliding indices instead of silently corrupting", () => {
    expect(() =>
      tablesWriteBackwards([
        { insertIndex: 7, rows: 1, columns: 1, cells: [["a"]] },
        { insertIndex: 7, rows: 1, columns: 1, cells: [["b"]] },
      ]),
    ).toThrow(ValidationError);
  });
});

// ===========================================================================
// Mixed-document smoke (the flagship's hardest input shape)
// ===========================================================================

describe("buildMarkdownPlan — mixed document", () => {
  const md = [
    "# Quarterly Review",
    "",
    "## Highlights",
    "",
    "We shipped **fast** and stayed *lean*.",
    "",
    "- Revenue up",
    "  - North region",
    "- Costs down",
    "",
    "1. Plan",
    "2. Build",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    "| Users | 1000 |",
  ].join("\n");
  const blocks = parseMarkdown(md) as Block[];
  const plan = buildMarkdownPlan(blocks);

  it("parses every block type", () => {
    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      "heading",
      "heading",
      "paragraph",
      "list",
      "list",
      "table",
    ]);
  });

  it("produces two heading styles, two bullet lists, and one table", () => {
    const headingStyles = plan.flowRequests.filter((r) =>
      (r as { updateParagraphStyle?: { paragraphStyle?: { namedStyleType?: string } } })
        .updateParagraphStyle?.paragraphStyle?.namedStyleType?.startsWith("HEADING"),
    );
    const bulletReqs = plan.flowRequests.filter(
      (r) => (r as { createParagraphBullets?: unknown }).createParagraphBullets,
    );
    expect(headingStyles).toHaveLength(2);
    expect(bulletReqs).toHaveLength(2);
    expect(plan.tables).toHaveLength(1);
  });

  it("bold and italic ranges still slice correctly amid the larger document", () => {
    const styleReqs = plan.flowRequests.filter(
      (r): r is UpdateTextStyleReq => Boolean((r as UpdateTextStyleReq).updateTextStyle),
    );
    const sliceAt = (start: number, end: number): string =>
      plan.flowText.slice(start - 1, end - 1);
    const bold = styleReqs.find((r) => r.updateTextStyle?.fields === "bold")!;
    const italic = styleReqs.find((r) => r.updateTextStyle?.fields === "italic")!;
    expect(sliceAt(bold.updateTextStyle!.range.startIndex, bold.updateTextStyle!.range.endIndex)).toBe("fast");
    expect(sliceAt(italic.updateTextStyle!.range.startIndex, italic.updateTextStyle!.range.endIndex)).toBe("lean");
  });
});
