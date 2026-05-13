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
  findMeetingTimeTool,
  eventWithInvitePreviewTool,
  outdoorEventCheckTool,
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

// ============================================================================
// findMeetingTimeTool
// ============================================================================

describe("findMeetingTimeTool — metadata", () => {
  it("name + token budget", () => {
    expect(findMeetingTimeTool.name).toBe("find_meeting_time");
    expect(
      findMeetingTimeTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
    expect(findMeetingTimeTool.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("requires duration_minutes, time_min, time_max", () => {
    expect(() => findMeetingTimeTool.inputSchema.parse({})).toThrow();
    const parsed = findMeetingTimeTool.inputSchema.parse({
      duration_minutes: 30,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
    }) as { top_n: number };
    // top_n defaults to 5
    expect(parsed.top_n).toBe(5);
  });
});

describe("findMeetingTimeTool — handler", () => {
  it("queries freeBusy for my_calendar_ids and finds slots", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: {
          primary: {
            busy: [
              {
                start: "2026-05-13T10:00:00-05:00",
                end: "2026-05-13T11:00:00-05:00",
              },
            ],
          },
        },
      }),
    });
    const parsed = findMeetingTimeTool.inputSchema.parse({
      duration_minutes: 60,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
      my_calendar_ids: ["primary"],
    }) as Parameters<typeof findMeetingTimeTool.handler>[0];
    const out = await findMeetingTimeTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.freeBusy).toHaveBeenCalledTimes(1);
    // 9-10 (60m) + 11-17 (360m) — both >= 60.
    expect(out.slots).toHaveLength(2);
    expect(out.slots[0]?.duration_minutes).toBe(60);
    expect(out.slots[0]?.start).toBe("2026-05-13T09:00:00-05:00");
    expect(out.slots[1]?.duration_minutes).toBe(360);
  });

  it("uses extra_busy when no my_calendar_ids", async () => {
    const client = makeClient({ freeBusy: vi.fn() });
    const parsed = findMeetingTimeTool.inputSchema.parse({
      duration_minutes: 30,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T11:00:00-05:00",
      extra_busy: [
        {
          start: "2026-05-13T09:30:00-05:00",
          end: "2026-05-13T10:00:00-05:00",
        },
      ],
    }) as Parameters<typeof findMeetingTimeTool.handler>[0];
    const out = await findMeetingTimeTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.freeBusy).not.toHaveBeenCalled();
    // Free: 9:00-9:30 (30m) + 10:00-11:00 (60m).
    expect(out.slots).toHaveLength(2);
  });

  it("merges my_calendar_ids busy with extra_busy in one window list", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: {
          primary: {
            busy: [
              {
                start: "2026-05-13T09:00:00-05:00",
                end: "2026-05-13T10:00:00-05:00",
              },
            ],
          },
          cal_work: {
            busy: [
              {
                start: "2026-05-13T15:00:00-05:00",
                end: "2026-05-13T16:00:00-05:00",
              },
            ],
          },
        },
      }),
    });
    const parsed = findMeetingTimeTool.inputSchema.parse({
      duration_minutes: 30,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
      my_calendar_ids: ["primary", "cal_work"],
      extra_busy: [
        {
          start: "2026-05-13T12:00:00-05:00",
          end: "2026-05-13T13:00:00-05:00",
        },
      ],
    }) as Parameters<typeof findMeetingTimeTool.handler>[0];
    const out = await findMeetingTimeTool.handler(parsed, {
      client: client as unknown as never,
    });
    // Busy: 9-10, 12-13, 15-16. Free gaps: 10-12 (120m), 13-15 (120m), 16-17 (60m).
    expect(out.slots.map((s) => s.duration_minutes)).toEqual([120, 120, 60]);
  });

  it("respects top_n cap", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: {
          primary: { busy: [] },
        },
      }),
    });
    const parsed = findMeetingTimeTool.inputSchema.parse({
      duration_minutes: 30,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
      my_calendar_ids: ["primary"],
      top_n: 1,
    }) as Parameters<typeof findMeetingTimeTool.handler>[0];
    const out = await findMeetingTimeTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.slots).toHaveLength(1);
  });

  it("returns empty slots when nothing fits", async () => {
    const client = makeClient({ freeBusy: vi.fn() });
    const parsed = findMeetingTimeTool.inputSchema.parse({
      duration_minutes: 60,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
      extra_busy: [
        {
          start: "2026-05-13T08:00:00-05:00",
          end: "2026-05-13T18:00:00-05:00",
        },
      ],
    }) as Parameters<typeof findMeetingTimeTool.handler>[0];
    const out = await findMeetingTimeTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.slots).toEqual([]);
  });
});

