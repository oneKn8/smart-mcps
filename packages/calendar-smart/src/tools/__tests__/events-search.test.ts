import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { searchEventsTool } from "../events-search.js";

type FakeClient = {
  listEvents: ReturnType<typeof vi.fn>;
};

function makeClient(
  result: { items: unknown[]; nextPageToken?: string } = { items: [] },
): FakeClient {
  return { listEvents: vi.fn().mockResolvedValue(result) };
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

describe("searchEventsTool — metadata", () => {
  it("name and short description fit the budget", () => {
    expect(searchEventsTool.name).toBe("search_events");
    expect(
      searchEventsTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema is a zod type with documented defaults", () => {
    expect(searchEventsTool.inputSchema).toBeInstanceOf(z.ZodType);
    const parsed = searchEventsTool.inputSchema.parse({}) as {
      calendar_id: string;
      max_results: number;
    };
    expect(parsed.calendar_id).toBe("primary");
    expect(parsed.max_results).toBe(25);
  });
});

describe("searchEventsTool — handler", () => {
  it("forwards query as q and defaults calendar_id, max_results", async () => {
    const client = makeClient();
    const parsed = searchEventsTool.inputSchema.parse({
      query: "standup",
    }) as Parameters<typeof searchEventsTool.handler>[0];

    await searchEventsTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listEvents).toHaveBeenCalledWith({
      calendarId: "primary",
      maxResults: 25,
      q: "standup",
    });
  });

  it("forwards time_min, time_max, event_types, private_extended_property", async () => {
    const client = makeClient();
    const parsed = searchEventsTool.inputSchema.parse({
      query: "ooo",
      calendar_id: "cal_work",
      time_min: "2026-05-13T00:00:00Z",
      time_max: "2026-05-20T00:00:00Z",
      event_types: ["outOfOffice"],
      private_extended_property: { trace_id: "abc-123", project: "alpha" },
      max_results: 100,
    }) as Parameters<typeof searchEventsTool.handler>[0];

    await searchEventsTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listEvents).toHaveBeenCalledWith({
      calendarId: "cal_work",
      maxResults: 100,
      q: "ooo",
      timeMin: "2026-05-13T00:00:00Z",
      timeMax: "2026-05-20T00:00:00Z",
      eventTypes: ["outOfOffice"],
      privateExtendedProperty: { trace_id: "abc-123", project: "alpha" },
    });
  });

  it("does not require query (filter-only search is valid)", async () => {
    const client = makeClient();
    const parsed = searchEventsTool.inputSchema.parse({
      event_types: ["focusTime"],
    }) as Parameters<typeof searchEventsTool.handler>[0];

    await searchEventsTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listEvents).toHaveBeenCalledWith({
      calendarId: "primary",
      maxResults: 25,
      eventTypes: ["focusTime"],
    });
  });

  it("maps each item to SlimEvent and returns next_page_token", async () => {
    const client = makeClient({
      items: [rawEvent({ id: "evt_alpha" }), rawEvent({ id: "evt_beta" })],
      nextPageToken: "tok_next",
    });
    const parsed = searchEventsTool.inputSchema.parse({
      query: "x",
    }) as Parameters<typeof searchEventsTool.handler>[0];

    const out = await searchEventsTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(out.events).toHaveLength(2);
    expect(out.events[0]?.id).toBe("evt_alpha");
    expect(out.next_page_token).toBe("tok_next");
  });

  it("next_page_token is null when not present", async () => {
    const client = makeClient({ items: [] });
    const parsed = searchEventsTool.inputSchema.parse({
      query: "x",
    }) as Parameters<typeof searchEventsTool.handler>[0];

    const out = await searchEventsTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.next_page_token).toBeNull();
  });
});
