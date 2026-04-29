import { describe, it, expect, vi } from "vitest";
import { getForecast, getHourly } from "../forecast.js";
import type { WeatherContext } from "../../context.js";
import type {
  WeatherClient,
  DailyEntry,
  HourlyEntry,
} from "../../client.js";

// --- daily test harness ---------------------------------------------------

function dailyEntry(overrides: Partial<DailyEntry> = {}): DailyEntry {
  return {
    date: "2026-04-29",
    temp_max: 80,
    temp_min: 60,
    precipitation_sum: 0.1,
    precipitation_probability_max: 30,
    sunrise: "2026-04-29T06:30",
    sunset: "2026-04-29T20:00",
    wind_speed_max: 15,
    weather_code: 2,
    uv_index_max: 7,
    ...overrides,
  };
}

function makeDailyCtx(opts: {
  entries: DailyEntry[];
  defaultUnits?: "metric" | "imperial";
}): {
  ctx: WeatherContext;
  getDaily: ReturnType<typeof vi.fn>;
} {
  const getDaily = vi.fn().mockResolvedValue({
    entries: opts.entries,
    timezone: "America/Chicago",
  });
  const ctx: WeatherContext = {
    client: {
      geocode: vi.fn(),
      getDaily,
    } as unknown as WeatherClient,
    defaults: {
      units: opts.defaultUnits ?? "imperial",
      location: undefined,
    },
  };
  return { ctx, getDaily };
}

// --- hourly test harness --------------------------------------------------

function hourlyEntry(overrides: Partial<HourlyEntry> = {}): HourlyEntry {
  return {
    time: "2026-04-29T12:00",
    temperature: 72,
    precipitation_probability: 30,
    precipitation: 0,
    weather_code: 1,
    wind_speed: 8,
    cloud_cover: 20,
    visibility: 24144, // ~4.57 mi if imperial (feet)
    uv_index: 5,
    ...overrides,
  };
}

function makeHourlyCtx(opts: {
  entries: HourlyEntry[];
  defaultUnits?: "metric" | "imperial";
}): {
  ctx: WeatherContext;
  getHourly: ReturnType<typeof vi.fn>;
} {
  const getHourly = vi.fn().mockResolvedValue({
    entries: opts.entries,
    timezone: "America/Chicago",
  });
  const ctx: WeatherContext = {
    client: {
      geocode: vi.fn(),
      getHourly,
    } as unknown as WeatherClient,
    defaults: {
      units: opts.defaultUnits ?? "imperial",
      location: undefined,
    },
  };
  return { ctx, getHourly };
}

// --- get_forecast tests ---------------------------------------------------

describe("get_forecast — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getForecast.name).toBe("get_forecast");
    expect(getForecast.description).toBe("Daily forecast for 1-16 days.");
  });

  it("schema rejects days=0", () => {
    const result = getForecast.inputSchema.safeParse({ days: 0 });
    expect(result.success).toBe(false);
  });

  it("schema rejects days=17", () => {
    const result = getForecast.inputSchema.safeParse({ days: 17 });
    expect(result.success).toBe(false);
  });

  it("schema defaults days to 7 when omitted", () => {
    const parsed = getForecast.inputSchema.parse({}) as { days: number };
    expect(parsed.days).toBe(7);
  });
});

