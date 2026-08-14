import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  quickAddTool,
  createEventTool,
  respondToEventTool,
} from "../events-create.js";

type FakeClient = {
  quickAdd?: ReturnType<typeof vi.fn>;
  insertEvent?: ReturnType<typeof vi.fn>;
  patchEvent?: ReturnType<typeof vi.fn>;
  getEvent?: ReturnType<typeof vi.fn>;
  getAccountEmail?: ReturnType<typeof vi.fn>;
  ensureTimeZone?: ReturnType<typeof vi.fn>;
};

function makeClient(over: FakeClient = {}): FakeClient {
  return {
    quickAdd: vi.fn().mockResolvedValue({}),
    insertEvent: vi.fn().mockResolvedValue({}),
    patchEvent: vi.fn().mockResolvedValue({}),
    getEvent: vi.fn().mockResolvedValue({}),
    getAccountEmail: vi.fn().mockReturnValue("alpha-account@gmail.com"),
    ensureTimeZone: vi.fn().mockResolvedValue("America/Chicago"),
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
// quickAddTool
// ---------------------------------------------------------------------------

describe("quickAddTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(quickAddTool.name).toBe("quick_add");
    expect(
      quickAddTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires text and defaults calendar_id to 'primary'", () => {
    expect(() => quickAddTool.inputSchema.parse({})).toThrow();
    const parsed = quickAddTool.inputSchema.parse({ text: "Lunch noon" }) as {
      text: string;
      calendar_id: string;
    };
    expect(parsed.text).toBe("Lunch noon");
    expect(parsed.calendar_id).toBe("primary");
  });

  it("inputSchema is a zod type", () => {
    expect(quickAddTool.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("quickAddTool — handler", () => {
  it("calls client.quickAdd with text + calendar_id and returns mapped event", async () => {
    const client = makeClient({
      quickAdd: vi
        .fn()
        .mockResolvedValue(rawEvent({ id: "evt_quick", summary: "Lunch" })),
    });
    const parsed = quickAddTool.inputSchema.parse({
      text: "Lunch tomorrow at noon",
      calendar_id: "cal_personal",
    }) as Parameters<typeof quickAddTool.handler>[0];

    const out = await quickAddTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.quickAdd).toHaveBeenCalledWith({
      calendarId: "cal_personal",
      text: "Lunch tomorrow at noon",
    });
    expect(out.event.id).toBe("evt_quick");
    expect(out.event.summary).toBe("Lunch");
    expect(out.event.calendar_id).toBe("cal_personal");
  });

  it("defaults calendar_id to 'primary' when omitted", async () => {
    const client = makeClient({
      quickAdd: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = quickAddTool.inputSchema.parse({
      text: "Coffee at 3pm",
    }) as Parameters<typeof quickAddTool.handler>[0];
    await quickAddTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.quickAdd).toHaveBeenCalledWith({
      calendarId: "primary",
      text: "Coffee at 3pm",
    });
  });
});

// ---------------------------------------------------------------------------
// createEventTool
// ---------------------------------------------------------------------------

describe("createEventTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(createEventTool.name).toBe("create_event");
    expect(
      createEventTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires summary, start, end", () => {
    expect(() => createEventTool.inputSchema.parse({})).toThrow();
    expect(() =>
      createEventTool.inputSchema.parse({ summary: "x" }),
    ).toThrow();
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
    }) as { calendar_id: string };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("createEventTool — handler", () => {
  it("builds the minimum required body when no optional fields are provided", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent({ id: "evt_new" })),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "Coffee",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
    }) as Parameters<typeof createEventTool.handler>[0];

    const out = await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });

    // sendUpdates defaults to "none" when there are no attendees.
    expect(client.insertEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      body: {
        summary: "Coffee",
        start: { dateTime: "2026-05-13T10:00:00-05:00" },
        end: { dateTime: "2026-05-13T10:30:00-05:00" },
      },
      sendUpdates: "none",
    });
    expect(out.event.id).toBe("evt_new");
    expect(out.event.calendar_id).toBe("primary");
  });

  it("maps attendees to {email} objects, includes location, description, recurrence", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent({ id: "evt_rich" })),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "Sync",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T11:00:00-05:00",
      attendees: ["bob@example.test", "carol@example.test"],
      location: "Conference Room A",
      description: "Weekly check-in",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      calendar_id: "cal_work",
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });

    // With attendees present, sendUpdates defaults to "all". With recurrence,
    // start/end carry the resolved IANA tz (Google requires it for DST).
    expect(client.insertEvent).toHaveBeenCalledWith({
      calendarId: "cal_work",
      body: {
        summary: "Sync",
        start: { dateTime: "2026-05-13T10:00:00-05:00", timeZone: "America/Chicago" },
        end: { dateTime: "2026-05-13T11:00:00-05:00", timeZone: "America/Chicago" },
        attendees: [
          { email: "bob@example.test" },
          { email: "carol@example.test" },
        ],
        location: "Conference Room A",
        description: "Weekly check-in",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      },
      sendUpdates: "all",
    });
  });

  it("strips undefined optional fields from the body", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      location: "Office",
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });

    const call = (client.insertEvent as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { body: Record<string, unknown> };
    expect(Object.keys(call.body).sort()).toEqual([
      "end",
      "location",
      "start",
      "summary",
    ]);
  });
});

