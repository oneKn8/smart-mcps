import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

// Wire test: the canary that proves all 16 tools land correctly. If a tool is
// added/removed/renamed, exactly one assertion below fires — by design. Counts
// and the explicit name list both come from the Phase 7 tasks-smart spec.

describe("tasks-smart wire", () => {
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
      // Task lists (5)
      "list_task_lists",
      "get_task_list",
      "create_task_list",
      "update_task_list",
      "delete_task_list",
      // Tasks (6)
      "list_tasks",
      "get_task",
      "create_task",
      "update_task",
      "complete_task",
      "delete_task",
      // Organize (2)
      "move_task",
      "clear_completed",
      // Smart shortcuts (3)
      "today_tasks",
      "overdue_tasks",
      "quick_add",
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

  it("clear_completed says hide, never delete", () => {
    const clear = tools.find((t) => t.name === "clear_completed");
    expect(clear?.description.toLowerCase()).toContain("hide");
    expect(clear?.description.toLowerCase()).not.toContain("delete");
  });
});
