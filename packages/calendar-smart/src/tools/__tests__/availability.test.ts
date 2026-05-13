import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  findAvailabilityTool,
  busyBlocksTool,
  conflictsCheckTool,
} from "../availability.js";

// Shared fake-client helpers. All times in America/Chicago (UTC-5 in May 2026,
// no DST shift mid-window). The handlers feed Google ISO strings back to the
// time-zone formatter, which produces "...-05:00"-suffixed strings; tests
// match the resulting offsets exactly so any slip in the formatter would fail
// here too.

type FakeClient = {
  ensureTimeZone?: ReturnType<typeof vi.fn>;
  freeBusy?: ReturnType<typeof vi.fn>;
  listEvents?: ReturnType<typeof vi.fn>;
};

function makeClient(over: FakeClient = {}): FakeClient {
  return {
    ensureTimeZone: vi.fn().mockResolvedValue("America/Chicago"),
    freeBusy: vi.fn().mockResolvedValue({ calendars: {} }),
    listEvents: vi.fn().mockResolvedValue({ items: [] }),
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
// findAvailabilityTool
// ---------------------------------------------------------------------------

describe("findAvailabilityTool — metadata", () => {
  it("name and description fit the budget", () => {
    expect(findAvailabilityTool.name).toBe("find_availability");
    expect(
      findAvailabilityTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires duration_minutes, time_min, time_max", () => {
    expect(() => findAvailabilityTool.inputSchema.parse({})).toThrow();
    expect(() =>
      findAvailabilityTool.inputSchema.parse({
        duration_minutes: 30,
      }),
    ).toThrow();
    const parsed = findAvailabilityTool.inputSchema.parse({
      duration_minutes: 30,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
    }) as {
      duration_minutes: number;
      time_min: string;
      time_max: string;
      calendar_id: string;
    };
    expect(parsed.calendar_id).toBe("primary");
  });

  it("inputSchema is a zod type", () => {
    expect(findAvailabilityTool.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("findAvailabilityTool — handler", () => {
  it("calls freeBusy with the resolved calendar id and the provided window", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: {
          primary: { busy: [] },
        },
      }),
    });
    const parsed = findAvailabilityTool.inputSchema.parse({
      duration_minutes: 30,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T11:00:00-05:00",
    }) as Parameters<typeof findAvailabilityTool.handler>[0];

    const out = await findAvailabilityTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.ensureTimeZone).toHaveBeenCalledTimes(1);
    expect(client.freeBusy).toHaveBeenCalledWith({
      timeMin: "2026-05-13T09:00:00-05:00",
      timeMax: "2026-05-13T11:00:00-05:00",
      calendarIds: ["primary"],
    });
    expect(out.free_blocks).toEqual([
      {
        start: "2026-05-13T09:00:00-05:00",
        end: "2026-05-13T11:00:00-05:00",
        duration_minutes: 120,
      },
    ]);
  });

  it("inverts a single busy window into two free blocks (formatted in tz)", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: {
          primary: {
            busy: [
              {
                start: "2026-05-13T15:00:00Z", // 10:00 Chicago
                end: "2026-05-13T16:00:00Z", // 11:00 Chicago
              },
            ],
          },
        },
      }),
    });
    const parsed = findAvailabilityTool.inputSchema.parse({
      duration_minutes: 30,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
    }) as Parameters<typeof findAvailabilityTool.handler>[0];

    const out = await findAvailabilityTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(out.free_blocks).toEqual([
      {
        start: "2026-05-13T09:00:00-05:00",
        end: "2026-05-13T10:00:00-05:00",
        duration_minutes: 60,
      },
      {
        start: "2026-05-13T11:00:00-05:00",
        end: "2026-05-13T17:00:00-05:00",
        duration_minutes: 360,
      },
    ]);
  });

  it("returns [] when fully booked", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: {
          primary: {
            busy: [
              {
                start: "2026-05-13T14:00:00Z", // 09:00 Chicago
                end: "2026-05-13T22:00:00Z", // 17:00 Chicago
              },
            ],
          },
        },
      }),
    });
    const parsed = findAvailabilityTool.inputSchema.parse({
      duration_minutes: 30,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
    }) as Parameters<typeof findAvailabilityTool.handler>[0];

    const out = await findAvailabilityTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.free_blocks).toEqual([]);
  });

  it("filters free blocks shorter than duration_minutes", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: {
          primary: {
            busy: [
              // 09:10–09:50 leaves 10-min gaps at the edges, neither fits 30m.
              {
                start: "2026-05-13T14:10:00Z",
                end: "2026-05-13T14:50:00Z",
              },
              {
                start: "2026-05-13T15:00:00Z",
                end: "2026-05-13T22:00:00Z",
              },
            ],
          },
        },
      }),
    });
    const parsed = findAvailabilityTool.inputSchema.parse({
      duration_minutes: 30,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
    }) as Parameters<typeof findAvailabilityTool.handler>[0];

    const out = await findAvailabilityTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.free_blocks).toEqual([]);
  });

  it("uses the provided calendar_id instead of primary", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: { cal_work: { busy: [] } },
      }),
    });
    const parsed = findAvailabilityTool.inputSchema.parse({
      duration_minutes: 60,
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
      calendar_id: "cal_work",
    }) as Parameters<typeof findAvailabilityTool.handler>[0];

    await findAvailabilityTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.freeBusy).toHaveBeenCalledWith({
      timeMin: "2026-05-13T09:00:00-05:00",
      timeMax: "2026-05-13T17:00:00-05:00",
      calendarIds: ["cal_work"],
    });
  });
});

