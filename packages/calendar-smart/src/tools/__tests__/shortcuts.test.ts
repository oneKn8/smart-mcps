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
  dailyBriefTool,
  weeklyBriefTool,
} from "../shortcuts.js";

// ----------------------------------------------------------------------------
// shared fake-client + fixtures
// ----------------------------------------------------------------------------

type FakeClient = {
  ensureTimeZone: ReturnType<typeof vi.fn>;
  listEvents: ReturnType<typeof vi.fn>;
  freeBusy?: ReturnType<typeof vi.fn>;
  getEvent?: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    ensureTimeZone: vi.fn().mockResolvedValue("America/Chicago"),
    listEvents: vi.fn().mockResolvedValue({ items: [] }),
    ...over,
  };
}

function rawTimedEvent(
  id: string,
  start: string,
  end: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    summary: `Event ${id}`,
    start: { dateTime: start },
    end: { dateTime: end },
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
    status: "confirmed",
    ...over,
  };
}

function rawAllDayEvent(
  id: string,
  date: string,
  endDate: string,
): Record<string, unknown> {
  return {
    id,
    summary: `All-day ${id}`,
    start: { date },
    end: { date: endDate },
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
    status: "confirmed",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Pin to 2026-05-13T15:00Z = 2026-05-13 10:00 Chicago.
  vi.setSystemTime(new Date("2026-05-13T15:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// dailyBriefTool
// ============================================================================

describe("dailyBriefTool — metadata", () => {
  it("name + token budget", () => {
    expect(dailyBriefTool.name).toBe("daily_brief");
    expect(
      dailyBriefTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
    expect(dailyBriefTool.description.length).toBeGreaterThan(0);
    expect(dailyBriefTool.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults calendar_id to 'primary' when omitted", () => {
    const parsed = dailyBriefTool.inputSchema.parse({}) as {
      calendar_id: string;
    };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("dailyBriefTool — handler", () => {
  it("empty day returns total 0 and null conflict + null biggest_free_block", async () => {
    const client = makeClient();
    const parsed = dailyBriefTool.inputSchema.parse({}) as Parameters<
      typeof dailyBriefTool.handler
    >[0];
    const out = await dailyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.date).toBe("2026-05-13");
    expect(out.total).toBe(0);
    expect(out.events).toEqual([]);
    expect(out.first_conflict).toBeNull();
    // Full empty day = 1440 minute free block.
    expect(out.biggest_free_block).not.toBeNull();
    expect(out.biggest_free_block?.duration_minutes).toBe(24 * 60);
  });

  it("honors explicit date input and stamps it back", async () => {
    const client = makeClient();
    const parsed = dailyBriefTool.inputSchema.parse({
      date: "2026-06-01",
    }) as Parameters<typeof dailyBriefTool.handler>[0];
    const out = await dailyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.date).toBe("2026-06-01");
  });

  it("returns only first 3 events when day has > 3", async () => {
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({
        items: [
          rawTimedEvent("a", "2026-05-13T09:00:00-05:00", "2026-05-13T09:30:00-05:00"),
          rawTimedEvent("b", "2026-05-13T10:00:00-05:00", "2026-05-13T10:30:00-05:00"),
          rawTimedEvent("c", "2026-05-13T11:00:00-05:00", "2026-05-13T11:30:00-05:00"),
          rawTimedEvent("d", "2026-05-13T13:00:00-05:00", "2026-05-13T13:30:00-05:00"),
        ],
      }),
    });
    const parsed = dailyBriefTool.inputSchema.parse({}) as Parameters<
      typeof dailyBriefTool.handler
    >[0];
    const out = await dailyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.total).toBe(4);
    expect(out.events).toHaveLength(3);
    expect(out.events.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("single event => no conflict; biggest_free_block excludes the busy slot", async () => {
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({
        items: [
          rawTimedEvent("a", "2026-05-13T10:00:00-05:00", "2026-05-13T11:00:00-05:00"),
        ],
      }),
    });
    const parsed = dailyBriefTool.inputSchema.parse({}) as Parameters<
      typeof dailyBriefTool.handler
    >[0];
    const out = await dailyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.total).toBe(1);
    expect(out.first_conflict).toBeNull();
    // Free: [00:00..10:00] (600m) + [11:00..24:00] (780m). 780m > 600m.
    expect(out.biggest_free_block?.duration_minutes).toBe(13 * 60);
  });

  it("detects first overlap as a 2-event pair (i, i+1)", async () => {
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({
        items: [
          rawTimedEvent("a", "2026-05-13T09:00:00-05:00", "2026-05-13T09:30:00-05:00"),
          rawTimedEvent("b", "2026-05-13T10:00:00-05:00", "2026-05-13T11:00:00-05:00"),
          rawTimedEvent("c", "2026-05-13T10:30:00-05:00", "2026-05-13T11:30:00-05:00"),
        ],
      }),
    });
    const parsed = dailyBriefTool.inputSchema.parse({}) as Parameters<
      typeof dailyBriefTool.handler
    >[0];
    const out = await dailyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.first_conflict).not.toBeNull();
    expect(out.first_conflict).toHaveLength(2);
    expect(out.first_conflict?.[0]?.id).toBe("b");
    expect(out.first_conflict?.[1]?.id).toBe("c");
  });

  it("adjacent events (b.start == a.end) do NOT count as conflict", async () => {
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({
        items: [
          rawTimedEvent("a", "2026-05-13T10:00:00-05:00", "2026-05-13T10:30:00-05:00"),
          rawTimedEvent("b", "2026-05-13T10:30:00-05:00", "2026-05-13T11:00:00-05:00"),
        ],
      }),
    });
    const parsed = dailyBriefTool.inputSchema.parse({}) as Parameters<
      typeof dailyBriefTool.handler
    >[0];
    const out = await dailyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.first_conflict).toBeNull();
  });

  it("all-day event spanning the day yields biggest_free_block === null", async () => {
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({
        items: [rawAllDayEvent("ad", "2026-05-13", "2026-05-14")],
      }),
    });
    const parsed = dailyBriefTool.inputSchema.parse({}) as Parameters<
      typeof dailyBriefTool.handler
    >[0];
    const out = await dailyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.total).toBe(1);
    expect(out.biggest_free_block).toBeNull();
  });

  it("returns null biggest_free_block when no gap >= 15min", async () => {
    // Cover the day with events leaving no gap >= 15m.
    // From 00:00 we have one big event 00:00..23:50 then another 23:50..23:59.
    // Free remainder is 1 min — under floor.
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({
        items: [
          rawTimedEvent("big", "2026-05-13T00:00:00-05:00", "2026-05-13T23:50:00-05:00"),
          rawTimedEvent("tail", "2026-05-13T23:50:00-05:00", "2026-05-13T23:59:00-05:00"),
        ],
      }),
    });
    const parsed = dailyBriefTool.inputSchema.parse({}) as Parameters<
      typeof dailyBriefTool.handler
    >[0];
    const out = await dailyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.biggest_free_block).toBeNull();
  });
});

