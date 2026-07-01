import { describe, expect, it } from "vitest";
import { tools } from "../tools/index.js";

// email-smart shipped 30 tools through Phase 8. Phase 9-A added the 12
// gmail.settings.basic tools (filters + vacation + imap/pop/language + send-as),
// bringing the total to 42. Phase 9-B adds the 11 gmail.settings.sharing +
// permanent-delete tools (auto-forwarding, forwarding addresses, delegates,
// delete_message/thread_permanent, batch_delete_messages), bringing the total
// to 53.
describe("tools/index — wire", () => {
  it("exports exactly 53 tools", () => {
    expect(tools).toHaveLength(53);
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

  it("contains the expected 53 tool names", () => {
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
      // Filters (3)
      "create_filter",
      "list_filters",
      "delete_filter",
      // Vacation (2)
      "get_vacation",
      "update_vacation",
      // IMAP / POP / language (5)
      "get_imap",
      "update_imap",
      "get_pop",
      "update_pop",
      "update_language",
      // Send-as (2)
      "list_send_as",
      "update_send_as",
      // Auto-forwarding (2)
      "get_auto_forwarding",
      "update_auto_forwarding",
      // Forwarding addresses (3)
      "list_forwarding_addresses",
      "create_forwarding_address",
      "delete_forwarding_address",
      // Delegates (3)
      "list_delegates",
      "create_delegate",
      "delete_delegate",
      // Permanent delete (3)
      "delete_message_permanent",
      "batch_delete_messages",
      "delete_thread_permanent",
    ].sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });
});