// ---------------------------------------------------------------------------
// createEventTool — Phase 5.5 extended fields
// ---------------------------------------------------------------------------

function bodyFromInsert(client: FakeClient): Record<string, unknown> {
  const call = (client.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
    | { body: Record<string, unknown> }
    | undefined;
  if (!call) throw new Error("insertEvent was not called");
  return call.body;
}

function optsFromInsert(client: FakeClient): Record<string, unknown> {
  const call = (client.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!call) throw new Error("insertEvent was not called");
  return call;
}

describe("createEventTool — reminders", () => {
  it("forwards { useDefault: false, overrides: [...] } when overrides provided", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      reminders: {
        overrides: [
          { method: "popup", minutes: 10 },
          { method: "email", minutes: 60 },
        ],
      },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromInsert(client).reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 10 },
        { method: "email", minutes: 60 },
      ],
    });
  });

  it("respects use_default=true even when overrides are also provided", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      reminders: {
        use_default: true,
        overrides: [{ method: "popup", minutes: 10 }],
      },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromInsert(client).reminders).toEqual({
      useDefault: true,
      overrides: [{ method: "popup", minutes: 10 }],
    });
  });

  it("rejects more than 5 reminder overrides", () => {
    expect(() =>
      createEventTool.inputSchema.parse({
        summary: "x",
        start: "2026-05-13T10:00:00-05:00",
        end: "2026-05-13T10:30:00-05:00",
        reminders: {
          overrides: Array.from({ length: 6 }, (_, i) => ({
            method: "popup" as const,
            minutes: i,
          })),
        },
      }),
    ).toThrow();
  });

  it("rejects reminder minutes above 40320 (4 weeks)", () => {
    expect(() =>
      createEventTool.inputSchema.parse({
        summary: "x",
        start: "2026-05-13T10:00:00-05:00",
        end: "2026-05-13T10:30:00-05:00",
        reminders: {
          overrides: [{ method: "popup", minutes: 40321 }],
        },
      }),
    ).toThrow();
  });
});

describe("createEventTool — Meet link auto-creation", () => {
  it("attaches conferenceData.createRequest with hangoutsMeet and conferenceDataVersion=1", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      create_meet_link: true,
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const opts = optsFromInsert(client);
    const conf = (opts.body as Record<string, unknown>).conferenceData as {
      createRequest: {
        requestId: unknown;
        conferenceSolutionKey: { type: string };
      };
    };
    expect(conf.createRequest.conferenceSolutionKey).toEqual({
      type: "hangoutsMeet",
    });
    expect(typeof conf.createRequest.requestId).toBe("string");
    expect((conf.createRequest.requestId as string).length).toBeGreaterThan(0);
    expect(opts.conferenceDataVersion).toBe(1);
  });

  it("does NOT attach conferenceData when create_meet_link is omitted", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const opts = optsFromInsert(client);
    expect((opts.body as Record<string, unknown>).conferenceData).toBeUndefined();
    expect(opts.conferenceDataVersion).toBeUndefined();
  });
});

