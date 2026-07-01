import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

// Wire test: the canary that proves all tools land correctly. If a tool is
// added/removed/renamed, exactly one assertion below fires — by design.
//
// This half (JSON / organize / lifecycle / read / sharing) registers exactly
// 18 tools. The media implementer adds 4 more (upload / update_content /
// download / export), which will bump the count here to 22 — update the
// expected count + name list when that half lands.

const EXPECTED_TOOLS = [
  // Create / organize (3)
  "create_folder",
  "create_shortcut",
  "generate_ids",
  // Organize (5)
  "rename",
  "move",
  "star",
  "update_metadata",
  "copy",
  // Lifecycle (4)
  "trash",
  "restore",
  "delete",
  "empty_trash",
  // Read (2)
  "get",
  "list",
  // Sharing (4)
  "share",
  "list_permissions",
  "update_permission",
  "unshare",
] as const;

describe("gdrive-smart wire", () => {
  it("registers exactly 18 tools", () => {
    expect(tools).toHaveLength(18);
  });

  it("matches the expected 18 tool names exactly", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
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
