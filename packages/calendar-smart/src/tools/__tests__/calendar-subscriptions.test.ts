import { describe, it, expect, vi } from "vitest";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import {
  subscribeCalendarTool,
  unsubscribeCalendarTool,
  updateCalendarSubscriptionTool,
} from "../calendar-subscriptions.js";

type FakeClient = {
  insertCalendarListEntry: ReturnType<typeof vi.fn>;
  patchCalendarListEntry: ReturnType<typeof vi.fn>;
  deleteCalendarListEntry: ReturnType<typeof vi.fn>;
  getCalendarListEntry: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    insertCalendarListEntry: vi.fn(),
    patchCalendarListEntry: vi.fn(),
    deleteCalendarListEntry: vi.fn(),
    getCalendarListEntry: vi.fn(),
    ...over,
  };
}

const calTeamEntry: Record<string, unknown> = {
  id: "cal_team",
  summary: "Team",
  accessRole: "reader",
  timeZone: "America/Chicago",
  backgroundColor: "#0d58c7",
};

// ============================================================================
// subscribe_calendar
// ============================================================================

describe("subscribeCalendarTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(subscribeCalendarTool.name).toBe("subscribe_calendar");
    expect(subscribeCalendarTool.description).toBe(
      "Add an existing calendar to your sidebar",
    );
    expect(
      subscribeCalendarTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires calendar_id", () => {
    expect(() => subscribeCalendarTool.inputSchema.parse({})).toThrow();
  });
});

describe("subscribeCalendarTool — handler", () => {
  it("POSTs body with id + selected default true; no colorRgbFormat without hex", async () => {
    const client = makeClient({
      insertCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = subscribeCalendarTool.inputSchema.parse({
      calendar_id: "cal_team",
    }) as Parameters<typeof subscribeCalendarTool.handler>[0];

    const out = await subscribeCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertCalendarListEntry).toHaveBeenCalledWith({
      body: { id: "cal_team", selected: true, hidden: false },
    });
    expect(out.calendar.id).toBe("cal_team");
    expect(out.calendar.access_role).toBe("reader");
  });

  it("forwards color_id, summary_override, selected=false, hidden=true (no hex => no colorRgbFormat)", async () => {
    const client = makeClient({
      insertCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = subscribeCalendarTool.inputSchema.parse({
      calendar_id: "cal_team",
      color_id: "7",
      summary_override: "Team Cal",
      selected: false,
      hidden: true,
    }) as Parameters<typeof subscribeCalendarTool.handler>[0];

    await subscribeCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertCalendarListEntry).toHaveBeenCalledWith({
      body: {
        id: "cal_team",
        colorId: "7",
        summaryOverride: "Team Cal",
        selected: false,
        hidden: true,
      },
    });
  });

  it("adds colorRgbFormat=true when background_color or foreground_color is hex", async () => {
    const client = makeClient({
      insertCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = subscribeCalendarTool.inputSchema.parse({
      calendar_id: "cal_team",
      background_color: "#ff0000",
      foreground_color: "#ffffff",
    }) as Parameters<typeof subscribeCalendarTool.handler>[0];

    await subscribeCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.insertCalendarListEntry).toHaveBeenCalledWith({
      body: {
        id: "cal_team",
        backgroundColor: "#ff0000",
        foregroundColor: "#ffffff",
        selected: true,
        hidden: false,
      },
      colorRgbFormat: true,
    });
  });
});

// ============================================================================
// unsubscribe_calendar (destructive — confirm-gated, primary guard)
// ============================================================================

describe("unsubscribeCalendarTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(unsubscribeCalendarTool.name).toBe("unsubscribe_calendar");
    expect(unsubscribeCalendarTool.description).toBe(
      "Remove a calendar from your sidebar",
    );
    expect(
      unsubscribeCalendarTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });
});

describe("unsubscribeCalendarTool — handler", () => {
  it("throws ValidationError when calendar_id is the literal 'primary'", async () => {
    const client = makeClient();
    const parsed = unsubscribeCalendarTool.inputSchema.parse({
      calendar_id: "primary",
      confirm: true,
    }) as Parameters<typeof unsubscribeCalendarTool.handler>[0];
    await expect(
      unsubscribeCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.deleteCalendarListEntry).not.toHaveBeenCalled();
  });

  it("throws ValidationError when calendar_id resolves to the primary calendar", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue({
        id: "alice@example.test",
        summary: "Personal",
        primary: true,
        accessRole: "owner",
        timeZone: "America/Chicago",
      }),
    });
    const parsed = unsubscribeCalendarTool.inputSchema.parse({
      calendar_id: "alice@example.test",
      confirm: true,
    }) as Parameters<typeof unsubscribeCalendarTool.handler>[0];
    await expect(
      unsubscribeCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.deleteCalendarListEntry).not.toHaveBeenCalled();
  });

  it("throws ConfirmRequiredError when confirm is omitted", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = unsubscribeCalendarTool.inputSchema.parse({
      calendar_id: "cal_team",
    }) as Parameters<typeof unsubscribeCalendarTool.handler>[0];
    await expect(
      unsubscribeCalendarTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
  });

  it("preview includes the calendar summary and a re-subscribe hint", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = unsubscribeCalendarTool.inputSchema.parse({
      calendar_id: "cal_team",
    }) as Parameters<typeof unsubscribeCalendarTool.handler>[0];
    try {
      await unsubscribeCalendarTool.handler(parsed, {
        client: client as unknown as never,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const e = err as ConfirmRequiredError;
      expect(e.preview).toContain("Team");
      expect(e.preview).toContain("cal_team");
      expect(e.preview.toLowerCase()).toContain("re-subscribe");
    }
  });

  it("calls client.deleteCalendarListEntry when confirmed and returns unsubscribed: true", async () => {
    const client = makeClient({
      getCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
      deleteCalendarListEntry: vi.fn().mockResolvedValue(undefined),
    });
    const parsed = unsubscribeCalendarTool.inputSchema.parse({
      calendar_id: "cal_team",
      confirm: true,
    }) as Parameters<typeof unsubscribeCalendarTool.handler>[0];
    const out = await unsubscribeCalendarTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.deleteCalendarListEntry).toHaveBeenCalledWith({
      calendarId: "cal_team",
    });
    expect(out).toEqual({ unsubscribed: true });
  });
});

