import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { z } from "zod";
import {
  dailyAgendaTool,
  weeklyAgendaTool,
  nextEventTool,
} from "../events-agenda.js";

type FakeClient = {
  ensureTimeZone: ReturnType<typeof vi.fn>;
  listEvents: ReturnType<typeof vi.fn>;
};

function makeClient(opts: {
  tz?: string;
  items?: unknown[];
  nextPageToken?: string;
} = {}): FakeClient {
  return {
    ensureTimeZone: vi.fn().mockResolvedValue(opts.tz ?? "America/Chicago"),
    listEvents: vi.fn().mockResolvedValue({
      items: opts.items ?? [],
      nextPageToken: opts.nextPageToken,
    }),
  };
}

function rawTimedEvent(
  id: string,
  start = "2026-05-13T10:00:00-05:00",
  end = "2026-05-13T10:30:00-05:00",
): Record<string, unknown> {
  return {
    id,
    summary: `Meeting ${id}`,
    start: { dateTime: start },
    end: { dateTime: end },
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
    status: "confirmed",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Pin to 2026-05-13T10:00:00-05:00 ≡ 2026-05-13T15:00:00Z
  vi.setSystemTime(new Date("2026-05-13T15:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// daily_agenda
// ============================================================================

describe("dailyAgendaTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(dailyAgendaTool.name).toBe("daily_agenda");
    expect(dailyAgendaTool.description).toBe("Events for a single day");
    expect(
      dailyAgendaTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
    expect(dailyAgendaTool.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults calendar_id to 'primary' when omitted", () => {
    const parsed = dailyAgendaTool.inputSchema.parse({}) as {
      calendar_id: string;
    };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("dailyAgendaTool — handler", () => {
  it("defaults date to today-in-tz (NOT UTC) and bounds the window in tz", async () => {
    const client = makeClient({ tz: "America/Chicago" });
    const parsed = dailyAgendaTool.inputSchema.parse({}) as Parameters<
      typeof dailyAgendaTool.handler
    >[0];
    const out = await dailyAgendaTool.handler(parsed, {
      client: client as unknown as never,
    });
    // 2026-05-13T15:00Z → Chicago is 10:00 on 2026-05-13
    expect(out.date).toBe("2026-05-13");
    expect(client.listEvents).toHaveBeenCalledTimes(1);
    const args = client.listEvents.mock.calls[0]?.[0] as {
      calendarId: string;
      timeMin: string;
      timeMax: string;
    };
    // Chicago midnight on 2026-05-13 is 05:00Z (CDT, UTC-5). Output uses
    // tz-offset ISO format.
    expect(args.calendarId).toBe("primary");
    expect(args.timeMin).toBe("2026-05-13T00:00:00-05:00");
    expect(args.timeMax).toBe("2026-05-14T00:00:00-05:00");
  });

  it("uses today-in-Dhaka when tz is Asia/Dhaka (different calendar date than UTC)", async () => {
    // 2026-05-13T15:00Z is 21:00 in Dhaka — same day; pin a tricky time.
    vi.setSystemTime(new Date("2026-05-12T20:00:00.000Z"));
    const client = makeClient({ tz: "Asia/Dhaka" });
    const parsed = dailyAgendaTool.inputSchema.parse({}) as Parameters<
      typeof dailyAgendaTool.handler
    >[0];
    const out = await dailyAgendaTool.handler(parsed, {
      client: client as unknown as never,
    });
    // 2026-05-12T20:00Z → Dhaka is 02:00 on 2026-05-13.
    expect(out.date).toBe("2026-05-13");
    const args = client.listEvents.mock.calls[0]?.[0] as {
      timeMin: string;
      timeMax: string;
    };
    expect(args.timeMin).toBe("2026-05-13T00:00:00+06:00");
    expect(args.timeMax).toBe("2026-05-14T00:00:00+06:00");
  });

  it("honors an explicit date input", async () => {
    const client = makeClient({ tz: "America/Chicago" });
    const parsed = dailyAgendaTool.inputSchema.parse({
      date: "2026-06-01",
    }) as Parameters<typeof dailyAgendaTool.handler>[0];
    const out = await dailyAgendaTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.date).toBe("2026-06-01");
    const args = client.listEvents.mock.calls[0]?.[0] as {
      timeMin: string;
      timeMax: string;
    };
    expect(args.timeMin).toBe("2026-06-01T00:00:00-05:00");
    expect(args.timeMax).toBe("2026-06-02T00:00:00-05:00");
  });

  it("maps each item via mapEvent into the events array", async () => {
    const client = makeClient({
      tz: "America/Chicago",
      items: [rawTimedEvent("evt_alpha"), rawTimedEvent("evt_beta")],
    });
    const parsed = dailyAgendaTool.inputSchema.parse({
      calendar_id: "cal_personal",
    }) as Parameters<typeof dailyAgendaTool.handler>[0];
    const out = await dailyAgendaTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.events).toHaveLength(2);
    expect(out.events[0]?.id).toBe("evt_alpha");
    expect(out.events[0]?.calendar_id).toBe("cal_personal");
  });
});

// ============================================================================
// weekly_agenda
// ============================================================================

describe("weeklyAgendaTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(weeklyAgendaTool.name).toBe("weekly_agenda");
    expect(weeklyAgendaTool.description).toBe("Events for a Mon-Sun week");
    expect(
      weeklyAgendaTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });
});

describe("weeklyAgendaTool — handler", () => {
  it("Monday-based week: Wed 2026-05-13 → 2026-05-11..2026-05-18 in Chicago", async () => {
    const client = makeClient({ tz: "America/Chicago" });
    const parsed = weeklyAgendaTool.inputSchema.parse({}) as Parameters<
      typeof weeklyAgendaTool.handler
    >[0];
    const out = await weeklyAgendaTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.week_start).toBe("2026-05-11");
    expect(out.week_end).toBe("2026-05-18");
    const args = client.listEvents.mock.calls[0]?.[0] as {
      timeMin: string;
      timeMax: string;
    };
    expect(args.timeMin).toBe("2026-05-11T00:00:00-05:00");
    expect(args.timeMax).toBe("2026-05-18T00:00:00-05:00");
  });

  it("explicit week_of inside the Monday..Sunday range yields the same bounds", async () => {
    const client = makeClient({ tz: "America/Chicago" });
    const parsed = weeklyAgendaTool.inputSchema.parse({
      week_of: "2026-05-17", // Sunday
    }) as Parameters<typeof weeklyAgendaTool.handler>[0];
    const out = await weeklyAgendaTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.week_start).toBe("2026-05-11");
    expect(out.week_end).toBe("2026-05-18");
  });

  it("maps items into events with calendar_id stamped", async () => {
    const client = makeClient({
      tz: "America/Chicago",
      items: [rawTimedEvent("evt_alpha")],
    });
    const parsed = weeklyAgendaTool.inputSchema.parse({
      calendar_id: "cal_work",
    }) as Parameters<typeof weeklyAgendaTool.handler>[0];
    const out = await weeklyAgendaTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.calendar_id).toBe("cal_work");
  });
});

