import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { listEventsTool, getEventTool } from "../events-read.js";

type FakeClient = {
  listEvents: ReturnType<typeof vi.fn>;
};

function makeClient(
  result: { items: unknown[]; nextPageToken?: string } = { items: [] },
): FakeClient {
  return {
    listEvents: vi.fn().mockResolvedValue(result),
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

describe("listEventsTool — metadata", () => {
  it("name is list_events with a short description", () => {
    expect(listEventsTool.name).toBe("list_events");
    expect(listEventsTool.description).toBe(
      "List events in a calendar window",
    );
    // 6 tokens ≤ 15 — sanity check.
    expect(listEventsTool.description.split(/\s+/).length).toBeLessThanOrEqual(
      15,
    );
  });

  it("inputSchema is a zod type with documented defaults", () => {
    expect(listEventsTool.inputSchema).toBeInstanceOf(z.ZodType);
    const parsed = listEventsTool.inputSchema.parse({}) as {
      calendar_id: string;
      max_results: number;
    };
    expect(parsed.calendar_id).toBe("primary");
    expect(parsed.max_results).toBe(50);
  });

  it("rejects max_results outside 1..250", () => {
    expect(() =>
      listEventsTool.inputSchema.parse({ max_results: 0 }),
    ).toThrow();
    expect(() =>
      listEventsTool.inputSchema.parse({ max_results: 300 }),
    ).toThrow();
  });
});

describe("listEventsTool — handler", () => {
  it("defaults calendar_id to 'primary' and max_results to 50", async () => {
    const client = makeClient();
    const parsed = listEventsTool.inputSchema.parse({}) as Parameters<
      typeof listEventsTool.handler
    >[0];
    await listEventsTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.listEvents).toHaveBeenCalledWith({
      calendarId: "primary",
      maxResults: 50,
      timeMin: undefined,
      timeMax: undefined,
      q: undefined,
      showDeleted: false,
    });
  });

  it("passes through optional time_min, time_max, query, calendar_id", async () => {
    const client = makeClient();
    const parsed = listEventsTool.inputSchema.parse({
      calendar_id: "cal_personal",
      time_min: "2026-05-13T00:00:00-05:00",
      time_max: "2026-05-14T00:00:00-05:00",
      query: "standup",
      max_results: 25,
    }) as Parameters<typeof listEventsTool.handler>[0];
    await listEventsTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.listEvents).toHaveBeenCalledWith({
      calendarId: "cal_personal",
      timeMin: "2026-05-13T00:00:00-05:00",
      timeMax: "2026-05-14T00:00:00-05:00",
      q: "standup",
      maxResults: 25,
      showDeleted: false,
    });
  });

  it("forwards Wave-2 filters: event_types, private_extended_property, show_deleted", async () => {
    const client = makeClient();
    const parsed = listEventsTool.inputSchema.parse({
      event_types: ["focusTime", "outOfOffice"],
      private_extended_property: { trace_id: "abc-123" },
      show_deleted: true,
    }) as Parameters<typeof listEventsTool.handler>[0];
    await listEventsTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.listEvents).toHaveBeenCalledWith({
      calendarId: "primary",
      maxResults: 50,
      timeMin: undefined,
      timeMax: undefined,
      q: undefined,
      eventTypes: ["focusTime", "outOfOffice"],
      privateExtendedProperty: { trace_id: "abc-123" },
      showDeleted: true,
    });
  });

  it("maps each item via mapEvent and stamps the calendar_id", async () => {
    const client = makeClient({
      items: [rawEvent({ id: "evt_alpha" }), rawEvent({ id: "evt_beta" })],
    });
    const parsed = listEventsTool.inputSchema.parse({
      calendar_id: "cal_work",
    }) as Parameters<typeof listEventsTool.handler>[0];
    const out = await listEventsTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.events).toHaveLength(2);
    expect(out.events[0]?.id).toBe("evt_alpha");
    expect(out.events[1]?.id).toBe("evt_beta");
    expect(out.events[0]?.calendar_id).toBe("cal_work");
    expect(out.events[1]?.calendar_id).toBe("cal_work");
  });

  it("returns next_page_token verbatim when present, null otherwise", async () => {
    const withToken = makeClient({ items: [], nextPageToken: "tok_next" });
    const withoutToken = makeClient({ items: [] });
    const parsed = listEventsTool.inputSchema.parse({}) as Parameters<
      typeof listEventsTool.handler
    >[0];

    const a = await listEventsTool.handler(parsed, {
      client: withToken as unknown as never,
    });
    expect(a.next_page_token).toBe("tok_next");

    const b = await listEventsTool.handler(parsed, {
      client: withoutToken as unknown as never,
    });
    expect(b.next_page_token).toBeNull();
  });
});

// ============================================================================
// getEventTool
// ============================================================================

type FakeGetClient = {
  getEvent: ReturnType<typeof vi.fn>;
};

function makeGetClient(raw: Record<string, unknown>): FakeGetClient {
  return {
    getEvent: vi.fn().mockResolvedValue(raw),
  };
}

describe("getEventTool — metadata", () => {
  it("name + short description + token budget", () => {
    expect(getEventTool.name).toBe("get_event");
    expect(getEventTool.description).toBe("Get one event by ID");
    expect(getEventTool.description.split(/\s+/).length).toBeLessThanOrEqual(
      15,
    );
  });

  it("inputSchema requires event_id and defaults calendar_id to 'primary'", () => {
    expect(() => getEventTool.inputSchema.parse({})).toThrow();
    const parsed = getEventTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as { event_id: string; calendar_id: string };
    expect(parsed.event_id).toBe("evt_alpha");
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("getEventTool — handler", () => {
  it("calls client.getEvent with the parsed args and maps the result", async () => {
    const client = makeGetClient(rawEvent({ id: "evt_alpha" }));
    const parsed = getEventTool.inputSchema.parse({
      event_id: "evt_alpha",
      calendar_id: "cal_personal",
    }) as Parameters<typeof getEventTool.handler>[0];
    const out = await getEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.getEvent).toHaveBeenCalledWith({
      calendarId: "cal_personal",
      eventId: "evt_alpha",
    });
    expect(out.event.id).toBe("evt_alpha");
    expect(out.event.calendar_id).toBe("cal_personal");
  });

  it("defaults calendar_id to 'primary' when omitted", async () => {
    const client = makeGetClient(rawEvent({ id: "evt_alpha" }));
    const parsed = getEventTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as Parameters<typeof getEventTool.handler>[0];
    await getEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.getEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
    });
  });
});
