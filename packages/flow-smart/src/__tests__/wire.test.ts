import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

// Wire test: the canary that proves all 6 orchestrator tools land correctly.
// If a tool is added/removed/renamed, exactly one assertion below fires.

describe("flow-smart wire", () => {
  it("registers exactly 6 tools", () => {
    expect(tools).toHaveLength(6);
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

  it("matches the spec's 6 tool names exactly", () => {
    const expected = [
      "email_to_task",
      "task_to_calendar_block",
      "weekly_review_doc",
      "inbox_digest_doc",
      "daily_brief_doc",
      "deploy_inbox_watcher",
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
