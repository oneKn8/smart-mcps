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
};

function makeClient(over: FakeClient = {}): FakeClient {
  return {
    quickAdd: vi.fn().mockResolvedValue({}),
    insertEvent: vi.fn().mockResolvedValue({}),
    patchEvent: vi.fn().mockResolvedValue({}),
    getEvent: vi.fn().mockResolvedValue({}),
    getAccountEmail: vi.fn().mockReturnValue("your-account@gmail.com"),
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

    expect(client.insertEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      body: {
        summary: "Coffee",
        start: { dateTime: "2026-05-13T10:00:00-05:00" },
        end: { dateTime: "2026-05-13T10:30:00-05:00" },
      },
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

    expect(client.insertEvent).toHaveBeenCalledWith({
      calendarId: "cal_work",
      body: {
        summary: "Sync",
        start: { dateTime: "2026-05-13T10:00:00-05:00" },
        end: { dateTime: "2026-05-13T11:00:00-05:00" },
        attendees: [
          { email: "bob@example.test" },
          { email: "carol@example.test" },
        ],
        location: "Conference Room A",
        description: "Weekly check-in",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      },
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
          email: "your-account@gmail.com",
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
            email: "your-account@gmail.com",
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
            email: "your-account@gmail.com",
            responseStatus: "accepted",
            optional: false,
          },
          { email: "bob@example.test", responseStatus: "tentative" },
        ],
      },
    });
    expect(out.event.id).toBe("evt_alpha");
    const me = out.event.attendees.find(
      (a) => a.email === "your-account@gmail.com",
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
          "your-account@gmail.com",
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
      organizer: { email: "your-account@gmail.com", self: true },
      attendees: [
        {
          email: "your-account@gmail.com",
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
          email: "your-account@gmail.com",
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
