import { describe, it, expect } from "vitest";
import {
  buildMarkdownPlan,
  parseInline,
  parseMarkdown,
  tablesWriteBackwards,
  type Block,
} from "../markdown.js";
import { BODY_START_INDEX } from "../request-builders.js";
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
