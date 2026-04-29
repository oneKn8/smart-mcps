import { describe, expect, it } from "vitest";
import { tools } from "../tools/index.js";

describe("tools/index — wire", () => {
  it("exports exactly 18 tools", () => {
    expect(tools).toHaveLength(18);
  });

  it("all tool names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tool names are snake_case", () => {
    const snakeCase = /^[a-z][a-z0-9_]*$/;
    for (const t of tools) {
      expect(t.name, `${t.name} should be snake_case`).toMatch(snakeCase);
    }
  });

  it("all tool descriptions are non-empty and concise", () => {
    for (const t of tools) {
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(0);
      expect(t.description.length, `${t.name} description`).toBeLessThanOrEqual(120);
    }
  });

  it("all tool descriptions are unique", () => {
    const descriptions = tools.map((t) => t.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("contains the expected 18 tool names", () => {
    const expected = [
      "send_email",
      "send_with_template",
      "list_identities",
      "get_identity",
      "list_recent_sends",
      "search_audit",
      "list_inbox",
      "search_emails",
      "read_email",
      "get_thread",
      "bulk_read_messages",
      "mark_read_by_query",
      "archive_by_query",
      "trash_by_query",
      "apply_label_by_query",
      "list_labels",
      "daily_status",
      "inbox_zero_dry_run",
    ].sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });
});