// ============================================================================
// weeklyBriefTool
// ============================================================================

describe("weeklyBriefTool — metadata", () => {
  it("name + token budget", () => {
    expect(weeklyBriefTool.name).toBe("weekly_brief");
    expect(
      weeklyBriefTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("defaults calendar_id to 'primary' when omitted", () => {
    const parsed = weeklyBriefTool.inputSchema.parse({}) as {
      calendar_id: string;
    };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("weeklyBriefTool — handler", () => {
  it("empty week: total 0, days has 7 entries all count 0", async () => {
    const client = makeClient();
    const parsed = weeklyBriefTool.inputSchema.parse({}) as Parameters<
      typeof weeklyBriefTool.handler
    >[0];
    const out = await weeklyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.total).toBe(0);
    expect(out.days).toHaveLength(7);
    for (const d of out.days) expect(d.count).toBe(0);
    // 2026-05-13 is Wed -> Monday is 2026-05-11.
    expect(out.days[0]?.date).toBe("2026-05-11");
    expect(out.days[6]?.date).toBe("2026-05-17");
    // Busiest_day ties broken by earliest date.
    expect(out.busiest_day.date).toBe("2026-05-11");
    expect(out.busiest_day.count).toBe(0);
  });

  it("groups events by date-in-tz and picks busiest day", async () => {
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({
        items: [
          rawTimedEvent("a", "2026-05-11T09:00:00-05:00", "2026-05-11T09:30:00-05:00"),
          rawTimedEvent("b", "2026-05-13T09:00:00-05:00", "2026-05-13T09:30:00-05:00"),
          rawTimedEvent("c", "2026-05-13T10:00:00-05:00", "2026-05-13T10:30:00-05:00"),
          rawTimedEvent("d", "2026-05-13T11:00:00-05:00", "2026-05-13T11:30:00-05:00"),
          rawTimedEvent("e", "2026-05-15T15:00:00-05:00", "2026-05-15T15:30:00-05:00"),
        ],
      }),
    });
    const parsed = weeklyBriefTool.inputSchema.parse({}) as Parameters<
      typeof weeklyBriefTool.handler
    >[0];
    const out = await weeklyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.total).toBe(5);
    expect(out.busiest_day.date).toBe("2026-05-13");
    expect(out.busiest_day.count).toBe(3);
    expect(out.days.find((d) => d.date === "2026-05-11")?.count).toBe(1);
    expect(out.days.find((d) => d.date === "2026-05-13")?.count).toBe(3);
    expect(out.days.find((d) => d.date === "2026-05-15")?.count).toBe(1);
    expect(out.days.find((d) => d.date === "2026-05-12")?.count).toBe(0);
  });

  it("ties on busiest day go to the earliest date", async () => {
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({
        items: [
          rawTimedEvent("a", "2026-05-13T09:00:00-05:00", "2026-05-13T09:30:00-05:00"),
          rawTimedEvent("b", "2026-05-14T09:00:00-05:00", "2026-05-14T09:30:00-05:00"),
        ],
      }),
    });
    const parsed = weeklyBriefTool.inputSchema.parse({}) as Parameters<
      typeof weeklyBriefTool.handler
    >[0];
    const out = await weeklyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    // Each day count=1; earliest with count 1 is 2026-05-13.
    expect(out.busiest_day.date).toBe("2026-05-13");
    expect(out.busiest_day.count).toBe(1);
  });

  it("biggest_free_block scanned across whole week", async () => {
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({
        items: [
          // One short event, leaving the bulk of the week free.
          rawTimedEvent("a", "2026-05-13T10:00:00-05:00", "2026-05-13T10:30:00-05:00"),
        ],
      }),
    });
    const parsed = weeklyBriefTool.inputSchema.parse({}) as Parameters<
      typeof weeklyBriefTool.handler
    >[0];
    const out = await weeklyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.biggest_free_block).not.toBeNull();
    // From 10:30 on Tue (Wed) to Mon next week = several days.
    // We just assert duration > 1 day.
    expect(
      out.biggest_free_block?.duration_minutes ?? 0,
    ).toBeGreaterThan(24 * 60);
  });

  it("week_of explicit date keeps Monday-based bounds", async () => {
    const client = makeClient();
    const parsed = weeklyBriefTool.inputSchema.parse({
      week_of: "2026-05-17", // Sunday
    }) as Parameters<typeof weeklyBriefTool.handler>[0];
    const out = await weeklyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.week_start).toMatch(/^2026-05-11T00:00:00/);
    expect(out.week_end).toMatch(/^2026-05-18T00:00:00/);
  });

  it("week_start and week_end are ISO strings with tz offset", async () => {
    const client = makeClient();
    const parsed = weeklyBriefTool.inputSchema.parse({}) as Parameters<
      typeof weeklyBriefTool.handler
    >[0];
    const out = await weeklyBriefTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.week_start).toBe("2026-05-11T00:00:00-05:00");
    expect(out.week_end).toBe("2026-05-18T00:00:00-05:00");
  });
});
