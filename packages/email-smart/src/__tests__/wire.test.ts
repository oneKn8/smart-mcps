import { describe, expect, it } from "vitest";
import { tools } from "../tools/index.js";

describe("tools/index — wire", () => {
  it("exports exactly 30 tools", () => {
    expect(tools).toHaveLength(30);
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

  it("contains the expected 30 tool names", () => {
    const expected = [
      // Send (5)
      "send_email",
      "send_with_template",
      "send_with_attachment",
      "compose_thread",
      "bulk_send",
      // Identities + audit (4)
      "list_identities",
      "get_identity",
      "list_recent_sends",
      "search_audit",
      // Inbox read (5)
      "list_inbox",
      "search_emails",
      "read_email",
      "get_thread",
      "bulk_read_messages",
      // Bulk modify (4) destructive
      "mark_read_by_query",
      "archive_by_query",
      "trash_by_query",
      "apply_label_by_query",
      // Labels (4) — list + CRUD
      "list_labels",
      "create_label",
      "update_label",
      "delete_label",
      // Smart shortcuts (2)
      "daily_status",
      "inbox_zero_dry_run",
      // Bulk unsubscribe (1)
      "bulk_unsubscribe",
      // Drafts (5)
      "create_draft",
      "list_drafts",
      "send_draft",
      "update_draft",
      "delete_draft",
    ].sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });
});
