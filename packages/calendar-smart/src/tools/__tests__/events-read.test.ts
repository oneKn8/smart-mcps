import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { listEventsTool } from "../events-read.js";

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