describe("createEventTool — color/visibility/transparency/guest perms", () => {
  it("forwards color_id, visibility, transparency, and the three guests_can_* flags", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      color_id: "5",
      visibility: "private",
      transparency: "transparent",
      guests_can_invite_others: false,
      guests_can_modify: true,
      guests_can_see_other_guests: false,
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const body = bodyFromInsert(client);
    expect(body.colorId).toBe("5");
    expect(body.visibility).toBe("private");
    expect(body.transparency).toBe("transparent");
    expect(body.guestsCanInviteOthers).toBe(false);
    expect(body.guestsCanModify).toBe(true);
    expect(body.guestsCanSeeOtherGuests).toBe(false);
  });
});

describe("createEventTool — source / extended_properties", () => {
  it("forwards source.url and source.title", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      source: { url: "https://docs.example.test/spec", title: "Spec" },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromInsert(client).source).toEqual({
      url: "https://docs.example.test/spec",
      title: "Spec",
    });
  });

  it("rejects a non-http(s) source URL", () => {
    expect(() =>
      createEventTool.inputSchema.parse({
        summary: "x",
        start: "2026-05-13T10:00:00-05:00",
        end: "2026-05-13T10:30:00-05:00",
        source: { url: "ftp://example.test/file" },
      }),
    ).toThrow();
  });

  it("forwards extended_properties.private and .shared as Google's nested shape", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      extended_properties: {
        private: { trace_id: "abc" },
        shared: { project: "alpha" },
      },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromInsert(client).extendedProperties).toEqual({
      private: { trace_id: "abc" },
      shared: { project: "alpha" },
    });
  });

  it("omits extendedProperties entirely when both private and shared are empty", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      extended_properties: { private: {}, shared: {} },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromInsert(client).extendedProperties).toBeUndefined();
  });
});

describe("createEventTool — event_type focus_time / out_of_office / working_location / birthday", () => {
  it("focusTime + focus_time builds focusTimeProperties with autoDeclineMode + chatStatus", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "Deep Work",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T12:00:00-05:00",
      event_type: "focusTime",
      focus_time: {
        auto_decline: "declineAllConflictingInvitations",
        decline_message: "Heads down — back at noon.",
        chat_status: "doNotDisturb",
      },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const body = bodyFromInsert(client);
    expect(body.eventType).toBe("focusTime");
    expect(body.focusTimeProperties).toEqual({
      autoDeclineMode: "declineAllConflictingInvitations",
      declineMessage: "Heads down — back at noon.",
      chatStatus: "doNotDisturb",
    });
  });

  it("outOfOffice + out_of_office builds outOfOfficeProperties", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "OOO",
      start: "2026-05-13",
      end: "2026-05-14",
      event_type: "outOfOffice",
      out_of_office: {
        auto_decline: "declineAllConflictingInvitations",
        decline_message: "Out today.",
      },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const body = bodyFromInsert(client);
    expect(body.eventType).toBe("outOfOffice");
    expect(body.outOfOfficeProperties).toEqual({
      autoDeclineMode: "declineAllConflictingInvitations",
      declineMessage: "Out today.",
    });
  });

  it("workingLocation + working_location.type=homeOffice yields { homeOffice: {} }", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "WFH",
      start: "2026-05-13",
      end: "2026-05-14",
      event_type: "workingLocation",
      working_location: { type: "homeOffice" },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const body = bodyFromInsert(client);
    expect(body.eventType).toBe("workingLocation");
    expect(body.workingLocationProperties).toEqual({ homeOffice: {} });
  });

  it("workingLocation + customLocation + custom_label yields { customLocation: { label } }", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "Cafe",
      start: "2026-05-13",
      end: "2026-05-14",
      event_type: "workingLocation",
      working_location: { type: "customLocation", custom_label: "The Wild Bean" },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const body = bodyFromInsert(client);
    expect(body.workingLocationProperties).toEqual({
      customLocation: { label: "The Wild Bean" },
    });
  });

  it("birthday + birthday properties forwards type, contact, customTypeName", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "Mom's Birthday",
      start: "2026-05-15",
      end: "2026-05-16",
      event_type: "birthday",
      birthday: {
        type: "birthday",
        contact: "people/c123",
      },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const body = bodyFromInsert(client);
    expect(body.eventType).toBe("birthday");
    expect(body.birthdayProperties).toEqual({
      type: "birthday",
      contact: "people/c123",
    });
  });

  it("event_type=default does NOT add an eventType field (Google's implicit default)", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      event_type: "default",
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromInsert(client).eventType).toBeUndefined();
  });

  it("does not attach focusTimeProperties when event_type is not focusTime", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      // No event_type set, but focus_time is — should be silently ignored.
      focus_time: { auto_decline: "declineAllConflictingInvitations" },
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromInsert(client).focusTimeProperties).toBeUndefined();
  });
});

