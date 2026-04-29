import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { sunsetCheck } from "../sunset.js";
import type { WeatherContext } from "../../context.js";
import type {
  WeatherClient,
  DailyEntry,
  HourlyEntry,
} from "../../client.js";

// Pin TZ so formatHourLabel renders deterministically across CI machines.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// --- harness --------------------------------------------------------------

function dailyEntry(overrides: Partial<DailyEntry> = {}): DailyEntry {
  return {
    date: "2026-04-29",
    temp_max: 75,
    temp_min: 60,
    precipitation_sum: 0,
    precipitation_probability_max: 10,
    sunrise: "2026-04-29T06:30",
    sunset: "2026-04-29T19:00",
    wind_speed_max: 12,
    weather_code: 2,
    uv_index_max: 7,
    ...overrides,
  };
}

// Imperial-friendly default hourly entry. visibility 50000ft ≈ 9.5mi (well
// past the "great" 6mi threshold). cloud_cover 50 sits in the great band.
function hourlyEntry(overrides: Partial<HourlyEntry> = {}): HourlyEntry {
  return {
    time: "2026-04-29T19:00",
    temperature: 70,
    precipitation_probability: 5,
    precipitation: 0,
    weather_code: 2,
    wind_speed: 8,
    cloud_cover: 50,
    visibility: 50000,
    uv_index: 1,
    ...overrides,
  };
}

// 24-entry day with the entry at hour 19 supplied separately so tests can
// pin the sunset-hour conditions while leaving the other hours benign.
function dayHours(date: string, sunsetHour: Partial<HourlyEntry>): HourlyEntry[] {
  return Array.from({ length: 24 }, (_, h) => {
    const time = `${date}T${String(h).padStart(2, "0")}:00`;
    if (h === 19) return hourlyEntry({ time, ...sunsetHour });
    return hourlyEntry({ time });
  });
}

function makeCtx(opts: {
  daily: DailyEntry[];
  hourly: HourlyEntry[];
  units?: "metric" | "imperial";
}): {
  ctx: WeatherContext;
  getDaily: ReturnType<typeof vi.fn>;
  getHourly: ReturnType<typeof vi.fn>;
} {
  const getDaily = vi.fn(async (args: { days: number }) => ({
    entries: opts.daily.slice(0, args.days),
    timezone: "America/Chicago",
  }));
  const getHourly = vi.fn(async (args: { hours: number }) => ({
    entries: opts.hourly.slice(0, args.hours),
    timezone: "America/Chicago",
  }));
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
      getDaily,
      getHourly,
    } as unknown as WeatherClient,
    defaults: {
      units: opts.units ?? "imperial",
      location: undefined,
    },
  };
  return { ctx, getDaily, getHourly };
}

function call(
  rawInput: Parameters<typeof sunsetCheck.inputSchema.parse>[0],
  ctx: WeatherContext,
) {
  return sunsetCheck.handler(
    sunsetCheck.inputSchema.parse(rawInput),
    ctx,
  );
}

// --- tests ----------------------------------------------------------------

