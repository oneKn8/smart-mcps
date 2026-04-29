import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { umbrellaCheck } from "../umbrella.js";
import type { WeatherContext } from "../../context.js";
import type { WeatherClient, HourlyEntry } from "../../client.js";

// Pin TZ to America/Chicago so the local-time hour label test
// ("2026-04-29T17:00" → "5pm") is deterministic across CI machines.
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
    temperature: 72,
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

function makeCtx(opts: { entries: HourlyEntry[] }): {
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
      units: "imperial",
      location: undefined,
    },
  };
  return { ctx, getHourly };
}

// Builds N entries with an iso time per hour, all-zero by default.
function hours(n: number, baseHour = 0): HourlyEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const h = (baseHour + i) % 24;
    return hourlyEntry({
      time: `2026-04-29T${String(h).padStart(2, "0")}:00`,
    });
  });
}

// --- tests ----------------------------------------------------------------

describe("umbrella_check — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(umbrellaCheck.name).toBe("umbrella_check");
    expect(umbrellaCheck.description).toBe(
      "Should I bring an umbrella? Next 6-48h.",
    );
  });

  it("schema accepts hours=6 (minimum)", () => {
    const result = umbrellaCheck.inputSchema.safeParse({ hours: 6 });
    expect(result.success).toBe(true);
  });

  it("schema rejects hours=5", () => {
    const result = umbrellaCheck.inputSchema.safeParse({ hours: 5 });
    expect(result.success).toBe(false);
  });

  it("schema accepts hours=48 (maximum)", () => {
    const result = umbrellaCheck.inputSchema.safeParse({ hours: 48 });
    expect(result.success).toBe(true);
  });

  it("schema rejects hours=49", () => {
    const result = umbrellaCheck.inputSchema.safeParse({ hours: 49 });
    expect(result.success).toBe(false);
  });

  it("schema defaults hours to 24 when omitted", () => {
    const parsed = umbrellaCheck.inputSchema.parse({}) as { hours: number };
    expect(parsed.hours).toBe(24);
  });
});

describe("umbrella_check — output shape", () => {
  it("returns the seven expected keys", async () => {
    const { ctx } = makeCtx({ entries: hours(24) });
    const result = await umbrellaCheck.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(Object.keys(result).sort()).toEqual([
      "hours_with_rain",
      "location",
      "peak_hour",
      "peak_pop",
      "recommend",
      "summary",
      "total_precip",
    ]);
  });
});

describe("umbrella_check — recommendation rules", () => {
  it("zero precip across all hours → recommend false, peak_hour null, summary mentions no rain", async () => {
    const { ctx } = makeCtx({ entries: hours(24) });
    const result = await umbrellaCheck.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.recommend).toBe(false);
    expect(result.peak_hour).toBeNull();
    expect(result.peak_pop).toBe(0);
    expect(result.total_precip).toBe("0.00in");
    expect(result.summary.toLowerCase()).toContain("no rain");
  });

  it("high pop (70%) at one hour → recommend true via peak_pop rule", async () => {
    const entries = hours(24);
    entries[5] = hourlyEntry({
      time: "2026-04-29T05:00",
      precipitation_probability: 70,
      precipitation: 0.05,
    });
    const { ctx } = makeCtx({ entries });
    const result = await umbrellaCheck.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.recommend).toBe(true);
    expect(result.peak_pop).toBe(70);
    expect(result.peak_hour).toBe("2026-04-29T05:00");
    expect(result.summary).toContain("70%");
    expect(result.summary).toContain("5am");
  });

  it("medium total_precip (0.2in) but low pop (15%) → recommend true via precip rule", async () => {
    // 8 hours each with 15% pop and 0.025in → total 0.2in, hours_with_rain = 0
    // (15% is NOT > 20%), peak_pop 15. Only the precip rule should trigger.
    const entries = Array.from({ length: 8 }, (_, i) =>
      hourlyEntry({
        time: `2026-04-29T${String(i).padStart(2, "0")}:00`,
        precipitation_probability: 15,
        precipitation: 0.025,
      }),
    );
    const { ctx } = makeCtx({ entries });
    const result = await umbrellaCheck.handler(
      { location: "Dallas", hours: 8 },
      ctx,
    );
    expect(result.recommend).toBe(true);
    expect(result.peak_pop).toBe(15);
    expect(result.hours_with_rain).toBe(0);
    expect(result.total_precip).toBe("0.20in");
  });

  it("4 hours with pop>20% but each pop<40 and total<=0.1in → recommend true via hours rule", async () => {
    // 4 hours at 25% pop with tiny precip (0.01in each = 0.04in total).
    // peak_pop 25 (< 40), total 0.04in (< 0.1), hours_with_rain 4 (>= 3) → triggers hours rule only.
    const entries = hours(24);
    for (let i = 0; i < 4; i++) {
      entries[i] = hourlyEntry({
        time: `2026-04-29T${String(i).padStart(2, "0")}:00`,
        precipitation_probability: 25,
        precipitation: 0.01,
      });
    }
    const { ctx } = makeCtx({ entries });
    const result = await umbrellaCheck.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.recommend).toBe(true);
    expect(result.peak_pop).toBe(25);
    expect(result.hours_with_rain).toBe(4);
    expect(result.total_precip).toBe("0.04in");
  });

  it("all three rules false → recommend false", async () => {
    // 2 hours at 25% pop (under hours threshold of 3), 0.02in each total 0.04in
    // (under 0.1in), peak 25 (under 40). All three rules fail.
    const entries = hours(24);
    for (let i = 0; i < 2; i++) {
      entries[i] = hourlyEntry({
        time: `2026-04-29T${String(i).padStart(2, "0")}:00`,
        precipitation_probability: 25,
        precipitation: 0.02,
      });
    }
    const { ctx } = makeCtx({ entries });
    const result = await umbrellaCheck.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.recommend).toBe(false);
    expect(result.peak_pop).toBe(25);
    expect(result.hours_with_rain).toBe(2);
    expect(result.summary.toLowerCase()).toContain("dry");
  });
});

describe("umbrella_check — formatting", () => {
  it("formats peak_hour as '5pm' for 17:00 in pinned TZ", async () => {
    const entries = hours(24);
    entries[17] = hourlyEntry({
      time: "2026-04-29T17:00",
      precipitation_probability: 80,
      precipitation: 0.1,
    });
    const { ctx } = makeCtx({ entries });
    const result = await umbrellaCheck.handler(
      { location: "Dallas", hours: 24 },
      ctx,
    );
    expect(result.summary).toContain("5pm");
  });

  it("forwards default hours=24 to client when schema applies the default", async () => {
    const { ctx, getHourly } = makeCtx({ entries: hours(24) });
    // Mirror the MCP runtime: parse through the schema so the ZodDefault
    // resolves `hours` to 24 before reaching the handler.
    const parsed = umbrellaCheck.inputSchema.parse({
      location: "Dallas",
    }) as { location: string; hours: number };
    await umbrellaCheck.handler(parsed, ctx);
    expect(getHourly).toHaveBeenCalledWith({
      lat: 32.7767,
      lng: -96.797,
      units: "imperial",
      hours: 24,
    });
  });
});
