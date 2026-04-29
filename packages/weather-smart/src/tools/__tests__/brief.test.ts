import { describe, it, expect, vi } from "vitest";
import { dailyBrief } from "../brief.js";
import type { WeatherContext } from "../../context.js";
import type {
  WeatherClient,
  CurrentSnapshot,
  DailyEntry,
} from "../../client.js";

// --- harness --------------------------------------------------------------

function currentSnap(overrides: Partial<CurrentSnapshot> = {}): CurrentSnapshot {
  return {
    time: "2026-04-29T13:00",
    temperature: 78,
    apparent_temperature: 80,
    humidity: 55,
    precipitation: 0,
    weather_code: 2,
    wind_speed: 12,
    wind_direction: 180,
    pressure: 1013,
    timezone: "America/Chicago",
    ...overrides,
  };
}

function dailyEntry(overrides: Partial<DailyEntry> = {}): DailyEntry {
  return {
    date: "2026-04-29",
    temp_max: 84,
    temp_min: 65,
    precipitation_sum: 0,
    precipitation_probability_max: 20,
    sunrise: "2026-04-29T06:30",
    sunset: "2026-04-29T20:00",
    wind_speed_max: 18,
    weather_code: 2,
    uv_index_max: 7,
    ...overrides,
  };
}

function makeCtx(opts: {
  current: CurrentSnapshot;
  daily: DailyEntry[];
}): {
  ctx: WeatherContext;
  getCurrent: ReturnType<typeof vi.fn>;
  getDaily: ReturnType<typeof vi.fn>;
} {
  const getCurrent = vi.fn().mockResolvedValue(opts.current);
  const getDaily = vi.fn().mockResolvedValue({
    entries: opts.daily,
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
      getCurrent,
      getDaily,
    } as unknown as WeatherClient,
    defaults: {
      units: "imperial",
      location: undefined,
    },
  };
  return { ctx, getCurrent, getDaily };
}

// --- tests ----------------------------------------------------------------

describe("daily_brief — metadata", () => {
  it("has correct name and description", () => {
    expect(dailyBrief.name).toBe("daily_brief");
    expect(dailyBrief.description).toBe("Quick brief: now, today, tomorrow.");
  });
});

describe("daily_brief — output shape", () => {
  it("returns the five top-level keys", async () => {
    const { ctx } = makeCtx({
      current: currentSnap(),
      daily: [dailyEntry(), dailyEntry({ date: "2026-04-30" })],
    });
    const result = await dailyBrief.handler(
      { location: "Dallas" },
      ctx,
    );
    expect(Object.keys(result).sort()).toEqual([
      "brief",
      "current",
      "location",
      "today",
      "tomorrow",
    ]);
  });

  it("current has exactly the five expected keys", async () => {
    const { ctx } = makeCtx({
      current: currentSnap(),
      daily: [dailyEntry(), dailyEntry({ date: "2026-04-30" })],
    });
    const result = await dailyBrief.handler(
      { location: "Dallas" },
      ctx,
    );
    expect(Object.keys(result.current).sort()).toEqual([
      "conditions",
      "feels_like",
      "humidity",
      "temp",
      "wind",
    ]);
  });

  it("today has exactly the seven expected keys", async () => {
    const { ctx } = makeCtx({
      current: currentSnap(),
      daily: [dailyEntry(), dailyEntry({ date: "2026-04-30" })],
    });
    const result = await dailyBrief.handler(
      { location: "Dallas" },
      ctx,
    );
    expect(Object.keys(result.today).sort()).toEqual([
      "conditions",
      "high",
      "low",
      "precip_chance",
      "sunrise",
      "sunset",
      "wind_max",
    ]);
  });

  it("tomorrow has exactly the four expected keys (no sunrise/sunset/wind_max)", async () => {
    const { ctx } = makeCtx({
      current: currentSnap(),
      daily: [dailyEntry(), dailyEntry({ date: "2026-04-30" })],
    });
    const result = await dailyBrief.handler(
      { location: "Dallas" },
      ctx,
    );
    expect(Object.keys(result.tomorrow).sort()).toEqual([
      "conditions",
      "high",
      "low",
      "precip_chance",
    ]);
  });
});

describe("daily_brief — brief prose", () => {
  it("contains location name, current condition word, and today's high", async () => {
    const { ctx } = makeCtx({
      current: currentSnap({ temperature: 78, weather_code: 2 }),
      daily: [
        dailyEntry({ temp_max: 84, weather_code: 2 }),
        dailyEntry({ date: "2026-04-30", weather_code: 2 }),
      ],
    });
    const result = await dailyBrief.handler(
      { location: "Dallas" },
      ctx,
    );
    expect(result.brief).toContain("Dallas");
    // Current condition word ("partly cloudy" lowercased from weather code 2).
    expect(result.brief.toLowerCase()).toContain("partly cloudy");
    // Today's high.
    expect(result.brief).toContain("84F");
  });

  it("notes 'similar' when tomorrow's weather code matches today's", async () => {
    const { ctx } = makeCtx({
      current: currentSnap({ weather_code: 2 }),
      daily: [
        dailyEntry({ weather_code: 2, temp_max: 84 }),
        dailyEntry({ date: "2026-04-30", weather_code: 2, temp_max: 85 }),
      ],
    });
    const result = await dailyBrief.handler(
      { location: "Dallas" },
      ctx,
    );
    expect(result.brief.toLowerCase()).toContain("similar");
  });

  it("calls out tomorrow's contrast when weather codes differ", async () => {
    const { ctx } = makeCtx({
      current: currentSnap({ weather_code: 2 }),
      daily: [
        dailyEntry({ weather_code: 2, temp_max: 84 }),
        dailyEntry({
          date: "2026-04-30",
          weather_code: 61, // light rain
          temp_max: 70,
        }),
      ],
    });
    const result = await dailyBrief.handler(
      { location: "Dallas" },
      ctx,
    );
    expect(result.brief.toLowerCase()).not.toContain("similar");
    expect(result.brief.toLowerCase()).toContain("light rain");
    expect(result.brief).toContain("70F");
  });
});

describe("daily_brief — handler wiring", () => {
  it("calls getCurrent and getDaily(days=2) in parallel", async () => {
    const { ctx, getCurrent, getDaily } = makeCtx({
      current: currentSnap(),
      daily: [dailyEntry(), dailyEntry({ date: "2026-04-30" })],
    });
    await dailyBrief.handler({ location: "Dallas" }, ctx);
    expect(getCurrent).toHaveBeenCalledTimes(1);
    expect(getDaily).toHaveBeenCalledTimes(1);
    expect(getDaily).toHaveBeenCalledWith({
      lat: 32.7767,
      lng: -96.797,
      units: "imperial",
      days: 2,
    });
  });
});
