import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { outdoorWindow } from "../outdoor.js";
import type { WeatherContext } from "../../context.js";
import type { WeatherClient, HourlyEntry } from "../../client.js";

// Pin TZ so the summary's hour labels render deterministically across CI.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// --- harness --------------------------------------------------------------

// Imperial-comfortable defaults: passes every preset out of the box.
function entry(overrides: Partial<HourlyEntry> = {}): HourlyEntry {
  return {
    time: "2026-04-29T12:00",
    temperature: 60,
    precipitation_probability: 10,
    precipitation: 0,
    weather_code: 1,
    wind_speed: 8,
    cloud_cover: 40,
    visibility: 52800,
    uv_index: 5,
    ...overrides,
  };
}

// Imperial-failing entry — 30 mph wind kills every preset.
function badEntry(overrides: Partial<HourlyEntry> = {}): HourlyEntry {
  return entry({
    temperature: 60,
    wind_speed: 30,
    precipitation_probability: 80,
    cloud_cover: 90,
    ...overrides,
  });
}

function dayEntries(date: string, perHour: Partial<HourlyEntry>[]): HourlyEntry[] {
  return Array.from({ length: 24 }, (_, h) => {
    const overrides = perHour[h] ?? perHour[perHour.length - 1] ?? {};
    return entry({
      time: `${date}T${String(h).padStart(2, "0")}:00`,
      ...overrides,
    });
  });
}

function makeCtx(opts: {
  entries: HourlyEntry[];
  units?: "metric" | "imperial";
}): { ctx: WeatherContext; getHourly: ReturnType<typeof vi.fn> } {
  const getHourly = vi.fn().mockResolvedValue({
    entries: opts.entries,
    timezone: "America/Chicago",
  });
  const geocode = vi.fn().mockResolvedValue({
    matches: [
      {
        name: "Dallas",
        lat: 32.7767,
        lng: -96.797,
        timezone: "America/Chicago",
        admin1: "Texas",
        country: "United States",
      },
    ],
  });
  const ctx: WeatherContext = {
    client: {
      geocode,
      getHourly,
    } as unknown as WeatherClient,
    defaults: {
      units: opts.units ?? "imperial",
      location: undefined,
    },
  };
  return { ctx, getHourly };
}

// In production the MCP server parses raw input through the tool's
// inputSchema before dispatching to the handler — that's where ZodDefault
// fields like `activity` and `min_window_hours` materialise. Tests that
// invoke `handler` directly must mirror that step or the handler reads
// undefined where it expects defaults.
function call(
  rawInput: Parameters<typeof outdoorWindow.inputSchema.parse>[0],
  ctx: WeatherContext,
) {
  return outdoorWindow.handler(
    outdoorWindow.inputSchema.parse(rawInput),
    ctx,
  );
}

// --- tests ----------------------------------------------------------------

