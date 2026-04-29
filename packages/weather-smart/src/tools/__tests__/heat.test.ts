import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { heatAdvisory } from "../heat.js";
import type { WeatherContext } from "../../context.js";
import type { WeatherClient, HourlyEntry } from "../../client.js";

// Pin TZ so peak-hour labels render deterministically across CI machines.
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
    temperature: 80,
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

function dayEntries(date: string, temps: number[]): HourlyEntry[] {
  return Array.from({ length: 24 }, (_, h) => {
    const t = temps[h] ?? temps[temps.length - 1] ?? 80;
    return hourlyEntry({
      time: `${date}T${String(h).padStart(2, "0")}:00`,
      temperature: t,
    });
  });
}

// --- tests ----------------------------------------------------------------

describe("heat_advisory — defaults", () => {
  it("uses 95F as the default threshold under imperial units", async () => {
    // Max 94F — below 95, NOT flagged.
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 94),
    );
    const { ctx } = makeCtx({ entries });
    const result = await heatAdvisory.handler(
      { location: "Dallas", days: 1 },
      ctx,
    );
    expect(result.threshold).toBe("95F");
    expect(result.days_at_risk).toEqual([]);
  });

  it("uses 35C as the default threshold under metric units", async () => {
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 34),
    );
    const { ctx } = makeCtx({ entries, units: "metric" });
    const result = await heatAdvisory.handler(
      { location: "Dallas", days: 1 },
      ctx,
    );
    expect(result.threshold).toBe("35C");
    expect(result.days_at_risk).toEqual([]);
  });

  it("respects an explicit custom threshold", async () => {
    // Threshold 90F, max 92F → flagged.
    const temps = Array.from({ length: 24 }, (_, h) => (h === 14 ? 92 : 80));
    const entries = dayEntries("2026-04-29", temps);
    const { ctx } = makeCtx({ entries });
    const result = await heatAdvisory.handler(
      { location: "Dallas", days: 1, threshold: 90 },
      ctx,
    );
    expect(result.threshold).toBe("90F");
    expect(result.days_at_risk).toHaveLength(1);
    expect(result.days_at_risk[0]!.max_temp).toBe("92F");
  });
});

describe("heat_advisory — risk detection", () => {
  it("returns no days when all maxes are at or below threshold", async () => {
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 90),
    );
    const { ctx } = makeCtx({ entries });
    const result = await heatAdvisory.handler(
      { location: "Dallas", days: 1 },
      ctx,
    );
    expect(result.days_at_risk).toEqual([]);
    expect(result.summary).toBe("No high-heat days expected in next 1d.");
  });

  it("flags a single date with above-threshold max and reports the peak hour", async () => {
    // Peak at 16:00 = 98F.
    const temps = Array.from({ length: 24 }, (_, h) => {
      if (h === 16) return 98;
      if (h >= 10 && h <= 18) return 92;
      return 80;
    });
    const entries = dayEntries("2026-04-29", temps);
    const { ctx } = makeCtx({ entries });
    const result = await heatAdvisory.handler(
      { location: "Dallas", days: 1 },
      ctx,
    );
    expect(result.days_at_risk).toHaveLength(1);
    expect(result.days_at_risk[0]!.date).toBe("2026-04-29");
    expect(result.days_at_risk[0]!.max_temp).toBe("98F");
    expect(result.days_at_risk[0]!.peak_hour).toBe("2026-04-29T16:00");
    expect(result.summary.toLowerCase()).toContain("high heat");
    expect(result.summary).toContain("98F");
  });

  it("flags multiple above-threshold days sorted chronologically", async () => {
    const day1 = dayEntries("2026-04-29", [
      ...Array.from({ length: 14 }, () => 80),
      96,
      97,
      96,
      ...Array.from({ length: 7 }, () => 85),
    ]);
    const day2 = dayEntries("2026-04-30", [
      ...Array.from({ length: 14 }, () => 82),
      99,
      100,
      99,
      ...Array.from({ length: 7 }, () => 86),
    ]);
    const day3 = dayEntries("2026-05-01", [
      ...Array.from({ length: 13 }, () => 84),
      96,
      98,
      97,
      96,
      ...Array.from({ length: 7 }, () => 87),
    ]);
    const { ctx } = makeCtx({ entries: [...day1, ...day2, ...day3] });
    const result = await heatAdvisory.handler(
      { location: "Dallas", days: 3 },
      ctx,
    );
    expect(result.days_at_risk).toHaveLength(3);
    expect(result.days_at_risk.map((d) => d.date)).toEqual([
      "2026-04-29",
      "2026-04-30",
      "2026-05-01",
    ]);
  });

  it("`peak_hour` is the actual ISO time of the maximum temp on that date", async () => {
    const temps = Array.from({ length: 24 }, (_, h) => {
      if (h === 15) return 100;
      if (h === 16) return 99;
      return 92;
    });
    const entries = dayEntries("2026-04-29", temps);
    const { ctx } = makeCtx({ entries });
    const result = await heatAdvisory.handler(
      { location: "Dallas", days: 1, threshold: 95 },
      ctx,
    );
    expect(result.days_at_risk[0]!.peak_hour).toBe("2026-04-29T15:00");
    expect(result.days_at_risk[0]!.max_temp).toBe("100F");
  });

  it("strict comparator: a max equal to threshold is NOT flagged", async () => {
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 95),
    );
    const { ctx } = makeCtx({ entries });
    const result = await heatAdvisory.handler(
      { location: "Dallas", days: 1 },
      ctx,
    );
    expect(result.days_at_risk).toEqual([]);
  });
});

describe("heat_advisory — output shape", () => {
  it("returns the five expected keys", async () => {
    const entries = dayEntries(
      "2026-04-29",
      Array.from({ length: 24 }, () => 80),
    );
    const { ctx } = makeCtx({ entries });
    const result = await heatAdvisory.handler(
      { location: "Dallas", days: 1 },
      ctx,
    );
    expect(Object.keys(result).sort()).toEqual([
      "days_at_risk",
      "days_scanned",
      "location",
      "summary",
      "threshold",
    ]);
  });

  it("has correct name and description", () => {
    expect(heatAdvisory.name).toBe("heat_advisory");
    expect(heatAdvisory.description).toBe(
      "Alert for high-heat windows next 1-7d.",
    );
  });
});