// ============================================================================
// eventWithInvitePreviewTool
// ============================================================================

describe("eventWithInvitePreviewTool — metadata", () => {
  it("name + token budget", () => {
    expect(eventWithInvitePreviewTool.name).toBe("event_with_invite_preview");
    expect(
      eventWithInvitePreviewTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
    expect(eventWithInvitePreviewTool.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("requires summary/start/end/attendees", () => {
    expect(() => eventWithInvitePreviewTool.inputSchema.parse({})).toThrow();
  });
});

describe("eventWithInvitePreviewTool — handler", () => {
  it("returns create_event_payload + subject + body for a fully-specified event", async () => {
    const client = makeClient();
    const parsed = eventWithInvitePreviewTool.inputSchema.parse({
      summary: "Coffee with Bob",
      start: "2026-05-15T10:00:00-05:00",
      end: "2026-05-15T11:00:00-05:00",
      attendees: ["bob@example.com"],
      location: "Hi Coffee",
      description: "Catch up",
    }) as Parameters<typeof eventWithInvitePreviewTool.handler>[0];
    const out = await eventWithInvitePreviewTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.create_event_payload).toEqual({
      summary: "Coffee with Bob",
      start: "2026-05-15T10:00:00-05:00",
      end: "2026-05-15T11:00:00-05:00",
      attendees: ["bob@example.com"],
      location: "Hi Coffee",
      description: "Catch up",
      calendar_id: "primary",
    });
    // Subject contains "Invite:" + summary + "on" + a date.
    expect(out.invite_email_subject).toContain("Invite: Coffee with Bob on");
    // Body contains When + Where + description.
    expect(out.invite_email_body).toContain("When: ");
    expect(out.invite_email_body).toContain("Where: Hi Coffee");
    expect(out.invite_email_body).toContain("Catch up");
  });

  it("uses TBD when location omitted; empty description renders empty trailer", async () => {
    const client = makeClient();
    const parsed = eventWithInvitePreviewTool.inputSchema.parse({
      summary: "Standup",
      start: "2026-05-15T10:00:00-05:00",
      end: "2026-05-15T10:30:00-05:00",
      attendees: ["a@example.com"],
    }) as Parameters<typeof eventWithInvitePreviewTool.handler>[0];
    const out = await eventWithInvitePreviewTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.invite_email_body).toContain("Where: TBD");
    // Payload should NOT include location/description keys when omitted.
    expect(out.create_event_payload.location).toBeUndefined();
    expect(out.create_event_payload.description).toBeUndefined();
  });

  it("does not call any side-effect client method", async () => {
    const client = makeClient({
      // Provide spies that should not fire.
      listEvents: vi.fn(),
    });
    // Add other potential side-effect methods as spies on the same object.
    const spy = vi.fn();
    (client as unknown as { insertEvent: typeof spy }).insertEvent = spy;
    const parsed = eventWithInvitePreviewTool.inputSchema.parse({
      summary: "X",
      start: "2026-05-15T10:00:00-05:00",
      end: "2026-05-15T10:30:00-05:00",
      attendees: ["a@example.com"],
    }) as Parameters<typeof eventWithInvitePreviewTool.handler>[0];
    await eventWithInvitePreviewTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.listEvents).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("subject formats the date in the cached tz", async () => {
    const client = makeClient({
      ensureTimeZone: vi.fn().mockResolvedValue("America/Chicago"),
    });
    const parsed = eventWithInvitePreviewTool.inputSchema.parse({
      summary: "X",
      // 2026-05-15T03:00Z is May 14 22:00 Chicago — the date should reflect
      // Chicago, not UTC.
      start: "2026-05-15T03:00:00Z",
      end: "2026-05-15T04:00:00Z",
      attendees: ["a@example.com"],
    }) as Parameters<typeof eventWithInvitePreviewTool.handler>[0];
    const out = await eventWithInvitePreviewTool.handler(parsed, {
      client: client as unknown as never,
    });
    // Should contain "May 14" (Chicago view), not "May 15" (UTC view).
    expect(out.invite_email_subject).toContain("May 14");
  });

  it("honors explicit calendar_id", async () => {
    const client = makeClient();
    const parsed = eventWithInvitePreviewTool.inputSchema.parse({
      summary: "X",
      start: "2026-05-15T10:00:00-05:00",
      end: "2026-05-15T10:30:00-05:00",
      attendees: ["a@example.com"],
      calendar_id: "cal_work",
    }) as Parameters<typeof eventWithInvitePreviewTool.handler>[0];
    const out = await eventWithInvitePreviewTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.create_event_payload.calendar_id).toBe("cal_work");
  });
});

// ============================================================================
// outdoorEventCheckTool
// ============================================================================

describe("outdoorEventCheckTool — metadata", () => {
  it("name + token budget", () => {
    expect(outdoorEventCheckTool.name).toBe("outdoor_event_check");
    expect(
      outdoorEventCheckTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("requires event_id", () => {
    expect(() => outdoorEventCheckTool.inputSchema.parse({})).toThrow();
    const parsed = outdoorEventCheckTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as { event_id: string; calendar_id: string };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("outdoorEventCheckTool — handler", () => {
  it("returns event + location + composition hint when location present", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue({
        id: "evt_alpha",
        summary: "Hike",
        start: { dateTime: "2026-05-15T10:00:00-05:00" },
        end: { dateTime: "2026-05-15T13:00:00-05:00" },
        location: "Cedar Ridge Preserve, Dallas",
        htmlLink: "https://calendar.google.com/event?eid=alpha",
        status: "confirmed",
      }),
    });
    const parsed = outdoorEventCheckTool.inputSchema.parse({
      event_id: "evt_alpha",
    }) as Parameters<typeof outdoorEventCheckTool.handler>[0];
    const out = await outdoorEventCheckTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.getEvent).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_alpha",
    });
    expect(out.event.id).toBe("evt_alpha");
    expect(out.location).toBe("Cedar Ridge Preserve, Dallas");
    expect(out.hint).toContain("weather-smart.geocode");
    expect(out.hint).toContain("weather-smart.outdoor_window");
  });

  it("returns null location + hint when event has no location", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue({
        id: "evt_beta",
        summary: "Standup",
        start: { dateTime: "2026-05-15T10:00:00-05:00" },
        end: { dateTime: "2026-05-15T10:30:00-05:00" },
        htmlLink: "https://calendar.google.com/event?eid=beta",
        status: "confirmed",
      }),
    });
    const parsed = outdoorEventCheckTool.inputSchema.parse({
      event_id: "evt_beta",
    }) as Parameters<typeof outdoorEventCheckTool.handler>[0];
    const out = await outdoorEventCheckTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.location).toBeNull();
    expect(out.hint).toContain("weather-smart");
  });

  it("does not call freeBusy / listEvents — pure composition hint", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue({
        id: "evt_x",
        summary: "X",
        start: { dateTime: "2026-05-15T10:00:00-05:00" },
        end: { dateTime: "2026-05-15T10:30:00-05:00" },
        htmlLink: "https://calendar.google.com/event?eid=x",
        status: "confirmed",
      }),
      freeBusy: vi.fn(),
      listEvents: vi.fn(),
    });
    const parsed = outdoorEventCheckTool.inputSchema.parse({
      event_id: "evt_x",
    }) as Parameters<typeof outdoorEventCheckTool.handler>[0];
    await outdoorEventCheckTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.freeBusy).not.toHaveBeenCalled();
    expect(client.listEvents).not.toHaveBeenCalled();
  });

  it("honors explicit calendar_id", async () => {
    const client = makeClient({
      getEvent: vi.fn().mockResolvedValue({
        id: "evt_x",
        summary: "X",
        start: { dateTime: "2026-05-15T10:00:00-05:00" },
        end: { dateTime: "2026-05-15T10:30:00-05:00" },
        htmlLink: "https://calendar.google.com/event?eid=x",
        status: "confirmed",
        location: "Somewhere",
      }),
    });
    const parsed = outdoorEventCheckTool.inputSchema.parse({
      event_id: "evt_x",
      calendar_id: "cal_personal",
    }) as Parameters<typeof outdoorEventCheckTool.handler>[0];
    await outdoorEventCheckTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.getEvent).toHaveBeenCalledWith({
      calendarId: "cal_personal",
      eventId: "evt_x",
    });
  });
});
