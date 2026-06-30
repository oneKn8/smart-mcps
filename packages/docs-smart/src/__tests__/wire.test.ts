import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

// Wire test: the canary that proves all 18 tools land correctly. If a tool is
// added/removed/renamed, exactly one assertion below fires — by design.

describe("docs-smart wire", () => {
  it("registers exactly 18 tools", () => {
    expect(tools).toHaveLength(18);
  });

  it("all tool names are snake_case", () => {
    const re = /^[a-z][a-z0-9_]*$/;
    for (const t of tools) {
      expect(t.name, `${t.name} should be snake_case`).toMatch(re);
    }
  });

  it("all tool names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("matches the spec's 18 tool names exactly", () => {
    const expected = [
      // Read / create (3)
      "get_document",
      "read_text",
      "create_document",
      // Text edits (4)
      "insert_text",
      "delete_range",
      "replace_all_text",
      "append_text",
      // Styling (5)
      "set_text_style",
      "set_paragraph_style",
      "set_heading",
      "make_bullets",
      "remove_bullets",
      // Tables (2)
      "insert_table",
      "fill_table",
      // Media (2)
      "insert_image",
      "insert_page_break",
      // Markdown flagship (1) + raw escape hatch (1)
      "create_doc_from_markdown",
      "batch_update",
    ].sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });

  it("every tool description is <= 15 tokens (rough word count)", () => {
    for (const t of tools) {
      const wordCount = t.description.trim().split(/\s+/).length;
      expect(
        wordCount,
        `${t.name}: "${t.description}" exceeds budget`,
      ).toBeLessThanOrEqual(15);
    }
  });

  it("every tool description is non-empty", () => {
    for (const t of tools) {
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(0);
    }
  });
});