describe("sunset_check — schema", () => {
  it("defaults date_offset to 0", () => {
    const parsed = sunsetCheck.inputSchema.parse({ location: "Dallas" });
    expect(parsed.date_offset).toBe(0);
  });

  it("rejects date_offset = 8", () => {
    const parsed = sunsetCheck.inputSchema.safeParse({
      location: "Dallas",
      date_offset: 8,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("sunset_check — date offset wiring", () => {
  it("date_offset=0 fetches getDaily(days=1) and getHourly(hours=24)", async () => {
    const { ctx, getDaily, getHourly } = makeCtx({
      daily: [dailyEntry({ sunset: "2026-04-29T19:00" })],
      hourly: dayHours("2026-04-29", {}),
    });
    const result = await call({ location: "Dallas" }, ctx);
    expect(getDaily).toHaveBeenCalledWith(
      expect.objectContaining({ days: 1 }),
    );
    expect(getHourly).toHaveBeenCalledWith(
      expect.objectContaining({ hours: 24 }),
    );
    expect(result.date).toBe("2026-04-29");
    expect(result.sunset).toBe("2026-04-29T19:00");
  });

  it("date_offset=1 (tomorrow) fetches getDaily(days=2), entries[1] sunset", async () => {
    const { ctx, getDaily, getHourly } = makeCtx({
      daily: [
        dailyEntry({ date: "2026-04-29", sunset: "2026-04-29T19:00" }),
        dailyEntry({ date: "2026-04-30", sunset: "2026-04-30T19:01" }),
      ],
      hourly: [
        ...dayHours("2026-04-29", {}),
        ...dayHours("2026-04-30", {}),
      ],
    });
    const result = await call({ location: "Dallas", date_offset: 1 }, ctx);
    expect(getDaily).toHaveBeenCalledWith(
      expect.objectContaining({ days: 2 }),
    );
    expect(getHourly).toHaveBeenCalledWith(
      expect.objectContaining({ hours: 48 }),
    );
    expect(result.date).toBe("2026-04-30");
    expect(result.sunset).toBe("2026-04-30T19:01");
  });
});

describe("sunset_check — viewing quality", () => {
  it("classifies 50% clouds + 5% precip + high visibility + light wind as 'great'", async () => {
    const { ctx } = makeCtx({
      daily: [dailyEntry({ sunset: "2026-04-29T19:00" })],
      hourly: dayHours("2026-04-29", {
        cloud_cover: 50,
        precipitation_probability: 5,
        visibility: 50000, // ~9.5mi, past the 6mi threshold
        wind_speed: 10,
      }),
    });
    const result = await call({ location: "Dallas" }, ctx);
    expect(result.viewing_quality).toBe("great");
    expect(result.summary.toLowerCase()).toContain("great");
  });

  it("classifies 100% clouds as 'poor'", async () => {
    const { ctx } = makeCtx({
      daily: [dailyEntry({ sunset: "2026-04-29T19:00" })],
      hourly: dayHours("2026-04-29", {
        cloud_cover: 100,
        precipitation_probability: 5,
        visibility: 50000,
        wind_speed: 10,
      }),
    });
    const result = await call({ location: "Dallas" }, ctx);
    expect(result.viewing_quality).toBe("poor");
    expect(result.summary.toLowerCase()).toContain("cloud");
  });

  it("classifies 50% precip chance as 'poor'", async () => {
    const { ctx } = makeCtx({
      daily: [dailyEntry({ sunset: "2026-04-29T19:00" })],
      hourly: dayHours("2026-04-29", {
        cloud_cover: 60,
        precipitation_probability: 50,
        visibility: 50000,
        wind_speed: 10,
      }),
    });
    const result = await call({ location: "Dallas" }, ctx);
    expect(result.viewing_quality).toBe("poor");
    expect(result.summary.toLowerCase()).toContain("rain");
  });

  it("classifies 80% clouds + 15% precip as 'good' (relaxed band)", async () => {
    const { ctx } = makeCtx({
      daily: [dailyEntry({ sunset: "2026-04-29T19:00" })],
      hourly: dayHours("2026-04-29", {
        cloud_cover: 80,
        precipitation_probability: 15,
        visibility: 50000,
        wind_speed: 10,
      }),
    });
    const result = await call({ location: "Dallas" }, ctx);
    expect(result.viewing_quality).toBe("good");
    expect(result.summary.toLowerCase()).toContain("decent");
  });
});

describe("sunset_check — output shape and formatters", () => {
  it("returns the seven expected top-level keys", async () => {
    const { ctx } = makeCtx({
      daily: [dailyEntry({ sunset: "2026-04-29T19:00" })],
      hourly: dayHours("2026-04-29", {}),
    });
    const result = await call({ location: "Dallas" }, ctx);
    expect(Object.keys(result).sort()).toEqual([
      "conditions_at_sunset",
      "date",
      "location",
      "summary",
      "sunset",
      "viewing_quality",
    ].sort());
  });

  it("conditions_at_sunset uses unit-suffixed strings (imperial)", async () => {
    const { ctx } = makeCtx({
      daily: [dailyEntry({ sunset: "2026-04-29T19:00" })],
      hourly: dayHours("2026-04-29", {
        cloud_cover: 45,
        temperature: 72,
        precipitation_probability: 8,
        visibility: 42240, // 8mi
        wind_speed: 12,
      }),
    });
    const result = await call({ location: "Dallas" }, ctx);
    expect(result.conditions_at_sunset.cloud_cover).toBe("45%");
    expect(result.conditions_at_sunset.temp).toBe("72F");
    expect(result.conditions_at_sunset.precip_chance).toBe("8%");
    expect(result.conditions_at_sunset.visibility).toBe("8.0mi");
    expect(result.conditions_at_sunset.wind).toBe("12mph");
  });

  it("summary mentions the hour label (7pm) and cloud cover", async () => {
    const { ctx } = makeCtx({
      daily: [dailyEntry({ sunset: "2026-04-29T19:00" })],
      hourly: dayHours("2026-04-29", {
        cloud_cover: 40,
        precipitation_probability: 5,
        visibility: 50000,
        wind_speed: 8,
      }),
    });
    const result = await call({ location: "Dallas" }, ctx);
    expect(result.summary).toContain("7pm");
    expect(result.summary).toContain("40%");
  });

  it("has correct name and description", () => {
    expect(sunsetCheck.name).toBe("sunset_check");
    expect(sunsetCheck.description).toBe(
      "Sunset time and viewing conditions.",
    );
  });
});

describe("sunset_check — closest hour selection", () => {
  it("picks the hourly entry whose time is closest to sunset", async () => {
    // Sunset at 19:20 — hour 19 (delta 20min) wins over hour 20 (delta 40min).
    const day = dayHours("2026-04-29", {});
    // Override hour 19 visibly so we can confirm it was chosen.
    const idx19 = day.findIndex((e) => e.time === "2026-04-29T19:00");
    day[idx19] = hourlyEntry({
      time: "2026-04-29T19:00",
      cloud_cover: 33,
    });
    const idx20 = day.findIndex((e) => e.time === "2026-04-29T20:00");
    day[idx20] = hourlyEntry({
      time: "2026-04-29T20:00",
      cloud_cover: 99,
    });
    const { ctx } = makeCtx({
      daily: [dailyEntry({ sunset: "2026-04-29T19:20" })],
      hourly: day,
    });
    const result = await call({ location: "Dallas" }, ctx);
    expect(result.conditions_at_sunset.cloud_cover).toBe("33%");
  });
});