describe("createEventTool — attendees union", () => {
  it("accepts attendees as an array of objects with optional/response/resource flags", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      attendees: [
        { email: "bob@example.test", optional: true },
        { email: "carol@example.test", response: "accepted" },
        { email: "room-conf-a@example.test", resource: true },
      ],
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromInsert(client).attendees).toEqual([
      { email: "bob@example.test", optional: true },
      { email: "carol@example.test", responseStatus: "accepted" },
      { email: "room-conf-a@example.test", resource: true },
    ]);
  });

  it("string attendees still map to bare { email } objects (back-compat)", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      attendees: ["bob@example.test"],
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(bodyFromInsert(client).attendees).toEqual([
      { email: "bob@example.test" },
    ]);
  });
});

describe("createEventTool — send_updates query param wiring", () => {
  it("an explicit send_updates wins over the attendee-based default", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      attendees: ["bob@example.test"],
      send_updates: "none",
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(optsFromInsert(client).sendUpdates).toBe("none");
  });

  it("forwards send_updates=externalOnly verbatim when provided", async () => {
    const client = makeClient({
      insertEvent: vi.fn().mockResolvedValue(rawEvent()),
    });
    const parsed = createEventTool.inputSchema.parse({
      summary: "x",
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T10:30:00-05:00",
      attendees: ["bob@example.test"],
      send_updates: "externalOnly",
    }) as Parameters<typeof createEventTool.handler>[0];

    await createEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(optsFromInsert(client).sendUpdates).toBe("externalOnly");
  });
});

// ---------------------------------------------------------------------------
// respondToEventTool
// ---------------------------------------------------------------------------