describe("get_forecast — handler", () => {
  it("forwards days=1 to client.getDaily", async () => {
    const { ctx, getDaily } = makeDailyCtx({ entries: [dailyEntry()] });
    await getForecast.handler({ lat: 0, lng: 0, days: 1 }, ctx);
    expect(getDaily).toHaveBeenCalledWith({
      lat: 0,
      lng: 0,
      units: "imperial",
      days: 1,
    });
  });

  it("forwards days=16 to client.getDaily", async () => {
    const entries = Array.from({ length: 16 }, (_, i) =>
      dailyEntry({ date: `2026-04-${String(i + 1).padStart(2, "0")}` }),
    );
    const { ctx, getDaily } = makeDailyCtx({ entries });
    await getForecast.handler({ lat: 0, lng: 0, days: 16 }, ctx);
    expect(getDaily).toHaveBeenCalledWith({
      lat: 0,
      lng: 0,
      units: "imperial",
      days: 16,
    });
  });

  it("daily array length matches entries length", async () => {
    const entries = Array.from({ length: 3 }, (_, i) =>
      dailyEntry({ date: `2026-04-${String(i + 1).padStart(2, "0")}` }),
    );
    const { ctx } = makeDailyCtx({ entries });
    const result = await getForecast.handler(
      { lat: 0, lng: 0, days: 3 },
      ctx,
    );
    expect(result.daily).toHaveLength(3);
  });

  it("each daily entry has exactly the 10 expected keys", async () => {
    const { ctx } = makeDailyCtx({ entries: [dailyEntry()] });
    const result = await getForecast.handler(
      { lat: 0, lng: 0, days: 1 },
      ctx,
    );
    expect(Object.keys(result.daily[0]!).sort()).toEqual([
      "conditions",
      "date",
      "high",
      "low",
      "precip_chance",
      "precip_total",
      "sunrise",
      "sunset",
      "uv_max",
      "wind_max",
    ]);
  });

  it("preserves sunrise/sunset values from upstream", async () => {
    const { ctx } = makeDailyCtx({
      entries: [
        dailyEntry({
          sunrise: "2026-04-29T06:42",
          sunset: "2026-04-29T19:58",
        }),
      ],
    });
    const result = await getForecast.handler(
      { lat: 0, lng: 0, days: 1 },
      ctx,
    );
    expect(result.daily[0]!.sunrise).toBe("2026-04-29T06:42");
    expect(result.daily[0]!.sunset).toBe("2026-04-29T19:58");
  });
});

// --- get_hourly tests -----------------------------------------------------

describe("get_hourly — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getHourly.name).toBe("get_hourly");
    expect(getHourly.description).toBe("Hourly forecast for 1-48 hours.");
  });

  it("schema rejects hours=0", () => {
    const result = getHourly.inputSchema.safeParse({ hours: 0 });
    expect(result.success).toBe(false);
  });

  it("schema rejects hours=49", () => {
    const result = getHourly.inputSchema.safeParse({ hours: 49 });
    expect(result.success).toBe(false);
  });

  it("schema defaults hours to 24 when omitted", () => {
    const parsed = getHourly.inputSchema.parse({}) as { hours: number };
    expect(parsed.hours).toBe(24);
  });
});

describe("get_hourly — handler", () => {
  it("forwards hours=1 to client.getHourly", async () => {
    const { ctx, getHourly: stub } = makeHourlyCtx({
      entries: [hourlyEntry()],
    });
    await getHourly.handler({ lat: 0, lng: 0, hours: 1 }, ctx);
    expect(stub).toHaveBeenCalledWith({
      lat: 0,
      lng: 0,
      units: "imperial",
      hours: 1,
    });
  });

  it("forwards hours=48 to client.getHourly", async () => {
    const entries = Array.from({ length: 48 }, () => hourlyEntry());
    const { ctx, getHourly: stub } = makeHourlyCtx({ entries });
    await getHourly.handler({ lat: 0, lng: 0, hours: 48 }, ctx);
    expect(stub).toHaveBeenCalledWith({
      lat: 0,
      lng: 0,
      units: "imperial",
      hours: 48,
    });
  });

  it("formats precip_chance as a percent string", async () => {
    const { ctx } = makeHourlyCtx({
      entries: [hourlyEntry({ precipitation_probability: 30 })],
    });
    const result = await getHourly.handler(
      { lat: 0, lng: 0, hours: 1 },
      ctx,
    );
    expect(result.hourly[0]!.precip_chance).toBe("30%");
  });
});
