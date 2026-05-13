import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  updateEventTool,
  rescheduleTool,
  cancelEventTool,
} from "../events-update.js";

type FakeClient = {
  patchEvent?: ReturnType<typeof vi.fn>;
  getEvent?: ReturnType<typeof vi.fn>;
  deleteEvent?: ReturnType<typeof vi.fn>;
  getCalendarListEntry?: ReturnType<typeof vi.fn>;
};

function makeClient(over: FakeClient = {}): FakeClient {
  return {
    patchEvent: vi.fn().mockResolvedValue({}),
    getEvent: vi.fn().mockResolvedValue({}),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    getCalendarListEntry: vi
      .fn()
      .mockResolvedValue({ id: "primary", summary: "Personal" }),
    ...over,
  };
}

function rawEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt_alpha",
    summary: "Standup",
    start: { dateTime: "2026-05-13T10:00:00-05:00" },
    end: { dateTime: "2026-05-13T10:30:00-05:00" },
    htmlLink: "https://calendar.google.com/event?eid=alpha",
    status: "confirmed",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// updateEventTool
// ---------------------------------------------------------------------------

describe("updateEventTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(updateEventTool.name).toBe("update_event");
    expect(
      updateEventTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires event_id and defaults calendar_id", () => {
    expect(() => updateEventTool.inputSchema.parse({})).toThrow();
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as { calendar_id: string };
    expect(parsed.calendar_id).toBe("primary");
  });

  it("inputSchema is a zod type", () => {
    expect(updateEventTool.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("updateEventTool — handler", () => {
  it("PATCHes only the provided fields (omitted fields not in body)", async () => {
    const client = makeClient({
      patchEvent: vi
        .fn()
        .mockResolvedValue(rawEvent({ summary: "New Title" })),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      summary: "New Title",
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
      body: { summary: "New Title" },
    });
  });

  it("wraps start/end as { dateTime } blocks", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      start: "2026-05-13T11:00:00-05:00",
      end: "2026-05-13T11:30:00-05:00",
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
      body: {
        start: { dateTime: "2026-05-13T11:00:00-05:00" },
        end: { dateTime: "2026-05-13T11:30:00-05:00" },
      },
    });
  });

  it("includes location, description, and attendees when provided", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      location: "Conf Room",
      description: "Updated agenda",
      attendees: ["bob@example.test"],
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.patchEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
      body: {
        location: "Conf Room",
        description: "Updated agenda",
        attendees: [{ email: "bob@example.test" }],
      },
    });
  });

  it("propagates a NotFoundError from the client", async () => {
    const client = makeClient({
      patchEvent: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Event `evt_x` not found")),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_x",
      summary: "x",
    }) as Parameters<typeof updateEventTool.handler>[0];
    await expect(
      updateEventTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("respects a non-default calendar_id", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      summary: "x",
      calendar_id: "cal_work",
    }) as Parameters<typeof updateEventTool.handler>[0];
    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.patchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: "cal_work" }),
    );
  });
});

// ---------------------------------------------------------------------------
// rescheduleTool
// ---------------------------------------------------------------------------