describe("respondToEventTool — metadata", () => {
  it("name and description fit the budget", () => {
    expect(respondToEventTool.name).toBe("respond_to_event");
    expect(
      respondToEventTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires event_id and response, defaults calendar_id", () => {
    expect(() => respondToEventTool.inputSchema.parse({})).toThrow();
    expect(() =>
      respondToEventTool.inputSchema.parse({ event_id: "x" }),
    ).toThrow();
    expect(() =>
      respondToEventTool.inputSchema.parse({
        event_id: "x",
        response: "maybe",
      }),
    ).toThrow();
    const parsed = respondToEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      response: "accepted",
    }) as { calendar_id: string };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("respondToEventTool — handler", () => {
  function eventWithAttendees(): Record<string, unknown> {
    return rawEvent({
      id: "evt_alpha",
      organizer: { email: "host@example.test" },
      attendees: [
        { email: "host@example.test", responseStatus: "accepted" },
        {
          email: "alpha-account@gmail.com",
          responseStatus: "needsAction",
          optional: false,
        },
        { email: "bob@example.test", responseStatus: "tentative" },
      ],
    });
  }

  it("updates only the calling user's attendee record and PATCHes the event", async () => {
    const event = eventWithAttendees();
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(event),
      patchEvent: vi.fn().mockResolvedValue({
        ...event,
        attendees: [
          { email: "host@example.test", responseStatus: "accepted" },
          {
            email: "alpha-account@gmail.com",
            responseStatus: "accepted",
            optional: false,
          },
          { email: "bob@example.test", responseStatus: "tentative" },
        ],
      }),
    });
    const parsed = respondToEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      response: "accepted",
    }) as Parameters<typeof respondToEventTool.handler>[0];

    const out = await respondToEventTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.getEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
    });
    expect(client.patchEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
      body: {
        attendees: [
          { email: "host@example.test", responseStatus: "accepted" },
          {
            email: "alpha-account@gmail.com",
            responseStatus: "accepted",
            optional: false,
          },
          { email: "bob@example.test", responseStatus: "tentative" },
        ],
      },
    });
    expect(out.event.id).toBe("evt_alpha");
    const me = out.event.attendees.find(
      (a) => a.email === "alpha-account@gmail.com",
    );
    expect(me?.response).toBe("accepted");
  });

  it("supports declined and tentative responses", async () => {
    for (const response of ["declined", "tentative"] as const) {
      const event = eventWithAttendees();
      const client = makeClient({
        getEvent: vi.fn().mockResolvedValue(event),
        patchEvent: vi.fn().mockResolvedValue(event),
      });
      const parsed = respondToEventTool.inputSchema.parse({
        event_id: "evt_alpha",
        response,
      }) as Parameters<typeof respondToEventTool.handler>[0];

      await respondToEventTool.handler(parsed, {
        client: client as unknown as never,
      });
      const call = (client.patchEvent as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as { body: { attendees: { responseStatus: string }[] } };
      const me = call.body.attendees.find(
        (a) =>
          (a as unknown as { email: string }).email ===
          "alpha-account@gmail.com",
      );
      expect(me?.responseStatus).toBe(response);
    }
  });

  it("throws when the user is not an attendee", async () => {
    const event = rawEvent({
      id: "evt_alpha",
      organizer: { email: "host@example.test" },
      attendees: [
        { email: "host@example.test", responseStatus: "accepted" },
        { email: "bob@example.test", responseStatus: "tentative" },
      ],
    });
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(event),
    });
    const parsed = respondToEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      response: "accepted",
    }) as Parameters<typeof respondToEventTool.handler>[0];

    await expect(
      respondToEventTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toThrow(/not an attendee/i);
    expect(client.patchEvent).not.toHaveBeenCalled();
  });

  it("throws when the user is the organizer (organizer.self === true)", async () => {
    const event = rawEvent({
      id: "evt_alpha",
      organizer: { email: "alpha-account@gmail.com", self: true },
      attendees: [
        {
          email: "alpha-account@gmail.com",
          responseStatus: "accepted",
        },
        { email: "bob@example.test", responseStatus: "needsAction" },
      ],
    });
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(event),
    });
    const parsed = respondToEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      response: "tentative",
    }) as Parameters<typeof respondToEventTool.handler>[0];

    await expect(
      respondToEventTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toThrow(/not an attendee/i);
    expect(client.patchEvent).not.toHaveBeenCalled();
  });

  it("respects a non-default calendar_id", async () => {
    const event = rawEvent({
      id: "evt_alpha",
      attendees: [
        {
          email: "alpha-account@gmail.com",
          responseStatus: "needsAction",
        },
      ],
    });
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue(event),
      patchEvent: vi.fn().mockResolvedValue(event),
    });
    const parsed = respondToEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      response: "accepted",
      calendar_id: "cal_work",
    }) as Parameters<typeof respondToEventTool.handler>[0];

    await respondToEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.getEvent).toHaveBeenCalledWith({
      calendarId: "cal_work",
      eventId: "evt_alpha",
    });
    expect(client.patchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: "cal_work" }),
    );
  });
});
