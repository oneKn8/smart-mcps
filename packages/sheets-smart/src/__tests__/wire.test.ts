import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

// Wire test: the canary that proves all 16 tools land correctly. If a tool is
// added/removed/renamed, exactly one assertion below fires — by design.

describe("sheets-smart wire", () => {
  it("registers exactly 16 tools", () => {
    expect(tools).toHaveLength(16);
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

  it("matches the spec's 16 tool names exactly", () => {
    const expected = [
      "list_sheets",
      "create_sheet",
      "get_sheet",
      "delete_sheet",
      "read_range",
      "write_range",
      "append_rows",
      "update_cells",
      "clear_range",
      "add_tab",
      "rename_tab",
      "delete_tab",
      "format_range",
      "batch_update",
      "share_sheet",
      "quick_add_row",
    ].sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });

  it("every tool description is non-empty and <= 60 chars", () => {
    for (const t of tools) {
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(0);
      expect(
        t.description.length,
        `${t.name}: "${t.description}" exceeds 60 chars`,
      ).toBeLessThanOrEqual(60);
    }
  });
});