describe("rescheduleTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(rescheduleTool.name).toBe("reschedule");
    expect(
      rescheduleTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires event_id, start, end and defaults calendar_id", () => {
    expect(() => rescheduleTool.inputSchema.parse({})).toThrow();
    expect(() =>
      rescheduleTool.inputSchema.parse({
        event_id: "evt_alpha",
      }),
    ).toThrow();
    const parsed = rescheduleTool.inputSchema.parse({
      event_id: "evt_alpha",
      start: "2026-05-13T11:00:00-05:00",
      end: "2026-05-13T12:00:00-05:00",
    }) as { calendar_id: string };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("rescheduleTool — handler", () => {
  it("PATCHes both start and end as dateTime blocks", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = rescheduleTool.inputSchema.parse({
      event_id: "evt_alpha",
      start: "2026-05-13T11:00:00-05:00",
      end: "2026-05-13T12:00:00-05:00",
    }) as Parameters<typeof rescheduleTool.handler>[0];

    await rescheduleTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.patchEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
      body: {
        start: { dateTime: "2026-05-13T11:00:00-05:00" },
        end: { dateTime: "2026-05-13T12:00:00-05:00" },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// cancelEventTool
// ---------------------------------------------------------------------------

describe("cancelEventTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(cancelEventTool.name).toBe("cancel_event");
    expect(
      cancelEventTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires event_id and defaults calendar_id + confirm=false", () => {
    const parsed = cancelEventTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as { calendar_id: string; confirm: boolean };
    expect(parsed.calendar_id).toBe("primary");
    expect(parsed.confirm).toBe(false);
  });
});

describe("cancelEventTool — handler", () => {
  it("throws ConfirmRequiredError when confirm is omitted (preview includes summary, time, attendee count)", async () => {
    const event = rawEvent({
      id: "evt_alpha",
      summary: "Team Sync",
      start: { dateTime: "2026-05-13T10:00:00-05:00" },
      end: { dateTime: "2026-05-13T10:30:00-05:00" },
      attendees: [
        { email: "bob@example.test", responseStatus: "accepted" },
        { email: "carol@example.test", responseStatus: "tentative" },
      ],
    });
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(event),
      getCalendarListEntry: vi
        .fn()
        .mockResolvedValue({ id: "primary", summary: "Personal" }),
    });
    const parsed = cancelEventTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as Parameters<typeof cancelEventTool.handler>[0];

    let caught: unknown;
    try {
      await cancelEventTool.handler(parsed, {
        client: client as unknown as never,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    const cre = caught as ConfirmRequiredError;
    expect(cre.preview).toContain("Team Sync");
    expect(cre.preview).toContain("2026-05-13T10:00:00-05:00");
    expect(cre.preview).toContain("Personal");
    expect(cre.preview).toContain("2 attendees");
    // Side-effect-free: deleteEvent was NOT called.
    expect(client.deleteEvent).not.toHaveBeenCalled();
  });

  it("deletes the event and returns { cancelled: true } when confirm is true", async () => {
    const event = rawEvent({ id: "evt_alpha", summary: "Team Sync" });
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(event),
    });
    const parsed = cancelEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      confirm: true,
    }) as Parameters<typeof cancelEventTool.handler>[0];

    const out = await cancelEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.deleteEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
    });
    expect(out).toEqual({ cancelled: true });
  });

  it("preview falls back to the calendar id when getCalendarListEntry fails", async () => {
    const event = rawEvent({
      id: "evt_alpha",
      summary: "Team Sync",
      attendees: [],
    });
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(event),
      getCalendarListEntry: vi
        .fn()
        .mockRejectedValue(new NotFoundError("missing calendar")),
    });
    const parsed = cancelEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      calendar_id: "cal_work",
    }) as Parameters<typeof cancelEventTool.handler>[0];

    let caught: unknown;
    try {
      await cancelEventTool.handler(parsed, {
        client: client as unknown as never,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    const cre = caught as ConfirmRequiredError;
    expect(cre.preview).toContain("cal_work");
    expect(cre.preview).toContain("0 attendees");
  });

  it("preview reports zero attendees when the event has none", async () => {
    const event = rawEvent({
      id: "evt_alpha",
      summary: "Solo Block",
      // attendees omitted
    });
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(event),
    });
    const parsed = cancelEventTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as Parameters<typeof cancelEventTool.handler>[0];

    let caught: unknown;
    try {
      await cancelEventTool.handler(parsed, {
        client: client as unknown as never,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    expect((caught as ConfirmRequiredError).preview).toContain("0 attendees");
  });

  it("respects a non-default calendar_id when deleting", async () => {
    const event = rawEvent({ id: "evt_alpha", summary: "x" });
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(event),
    });
    const parsed = cancelEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      calendar_id: "cal_work",
      confirm: true,
    }) as Parameters<typeof cancelEventTool.handler>[0];

    await cancelEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.deleteEvent).toHaveBeenCalledWith({
      calendarId: "cal_work",
      eventId: "evt_alpha",
    });
  });
});
