import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  ConfirmRequiredError,
  NotFoundError,
  ValidationError,
} from "smart-mcp-core";
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

    // sendUpdates defaults to "none" on update_event (most updates are
    // non-invite-worthy: title fixes, typos, etc.).
    expect(client.patchEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
      body: { summary: "New Title" },
      sendUpdates: "none",
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
      sendUpdates: "none",
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
      sendUpdates: "none",
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
// updateEventTool — Phase 5.5 extended fields
// ---------------------------------------------------------------------------

function bodyFromPatch(client: FakeClient): Record<string, unknown> {
  const call = (client.patchEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
    | { body: Record<string, unknown> }
    | undefined;
  if (!call) throw new Error("patchEvent was not called");
  return call.body;
}

function optsFromPatch(client: FakeClient): Record<string, unknown> {
  const call = (client.patchEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!call) throw new Error("patchEvent was not called");
  return call;
}

describe("updateEventTool — eventType change is forbidden", () => {
  it("throws ValidationError when event_type is provided", async () => {
    const client = makeClient();
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      event_type: "focusTime",
    }) as Parameters<typeof updateEventTool.handler>[0];

    await expect(
      updateEventTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.patchEvent).not.toHaveBeenCalled();
  });

  it("error message names the constraint clearly", async () => {
    const client = makeClient();
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      event_type: "outOfOffice",
    }) as Parameters<typeof updateEventTool.handler>[0];

    await expect(
      updateEventTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toThrow(/cannot change eventType/i);
  });
});

describe("updateEventTool — extended fields", () => {
  it("forwards reminders.overrides + flips useDefault to false", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      reminders: { overrides: [{ method: "email", minutes: 30 }] },
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromPatch(client).reminders).toEqual({
      useDefault: false,
      overrides: [{ method: "email", minutes: 30 }],
    });
  });

  it("attaches conferenceData + conferenceDataVersion=1 when create_meet_link=true", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      create_meet_link: true,
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const opts = optsFromPatch(client);
    expect(opts.conferenceDataVersion).toBe(1);
    const conf = (opts.body as Record<string, unknown>).conferenceData as {
      createRequest: { conferenceSolutionKey: { type: string } };
    };
    expect(conf.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
  });

  it("forwards color_id, visibility, transparency, guests_can_* flags", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      color_id: "9",
      visibility: "confidential",
      transparency: "transparent",
      guests_can_invite_others: false,
      guests_can_modify: true,
      guests_can_see_other_guests: false,
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const body = bodyFromPatch(client);
    expect(body.colorId).toBe("9");
    expect(body.visibility).toBe("confidential");
    expect(body.transparency).toBe("transparent");
    expect(body.guestsCanInviteOthers).toBe(false);
    expect(body.guestsCanModify).toBe(true);
    expect(body.guestsCanSeeOtherGuests).toBe(false);
  });

  it("forwards source { url, title } and extended_properties", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      source: { url: "https://docs.example.test/x", title: "X" },
      extended_properties: {
        private: { trace_id: "xyz" },
        shared: { project: "beta" },
      },
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const body = bodyFromPatch(client);
    expect(body.source).toEqual({
      url: "https://docs.example.test/x",
      title: "X",
    });
    expect(body.extendedProperties).toEqual({
      private: { trace_id: "xyz" },
      shared: { project: "beta" },
    });
  });

  it("attaches focusTimeProperties when focus_time provided (no event_type required)", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      focus_time: { decline_message: "Updated message" },
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromPatch(client).focusTimeProperties).toEqual({
      declineMessage: "Updated message",
    });
  });

  it("attaches working_location.customLocation { label } on patch", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      working_location: {
        type: "customLocation",
        custom_label: "Library 2nd Floor",
      },
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromPatch(client).workingLocationProperties).toEqual({
      customLocation: { label: "Library 2nd Floor" },
    });
  });

  it("accepts attendees as the rich object form on patch", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      attendees: [
        { email: "bob@example.test", optional: true },
        { email: "carol@example.test", response: "tentative" },
      ],
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromPatch(client).attendees).toEqual([
      { email: "bob@example.test", optional: true },
      { email: "carol@example.test", responseStatus: "tentative" },
    ]);
  });
});

describe("updateEventTool — send_updates default", () => {
  it("defaults to 'none' on update (different from create_event default)", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      summary: "Renamed",
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(optsFromPatch(client).sendUpdates).toBe("none");
  });

  it("forwards an explicit send_updates value verbatim", async () => {
    const client = makeClient({
      patchEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = updateEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      summary: "x",
      send_updates: "all",
    }) as Parameters<typeof updateEventTool.handler>[0];

    await updateEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(optsFromPatch(client).sendUpdates).toBe("all");
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