// ---------------------------------------------------------------------------
// busyBlocksTool
// ---------------------------------------------------------------------------

describe("busyBlocksTool — metadata", () => {
  it("name and description fit the budget", () => {
    expect(busyBlocksTool.name).toBe("busy_blocks");
    expect(
      busyBlocksTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema defaults calendar_ids to ['primary']", () => {
    const parsed = busyBlocksTool.inputSchema.parse({
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
    }) as {
      time_min: string;
      time_max: string;
      calendar_ids: string[];
    };
    expect(parsed.calendar_ids).toEqual(["primary"]);
  });
});

describe("busyBlocksTool — handler", () => {
  it("returns [] when calendar has no busy windows", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: { primary: { busy: [] } },
      }),
    });
    const parsed = busyBlocksTool.inputSchema.parse({
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
    }) as Parameters<typeof busyBlocksTool.handler>[0];

    const out = await busyBlocksTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.busy).toEqual([]);
  });

  it("flattens per-calendar busy arrays into one list with calendar_id stamped", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: {
          cal_personal: {
            busy: [
              { start: "2026-05-13T15:00:00Z", end: "2026-05-13T16:00:00Z" },
            ],
          },
          cal_work: {
            busy: [
              { start: "2026-05-13T18:00:00Z", end: "2026-05-13T19:00:00Z" },
            ],
          },
        },
      }),
    });
    const parsed = busyBlocksTool.inputSchema.parse({
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
      calendar_ids: ["cal_personal", "cal_work"],
    }) as Parameters<typeof busyBlocksTool.handler>[0];

    const out = await busyBlocksTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.freeBusy).toHaveBeenCalledWith({
      timeMin: "2026-05-13T09:00:00-05:00",
      timeMax: "2026-05-13T17:00:00-05:00",
      calendarIds: ["cal_personal", "cal_work"],
    });
    // Order: per-input-calendar order, then per-busy order within each.
    expect(out.busy).toEqual([
      {
        start: "2026-05-13T10:00:00-05:00",
        end: "2026-05-13T11:00:00-05:00",
        calendar_id: "cal_personal",
      },
      {
        start: "2026-05-13T13:00:00-05:00",
        end: "2026-05-13T14:00:00-05:00",
        calendar_id: "cal_work",
      },
    ]);
  });

  it("formats start/end in the cached tz with offset suffix", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: {
          primary: {
            busy: [
              { start: "2026-05-13T15:00:00Z", end: "2026-05-13T16:00:00Z" },
            ],
          },
        },
      }),
    });
    const parsed = busyBlocksTool.inputSchema.parse({
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
    }) as Parameters<typeof busyBlocksTool.handler>[0];

    const out = await busyBlocksTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.busy[0]?.start).toBe("2026-05-13T10:00:00-05:00");
    expect(out.busy[0]?.end).toBe("2026-05-13T11:00:00-05:00");
    expect(out.busy[0]?.calendar_id).toBe("primary");
  });

  it("skips calendars whose entry is missing from the freeBusy response", async () => {
    const client = makeClient({
      freeBusy: vi.fn().mockResolvedValue({
        calendars: {
          cal_personal: {
            busy: [
              { start: "2026-05-13T15:00:00Z", end: "2026-05-13T16:00:00Z" },
            ],
          },
        },
      }),
    });
    const parsed = busyBlocksTool.inputSchema.parse({
      time_min: "2026-05-13T09:00:00-05:00",
      time_max: "2026-05-13T17:00:00-05:00",
      calendar_ids: ["cal_personal", "cal_missing"],
    }) as Parameters<typeof busyBlocksTool.handler>[0];

    const out = await busyBlocksTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.busy).toHaveLength(1);
    expect(out.busy[0]?.calendar_id).toBe("cal_personal");
  });
});

