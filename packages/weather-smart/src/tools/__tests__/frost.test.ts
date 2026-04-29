import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { frostAlert } from "../frost.js";
import type { WeatherContext } from "../../context.js";
import type { WeatherClient, HourlyEntry } from "../../client.js";

// Pin TZ to America/Chicago so any local-time hour-label rendering in the
// summary string is deterministic across CI machines.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// --- harness --------------------------------------------------------------

function hourlyEntry(overrides: Partial<HourlyEntry> = {}): HourlyEntry {
  return {
    time: "2026-04-29T12:00",
    temperature: 50,
    precipitation_probability: 0,
    precipitation: 0,
    weather_code: 1,
    wind_speed: 8,
    cloud_cover: 20,
    visibility: 24144,
    uv_index: 5,
    ...overrides,
  };
}

function makeCtx(opts: {
  entries: HourlyEntry[];
  units?: "metric" | "imperial";
}): {
  ctx: WeatherContext;
  getHourly: ReturnType<typeof vi.fn>;
} {
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

// Builds 24 hourly entries on `date` (YYYY-MM-DD) with the given temp profile.
// `temps` may be shorter than 24; remaining hours fill with the last value.
function dayEntries(date: string, temps: number[]): HourlyEntry[] {
  return Array.from({ length: 24 }, (_, h) => {
    const t = temps[h] ?? temps[temps.length - 1] ?? 50;
    return hourlyEntry({
      time: `${date}T${String(h).padStart(2, "0")}:00`,
      temperature: t,
    });
  });
}

// --- tests ----------------------------------------------------------------

describe("frost_alert — defaults", () => {
  it("uses 32F as the default threshold under imperial units", async () => {
    // Day with min temp 33F (above 32) — must NOT be flagged.
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 33),
    );
    const { ctx } = makeCtx({ entries });
    const result = await frostAlert.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.threshold).toBe("32F");
    expect(result.nights_at_risk).toEqual([]);
  });

  it("uses 0C as the default threshold under metric units", async () => {
    // Day with min temp 1C (above 0) — must NOT be flagged.
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 1),
    );
    const { ctx } = makeCtx({ entries, units: "metric" });
    const result = await frostAlert.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.threshold).toBe("0C");
    expect(result.nights_at_risk).toEqual([]);
  });

  it("respects an explicit custom threshold", async () => {
    // Custom threshold 25F. Day mins 28F — above 25, NOT flagged.
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 28),
    );
    const { ctx } = makeCtx({ entries });
    const result = await frostAlert.handler(
      { location: "Dallas", hours: 24, threshold: 25 },
      ctx,
    );
    expect(result.threshold).toBe("25F");
    expect(result.nights_at_risk).toEqual([]);
  });
});

describe("frost_alert — risk detection", () => {
  it("returns no nights when all temps stay above threshold", async () => {
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 45),
    );
    const { ctx } = makeCtx({ entries });
    const result = await frostAlert.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.nights_at_risk).toEqual([]);
    expect(result.summary).toBe("No frost expected in next 24h.");
  });

  it("flags a single date with sub-freezing min and reports the lowest hour", async () => {
    // Day profile: warm midday (36F) dropping to 28F at 03:00.
    const temps = Array.from({ length: 24 }, (_, h) => {
      if (h === 3) return 28;
      if (h >= 10 && h <= 16) return 36;
      return 32;
    });
    const entries = dayEntries("2026-04-29", temps);
    const { ctx } = makeCtx({ entries });
    const result = await frostAlert.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.nights_at_risk).toHaveLength(1);
    expect(result.nights_at_risk[0]!.date).toBe("2026-04-29");
    expect(result.nights_at_risk[0]!.min_temp).toBe("28F");
    expect(result.nights_at_risk[0]!.hour).toBe("2026-04-29T03:00");
    expect(result.summary.toLowerCase()).toContain("frost");
    expect(result.summary).toContain("28F");
  });

  it("flags multiple sub-freezing dates sorted chronologically", async () => {
    const day1 = dayEntries("2026-04-29", [
      28,
      28,
      28,
      28,
      30,
      32,
      36,
      40,
      ...Array.from({ length: 16 }, () => 35),
    ]);
    const day2 = dayEntries("2026-04-30", [
      26,
      26,
      ...Array.from({ length: 22 }, () => 38),
    ]);
    const day3 = dayEntries("2026-05-01", [
      ...Array.from({ length: 20 }, () => 40),
      30,
      28,
      29,
      31,
    ]);
    const { ctx } = makeCtx({ entries: [...day1, ...day2, ...day3] });
    const result = await frostAlert.handler(
      { location: "Dallas", hours: 72 },
      ctx,
    );
    expect(result.nights_at_risk).toHaveLength(3);
    expect(result.nights_at_risk.map((n) => n.date)).toEqual([
      "2026-04-29",
      "2026-04-30",
      "2026-05-01",
    ]);
  });

  it("`hour` is the actual ISO time of the lowest temp on that date", async () => {
    // Lowest at 05:00 (25F) — make sure that's what's reported.
    const temps = Array.from({ length: 24 }, (_, h) => {
      if (h === 5) return 25;
      if (h === 6) return 27;
      return 31;
    });
    const entries = dayEntries("2026-04-29", temps);
    const { ctx } = makeCtx({ entries });
    const result = await frostAlert.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.nights_at_risk[0]!.hour).toBe("2026-04-29T05:00");
    expect(result.nights_at_risk[0]!.min_temp).toBe("25F");
  });

  it("strict comparator: a min equal to threshold is NOT flagged", async () => {
    // All temps exactly 32F at default imperial threshold.
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 32),
    );
    const { ctx } = makeCtx({ entries });
    const result = await frostAlert.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.nights_at_risk).toEqual([]);
  });
});

describe("frost_alert — output shape", () => {
  it("returns the five expected keys", async () => {
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 45),
    );
    const { ctx } = makeCtx({ entries });
    const result = await frostAlert.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(Object.keys(result).sort()).toEqual([
      "hours_scanned",
      "location",
      "nights_at_risk",
      "summary",
      "threshold",
    ]);
  });

  it("has correct name and description", () => {
    expect(frostAlert.name).toBe("frost_alert");
    expect(frostAlert.description).toBe(
      "Alert for sub-freezing temps in next 24-168h.",
    );
  });
});