describe("outdoor_window — schema defaults", () => {
  it("defaults activity to 'general'", async () => {
    const entries = dayEntries("2026-04-29", [{}]);
    const { ctx } = makeCtx({ entries });
    const result = await call({ location: "Dallas" }, ctx);
    expect(result.activity).toBe("general");
  });

  it("defaults days=3 and min_window_hours=2 (3 days × 24h fetched)", async () => {
    const entries = [
      ...dayEntries("2026-04-29", [{}]),
      ...dayEntries("2026-04-30", [{}]),
      ...dayEntries("2026-05-01", [{}]),
    ];
    const { ctx, getHourly } = makeCtx({ entries });
    await call({ location: "Dallas" }, ctx);
    expect(getHourly).toHaveBeenCalledWith(
      expect.objectContaining({ hours: 72 }),
    );
  });

  it("rejects an unknown activity at the schema layer", () => {
    const parsed = outdoorWindow.inputSchema.safeParse({
      location: "Dallas",
      activity: "swim",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("outdoor_window — window detection", () => {
  it("returns top 3 windows when more candidates exist", async () => {
    // Build 5 distinct passing windows separated by failing hours. Each
    // window has a different max precip pop so scores differ and ordering
    // is deterministic.
    const pop = (n: number): Partial<HourlyEntry> => ({
      precipitation_probability: n,
    });
    const fail: Partial<HourlyEntry> = { wind_speed: 30 };
    // hours 0-2 pop 5; 3 fail; 4-6 pop 10; 7 fail; 8-10 pop 15; 11 fail;
    // 12-14 pop 20; 15 fail; 16-18 pop 25; rest fail
    const day = dayEntries("2026-04-29", [
      pop(5),  pop(5),  pop(5),
      fail,
      pop(10), pop(10), pop(10),
      fail,
      pop(15), pop(15), pop(15),
      fail,
      pop(20), pop(20), pop(20),
      fail,
      pop(25), pop(25), pop(25),
      fail, fail, fail, fail, fail,
    ]);
    const { ctx } = makeCtx({ entries: day });
    const result = await call(
      { location: "Dallas", days: 1, min_window_hours: 2 },
      ctx,
    );
    expect(result.windows).toHaveLength(3);
    // Highest score = lowest max precip pop => the 5%-pop window first.
    expect(result.windows[0]!.score).toBeCloseTo(0.95, 5);
    expect(result.windows[1]!.score).toBeCloseTo(0.9, 5);
    expect(result.windows[2]!.score).toBeCloseTo(0.85, 5);
  });

  it("filters out windows shorter than min_window_hours", async () => {
    const fail: Partial<HourlyEntry> = { wind_speed: 30 };
    const ok: Partial<HourlyEntry> = {};
    // hours 0 pass, 1 fail (1-hour window — dropped at min=2),
    // 5-7 pass (3-hour window — kept)
    const day = dayEntries("2026-04-29", [
      ok, fail, fail, fail, fail,
      ok, ok, ok,
      fail, fail, fail, fail, fail, fail, fail, fail,
      fail, fail, fail, fail, fail, fail, fail, fail,
    ]);
    const { ctx } = makeCtx({ entries: day });
    const result = await call(
      { location: "Dallas", days: 1, min_window_hours: 2 },
      ctx,
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.duration_hours).toBe(3);
    expect(result.windows[0]!.start).toBe("2026-04-29T05:00");
  });

  it("returns empty windows + no-suitable summary when nothing passes", async () => {
    const day = Array.from({ length: 72 }, (_, i) => {
      const date = "2026-04-29";
      return badEntry({ time: `${date}T${String(i % 24).padStart(2, "0")}:00` });
    });
    const { ctx } = makeCtx({ entries: day });
    const result = await call(
      { location: "Dallas", days: 3, activity: "hike" },
      ctx,
    );
    expect(result.windows).toEqual([]);
    expect(result.summary).toBe("No suitable hike windows in next 3 days.");
  });

  it("a single perfect 4-hour window scores 1.0 with 0% precip pop", async () => {
    const fail: Partial<HourlyEntry> = { wind_speed: 30 };
    const perfect: Partial<HourlyEntry> = { precipitation_probability: 0 };
    const day = dayEntries("2026-04-29", [
      fail, fail, fail, fail, fail, fail, fail, fail, fail,
      perfect, perfect, perfect, perfect,
      fail, fail, fail, fail, fail, fail, fail, fail, fail, fail, fail,
    ]);
    const { ctx } = makeCtx({ entries: day });
    const result = await call(
      { location: "Dallas", days: 1, min_window_hours: 2 },
      ctx,
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.score).toBe(1);
    expect(result.windows[0]!.duration_hours).toBe(4);
    expect(result.windows[0]!.start).toBe("2026-04-29T09:00");
    expect(result.windows[0]!.end).toBe("2026-04-29T12:00");
  });

  it("ties on score sort by start time ascending", async () => {
    // Two 2-hour windows, both pop 10 (score 0.9). Earlier window must win.
    const fail: Partial<HourlyEntry> = { wind_speed: 30 };
    const ok: Partial<HourlyEntry> = { precipitation_probability: 10 };
    const day = dayEntries("2026-04-29", [
      fail, fail,
      ok, ok,
      fail, fail, fail, fail, fail, fail, fail, fail,
      ok, ok,
      fail, fail, fail, fail, fail, fail, fail, fail, fail, fail,
    ]);
    const { ctx } = makeCtx({ entries: day });
    const result = await call(
      { location: "Dallas", days: 1, min_window_hours: 2 },
      ctx,
    );
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]!.score).toBe(result.windows[1]!.score);
    expect(result.windows[0]!.start).toBe("2026-04-29T02:00");
    expect(result.windows[1]!.start).toBe("2026-04-29T12:00");
  });
});

describe("outdoor_window — output shape", () => {
  it("returns the four expected top-level keys", async () => {
    const entries = dayEntries("2026-04-29", [{}]);
    const { ctx } = makeCtx({ entries });
    const result = await call({ location: "Dallas", days: 1 }, ctx);
    expect(Object.keys(result).sort()).toEqual([
      "activity",
      "location",
      "summary",
      "windows",
    ]);
  });

  it("each window has the five expected keys with unit-suffixed conditions", async () => {
    const entries = dayEntries("2026-04-29", [{}]);
    const { ctx } = makeCtx({ entries });
    const result = await call({ location: "Dallas", days: 1 }, ctx);
    expect(result.windows.length).toBeGreaterThan(0);
    const w = result.windows[0]!;
    expect(Object.keys(w).sort()).toEqual([
      "conditions",
      "duration_hours",
      "end",
      "score",
      "start",
    ]);
    expect(w.conditions.temp_avg).toMatch(/F$/);
    expect(w.conditions.wind_avg).toMatch(/mph$/);
    expect(w.conditions.precip_chance_max).toMatch(/%$/);
    expect(w.conditions.cloud_cover_avg).toMatch(/%$/);
  });

  it("has correct name and description", () => {
    expect(outdoorWindow.name).toBe("outdoor_window");
    expect(outdoorWindow.description).toBe(
      "Best outdoor windows in next 1-7 days.",
    );
  });
});