// ============================================================================
// update_calendar_subscription
// ============================================================================

describe("updateCalendarSubscriptionTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(updateCalendarSubscriptionTool.name).toBe(
      "update_calendar_subscription",
    );
    expect(updateCalendarSubscriptionTool.description).toBe(
      "Change calendar color, label, and notifications",
    );
    expect(
      updateCalendarSubscriptionTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires calendar_id", () => {
    expect(() => updateCalendarSubscriptionTool.inputSchema.parse({})).toThrow();
  });
});

describe("updateCalendarSubscriptionTool — handler", () => {
  it("PATCHes only the provided fields with snake_case-to-camelCase mapping", async () => {
    const client = makeClient({
      patchCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = updateCalendarSubscriptionTool.inputSchema.parse({
      calendar_id: "cal_team",
      color_id: "7",
      summary_override: "Renamed",
      selected: false,
      hidden: true,
    }) as Parameters<typeof updateCalendarSubscriptionTool.handler>[0];

    await updateCalendarSubscriptionTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchCalendarListEntry).toHaveBeenCalledWith({
      calendarId: "cal_team",
      body: {
        colorId: "7",
        summaryOverride: "Renamed",
        selected: false,
        hidden: true,
      },
    });
  });

  it("forwards default_reminders as defaultReminders camelCase array", async () => {
    const client = makeClient({
      patchCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = updateCalendarSubscriptionTool.inputSchema.parse({
      calendar_id: "cal_team",
      default_reminders: [
        { method: "popup", minutes: 10 },
        { method: "email", minutes: 60 },
      ],
    }) as Parameters<typeof updateCalendarSubscriptionTool.handler>[0];

    await updateCalendarSubscriptionTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchCalendarListEntry).toHaveBeenCalledWith({
      calendarId: "cal_team",
      body: {
        defaultReminders: [
          { method: "popup", minutes: 10 },
          { method: "email", minutes: 60 },
        ],
      },
    });
  });

  it("forwards notification_settings as notificationSettings.notifications", async () => {
    const client = makeClient({
      patchCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = updateCalendarSubscriptionTool.inputSchema.parse({
      calendar_id: "cal_team",
      notification_settings: [
        { type: "eventCreation", method: "email" },
        { type: "eventCancellation", method: "email" },
      ],
    }) as Parameters<typeof updateCalendarSubscriptionTool.handler>[0];

    await updateCalendarSubscriptionTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchCalendarListEntry).toHaveBeenCalledWith({
      calendarId: "cal_team",
      body: {
        notificationSettings: {
          notifications: [
            { type: "eventCreation", method: "email" },
            { type: "eventCancellation", method: "email" },
          ],
        },
      },
    });
  });

  it("adds colorRgbFormat=true when background_color or foreground_color is hex", async () => {
    const client = makeClient({
      patchCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = updateCalendarSubscriptionTool.inputSchema.parse({
      calendar_id: "cal_team",
      background_color: "#00ff00",
    }) as Parameters<typeof updateCalendarSubscriptionTool.handler>[0];

    await updateCalendarSubscriptionTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchCalendarListEntry).toHaveBeenCalledWith({
      calendarId: "cal_team",
      body: { backgroundColor: "#00ff00" },
      colorRgbFormat: true,
    });
  });

  it("omits the body and query when only calendar_id is provided", async () => {
    const client = makeClient({
      patchCalendarListEntry: vi.fn().mockResolvedValue(calTeamEntry),
    });
    const parsed = updateCalendarSubscriptionTool.inputSchema.parse({
      calendar_id: "cal_team",
    }) as Parameters<typeof updateCalendarSubscriptionTool.handler>[0];

    await updateCalendarSubscriptionTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchCalendarListEntry).toHaveBeenCalledWith({
      calendarId: "cal_team",
      body: {},
    });
  });

  it("rejects invalid notification_settings type at the schema layer", () => {
    expect(() =>
      updateCalendarSubscriptionTool.inputSchema.parse({
        calendar_id: "cal_team",
        notification_settings: [{ type: "bogus", method: "email" }],
      }),
    ).toThrow();
  });
});