// ---------------------------------------------------------------------------
// conflictsCheckTool
// ---------------------------------------------------------------------------

describe("conflictsCheckTool — metadata", () => {
  it("name and description fit the budget", () => {
    expect(conflictsCheckTool.name).toBe("conflicts_check");
    expect(
      conflictsCheckTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("inputSchema requires start and end and defaults calendar_id", () => {
    expect(() => conflictsCheckTool.inputSchema.parse({})).toThrow();
    const parsed = conflictsCheckTool.inputSchema.parse({
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T11:00:00-05:00",
    }) as { calendar_id: string };
    expect(parsed.calendar_id).toBe("primary");
  });
});

describe("conflictsCheckTool — handler", () => {
  it("queries listEvents with the proposed window", async () => {
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({ items: [] }),
    });
    const parsed = conflictsCheckTool.inputSchema.parse({
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T11:00:00-05:00",
    }) as Parameters<typeof conflictsCheckTool.handler>[0];

    const out = await conflictsCheckTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.listEvents).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: "2026-05-13T10:00:00-05:00",
      timeMax: "2026-05-13T11:00:00-05:00",
    });
    expect(out.conflicts).toEqual([]);
  });

  it("returns events that truly overlap the window", async () => {
    const overlapping = rawEvent({
      id: "evt_overlap",
      start: { dateTime: "2026-05-13T10:30:00-05:00" },
      end: { dateTime: "2026-05-13T11:30:00-05:00" },
    });
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({ items: [overlapping] }),
    });
    const parsed = conflictsCheckTool.inputSchema.parse({
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T11:00:00-05:00",
    }) as Parameters<typeof conflictsCheckTool.handler>[0];

    const out = await conflictsCheckTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.id).toBe("evt_overlap");
  });

  it("excludes events whose end equals the proposed start (adjacency, not overlap)", async () => {
    const adjacent = rawEvent({
      id: "evt_adjacent_before",
      start: { dateTime: "2026-05-13T09:00:00-05:00" },
      end: { dateTime: "2026-05-13T10:00:00-05:00" },
    });
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({ items: [adjacent] }),
    });
    const parsed = conflictsCheckTool.inputSchema.parse({
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T11:00:00-05:00",
    }) as Parameters<typeof conflictsCheckTool.handler>[0];

    const out = await conflictsCheckTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.conflicts).toEqual([]);
  });

  it("excludes events whose start equals the proposed end (adjacency, not overlap)", async () => {
    const adjacent = rawEvent({
      id: "evt_adjacent_after",
      start: { dateTime: "2026-05-13T11:00:00-05:00" },
      end: { dateTime: "2026-05-13T12:00:00-05:00" },
    });
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({ items: [adjacent] }),
    });
    const parsed = conflictsCheckTool.inputSchema.parse({
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T11:00:00-05:00",
    }) as Parameters<typeof conflictsCheckTool.handler>[0];

    const out = await conflictsCheckTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.conflicts).toEqual([]);
  });

  it("includes events fully contained inside the proposed window", async () => {
    const inside = rawEvent({
      id: "evt_inside",
      start: { dateTime: "2026-05-13T10:15:00-05:00" },
      end: { dateTime: "2026-05-13T10:45:00-05:00" },
    });
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({ items: [inside] }),
    });
    const parsed = conflictsCheckTool.inputSchema.parse({
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T11:00:00-05:00",
    }) as Parameters<typeof conflictsCheckTool.handler>[0];

    const out = await conflictsCheckTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.id).toBe("evt_inside");
  });

  it("includes events that fully contain the proposed window", async () => {
    const around = rawEvent({
      id: "evt_around",
      start: { dateTime: "2026-05-13T09:00:00-05:00" },
      end: { dateTime: "2026-05-13T12:00:00-05:00" },
    });
    const client = makeClient({
      listEvents: vi.fn().mockResolvedValue({ items: [around] }),
    });
    const parsed = conflictsCheckTool.inputSchema.parse({
      start: "2026-05-13T10:00:00-05:00",
      end: "2026-05-13T11:00:00-05:00",
    }) as Parameters<typeof conflictsCheckTool.handler>[0];

    const out = await conflictsCheckTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.id).toBe("evt_around");
  });
});