// ============================================================================
// next_event
// ============================================================================

describe("nextEventTool — metadata", () => {
  it("name + description + token budget", () => {
    expect(nextEventTool.name).toBe("next_event");
    expect(nextEventTool.description).toBe("Next upcoming event");
    expect(
      nextEventTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("defaults within_hours to 24 and calendar_id to 'primary'", () => {
    const parsed = nextEventTool.inputSchema.parse({}) as {
      within_hours: number;
      calendar_id: string;
    };
    expect(parsed.within_hours).toBe(24);
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("nextEventTool — handler", () => {
  it("queries listEvents with maxResults=1 and timeMin=now in tz", async () => {
    const client = makeClient({ tz: "America/Chicago" });
    const parsed = nextEventTool.inputSchema.parse({}) as Parameters<
      typeof nextEventTool.handler
    >[0];
    await nextEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.listEvents).toHaveBeenCalledTimes(1);
    const args = client.listEvents.mock.calls[0]?.[0] as {
      calendarId: string;
      timeMin: string;
      timeMax: string;
      maxResults: number;
    };
    expect(args.calendarId).toBe("primary");
    expect(args.maxResults).toBe(1);
    // Now is 2026-05-13T15:00Z → Chicago 10:00-05:00
    expect(args.timeMin).toBe("2026-05-13T10:00:00-05:00");
    // Default within_hours=24 → +24h later
    expect(args.timeMax).toBe("2026-05-14T10:00:00-05:00");
  });

  it("honors a custom within_hours window", async () => {
    const client = makeClient({ tz: "America/Chicago" });
    const parsed = nextEventTool.inputSchema.parse({
      within_hours: 2,
    }) as Parameters<typeof nextEventTool.handler>[0];
    await nextEventTool.handler(parsed, {
      client: client as unknown as never,
    });
    const args = client.listEvents.mock.calls[0]?.[0] as {
      timeMin: string;
      timeMax: string;
    };
    expect(args.timeMin).toBe("2026-05-13T10:00:00-05:00");
    expect(args.timeMax).toBe("2026-05-13T12:00:00-05:00");
  });

  it("returns the first item mapped, or null when no items", async () => {
    const withItems = makeClient({
      tz: "America/Chicago",
      items: [rawTimedEvent("evt_alpha")],
    });
    const empty = makeClient({ tz: "America/Chicago" });

    const parsed = nextEventTool.inputSchema.parse({}) as Parameters<
      typeof nextEventTool.handler
    >[0];

    const a = await nextEventTool.handler(parsed, {
      client: withItems as unknown as never,
    });
    expect(a.event?.id).toBe("evt_alpha");
    expect(a.event?.calendar_id).toBe("primary");

    const b = await nextEventTool.handler(parsed, {
      client: empty as unknown as never,
    });
    expect(b.event).toBeNull();
  });
});
