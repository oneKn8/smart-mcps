import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

// Wire test: the canary that proves all 34 tools land correctly. If a tool
// is added/removed/renamed, exactly one assertion below fires — by design.
// Counts and the explicit name list both come from the Phase 5 + 5.5 spec.

describe("calendar-smart wire", () => {
  it("registers exactly 34 tools", () => {
    expect(tools).toHaveLength(34);
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

  it("matches the spec's 34 tool names exactly", () => {
    const expected = [
      // Read agenda (5)
      "list_events",
      "get_event",
      "daily_agenda",
      "weekly_agenda",
      "next_event",
      // Availability (3)
      "find_availability",
      "busy_blocks",
      "conflicts_check",
      // Create / modify (6)
      "quick_add",
      "create_event",
      "update_event",
      "reschedule",
      "cancel_event",
      "respond_to_event",
      // Calendar management (2)
      "list_calendars",
      "get_calendar",
      // Smart shortcuts (5)
      "daily_brief",
      "weekly_brief",
      "find_meeting_time",
      "event_with_invite_preview",
      "outdoor_event_check",
      // Wave 2: recurring (4) + search (1) + sync (1)
      "list_instances",
      "update_instance",
      "cancel_instance",
      "split_recurrence",
      "search_events",
      "sync_events",
      // Wave 3: calendar resource CRUD (4)
      "create_calendar",
      "update_calendar",
      "delete_calendar",
      "clear_primary_calendar",
      // Wave 3: CalendarList subscription management (3)
      "subscribe_calendar",
      "unsubscribe_calendar",
      "update_calendar_subscription",
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
