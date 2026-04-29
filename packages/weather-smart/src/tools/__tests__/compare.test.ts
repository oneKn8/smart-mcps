import { describe, it, expect, vi } from "vitest";
import { compareLocations } from "../compare.js";
import type { WeatherContext } from "../../context.js";
import type {
  WeatherClient,
  CurrentSnapshot,
  DailyEntry,
  HourlyEntry,
  GeocodeMatch,
} from "../../client.js";

// --- harness --------------------------------------------------------------

// Per-location fake stack. `geocode` returns a deterministic top match per
// query string, `getCurrent` / `getDaily` / `getHourly` are routed by lat so
// each location gets its own per-test fixture without collisions.
type LocationFixture = {
  query: string;
  match: GeocodeMatch;
  current?: CurrentSnapshot;
  daily?: DailyEntry[];
  hourly?: HourlyEntry[];
};

function dailyEntry(overrides: Partial<DailyEntry> = {}): DailyEntry {
  return {
    date: "2026-04-29",
    temp_max: 75,
    temp_min: 60,
    precipitation_sum: 0,
    precipitation_probability_max: 20,
    sunrise: "2026-04-29T06:30",
    sunset: "2026-04-29T20:00",
    wind_speed_max: 12,
    weather_code: 2,
    uv_index_max: 7,
    ...overrides,
  };
}

function currentSnap(overrides: Partial<CurrentSnapshot> = {}): CurrentSnapshot {
  return {
    time: "2026-04-29T13:00",
    temperature: 72,
    apparent_temperature: 72,
    humidity: 50,
    precipitation: 0,
    weather_code: 2,
    wind_speed: 10,
    wind_direction: 180,
    pressure: 1013,
    timezone: "America/Chicago",
    ...overrides,
  };
}

function hourlyEntry(overrides: Partial<HourlyEntry> = {}): HourlyEntry {
  return {
    time: "2026-04-29T13:00",
    temperature: 72,
    precipitation_probability: 15,
    precipitation: 0,
    weather_code: 2,
    wind_speed: 10,
    cloud_cover: 40,
    visibility: 50000,
    uv_index: 6,
    ...overrides,
  };
}

function makeMatch(
  name: string,
  lat: number,
  lng: number,
  admin1?: string,
): GeocodeMatch {
  return {
    name,
    lat,
    lng,
    timezone: "America/Chicago",
    admin1,
    country: "United States",
  };
}

function makeCtx(fixtures: LocationFixture[]): {
  ctx: WeatherContext;
  geocode: ReturnType<typeof vi.fn>;
  getCurrent: ReturnType<typeof vi.fn>;
  getDaily: ReturnType<typeof vi.fn>;
  getHourly: ReturnType<typeof vi.fn>;
} {
  const byQuery = new Map(fixtures.map((f) => [f.query, f.match]));
  const byLat = new Map(fixtures.map((f) => [f.match.lat, f]));

  const geocode = vi.fn(async (query: string) => {
    const match = byQuery.get(query);
    if (!match) throw new Error(`unexpected geocode query in test: ${query}`);
    return { matches: [match] };
  });

  const getCurrent = vi.fn(async (args: { lat: number }) => {
    const f = byLat.get(args.lat);
    if (!f?.current) {
      throw new Error(`unexpected getCurrent for lat=${args.lat}`);
    }
    return f.current;
  });

  const getDaily = vi.fn(async (args: { lat: number; days: number }) => {
    const f = byLat.get(args.lat);
    if (!f?.daily) {
      throw new Error(`unexpected getDaily for lat=${args.lat}`);
    }
    return {
      entries: f.daily.slice(0, args.days),
      timezone: "America/Chicago",
    };
  });

  const getHourly = vi.fn(async (args: { lat: number; hours: number }) => {
    const f = byLat.get(args.lat);
    if (!f?.hourly) {
      throw new Error(`unexpected getHourly for lat=${args.lat}`);
    }
    return {
      entries: f.hourly.slice(0, args.hours),
      timezone: "America/Chicago",
    };
  });

  const ctx: WeatherContext = {
    client: {
      geocode,
      getCurrent,
      getDaily,
      getHourly,
    } as unknown as WeatherClient,
    defaults: {
      units: "imperial",
      location: undefined,
    },
  };
  return { ctx, geocode, getCurrent, getDaily, getHourly };
}

// In production the MCP server parses raw input through the tool's
// inputSchema before dispatching — that's where ZodDefault for `when`
// materialises. Tests must mirror this so the handler reads "today" not
// undefined.
function call(
  rawInput: Parameters<typeof compareLocations.inputSchema.parse>[0],
  ctx: WeatherContext,
) {
  return compareLocations.handler(
    compareLocations.inputSchema.parse(rawInput),
    ctx,
  );
}

// --- tests ----------------------------------------------------------------

describe("compare_locations — schema", () => {
  it("rejects only 1 location, accepts 2 and 5, rejects 6", () => {
    const one = compareLocations.inputSchema.safeParse({
      locations: ["Dallas"],
    });
    expect(one.success).toBe(false);

    const two = compareLocations.inputSchema.safeParse({
      locations: ["Dallas", "Austin"],
    });
    expect(two.success).toBe(true);

    const five = compareLocations.inputSchema.safeParse({
      locations: ["A", "B", "C", "D", "E"],
    });
    expect(five.success).toBe(true);

    const six = compareLocations.inputSchema.safeParse({
      locations: ["A", "B", "C", "D", "E", "F"],
    });
    expect(six.success).toBe(false);
  });

  it("defaults `when` to 'today'", () => {
    const parsed = compareLocations.inputSchema.parse({
      locations: ["Dallas", "Austin"],
    });
    expect(parsed.when).toBe("today");
  });
});

describe("compare_locations — when branches", () => {
  it("when='today' uses getDaily(days=1), entries[0]", async () => {
    const fixtures: LocationFixture[] = [
      {
        query: "Dallas",
        match: makeMatch("Dallas", 32.78, -96.8, "Texas"),
        daily: [dailyEntry({ temp_max: 80 })],
      },
      {
        query: "Austin",
        match: makeMatch("Austin", 30.27, -97.74, "Texas"),
        daily: [dailyEntry({ temp_max: 84 })],
      },
    ];
    const { ctx, getDaily, getCurrent } = makeCtx(fixtures);
    const result = await call(
      { locations: ["Dallas", "Austin"] },
      ctx,
    );
    expect(getDaily).toHaveBeenCalledTimes(2);
    expect(getDaily).toHaveBeenCalledWith(
      expect.objectContaining({ days: 1, lat: 32.78 }),
    );
    expect(getCurrent).not.toHaveBeenCalled();
    expect(result.results[0]!.snapshot.temp).toBe("80F");
    expect(result.results[1]!.snapshot.temp).toBe("84F");
  });

  it("when='tomorrow' uses getDaily(days=2), snapshot from entries[1]", async () => {
    const fixtures: LocationFixture[] = [
      {
        query: "Dallas",
        match: makeMatch("Dallas", 32.78, -96.8, "Texas"),
        daily: [
          dailyEntry({ date: "2026-04-29", temp_max: 80 }),
          dailyEntry({ date: "2026-04-30", temp_max: 90 }),
        ],
      },
      {
        query: "Austin",
        match: makeMatch("Austin", 30.27, -97.74, "Texas"),
        daily: [
          dailyEntry({ date: "2026-04-29", temp_max: 75 }),
          dailyEntry({ date: "2026-04-30", temp_max: 95 }),
        ],
      },
    ];
    const { ctx, getDaily } = makeCtx(fixtures);
    const result = await call(
      { locations: ["Dallas", "Austin"], when: "tomorrow" },
      ctx,
    );
    expect(getDaily).toHaveBeenCalledWith(
      expect.objectContaining({ days: 2, lat: 32.78 }),
    );
    // Tomorrow snapshot is entries[1].
    expect(result.results[0]!.snapshot.temp).toBe("90F");
    expect(result.results[1]!.snapshot.temp).toBe("95F");
  });

  it("when='now' uses getCurrent and getHourly(hours=1) for precip_chance", async () => {
    const fixtures: LocationFixture[] = [
      {
        query: "Dallas",
        match: makeMatch("Dallas", 32.78, -96.8, "Texas"),
        current: currentSnap({ temperature: 72 }),
        hourly: [hourlyEntry({ precipitation_probability: 25 })],
      },
      {
        query: "Austin",
        match: makeMatch("Austin", 30.27, -97.74, "Texas"),
        current: currentSnap({ temperature: 78 }),
        hourly: [hourlyEntry({ precipitation_probability: 5 })],
      },
    ];
    const { ctx, getCurrent, getHourly, getDaily } = makeCtx(fixtures);
    const result = await call(
      { locations: ["Dallas", "Austin"], when: "now" },
      ctx,
    );
    expect(getCurrent).toHaveBeenCalledTimes(2);
    expect(getHourly).toHaveBeenCalledWith(
      expect.objectContaining({ hours: 1, lat: 32.78 }),
    );
    expect(getDaily).not.toHaveBeenCalled();
    expect(result.results[0]!.snapshot.precip_chance).toBe("25%");
    expect(result.results[1]!.snapshot.precip_chance).toBe("5%");
  });
});

describe("compare_locations — best_for ranking", () => {
  it("dry picks the lowest precipitation probability", async () => {
    const fixtures: LocationFixture[] = [
      {
        query: "Dallas",
        match: makeMatch("Dallas", 32.78, -96.8, "Texas"),
        daily: [dailyEntry({ precipitation_probability_max: 60 })],
      },
      {
        query: "Phoenix",
        match: makeMatch("Phoenix", 33.45, -112.07, "Arizona"),
        daily: [dailyEntry({ precipitation_probability_max: 5 })],
      },
      {
        query: "Seattle",
        match: makeMatch("Seattle", 47.6, -122.33, "Washington"),
        daily: [dailyEntry({ precipitation_probability_max: 80 })],
      },
    ];
    const { ctx } = makeCtx(fixtures);
    const result = await call(
      { locations: ["Dallas", "Phoenix", "Seattle"] },
      ctx,
    );
    expect(result.best_for.dry).toBe("Phoenix, Arizona, United States");
  });

  it("dry breaks ties via first occurrence", async () => {
    const fixtures: LocationFixture[] = [
      {
        query: "Dallas",
        match: makeMatch("Dallas", 32.78, -96.8, "Texas"),
        daily: [dailyEntry({ precipitation_probability_max: 10 })],
      },
      {
        query: "Austin",
        match: makeMatch("Austin", 30.27, -97.74, "Texas"),
        daily: [dailyEntry({ precipitation_probability_max: 10 })],
      },
    ];
    const { ctx } = makeCtx(fixtures);
    const result = await call(
      { locations: ["Dallas", "Austin"] },
      ctx,
    );
    expect(result.best_for.dry).toBe("Dallas, Texas, United States");
  });

  it("mild picks the temperature closest to 70F under imperial", async () => {
    // 65 is delta 5, 73 is delta 3, 90 is delta 20 → 73F wins.
    const fixtures: LocationFixture[] = [
      {
        query: "Dallas",
        match: makeMatch("Dallas", 32.78, -96.8, "Texas"),
        daily: [dailyEntry({ temp_max: 65 })],
      },
      {
        query: "Austin",
        match: makeMatch("Austin", 30.27, -97.74, "Texas"),
        daily: [dailyEntry({ temp_max: 73 })],
      },
      {
        query: "Phoenix",
        match: makeMatch("Phoenix", 33.45, -112.07, "Arizona"),
        daily: [dailyEntry({ temp_max: 90 })],
      },
    ];
    const { ctx } = makeCtx(fixtures);
    const result = await call(
      { locations: ["Dallas", "Austin", "Phoenix"] },
      ctx,
    );
    expect(result.best_for.mild).toBe("Austin, Texas, United States");
  });

  it("sun (daily) picks highest UV index", async () => {
    const fixtures: LocationFixture[] = [
      {
        query: "Seattle",
        match: makeMatch("Seattle", 47.6, -122.33, "Washington"),
        daily: [dailyEntry({ uv_index_max: 3 })],
      },
      {
        query: "Phoenix",
        match: makeMatch("Phoenix", 33.45, -112.07, "Arizona"),
        daily: [dailyEntry({ uv_index_max: 11 })],
      },
    ];
    const { ctx } = makeCtx(fixtures);
    const result = await call(
      { locations: ["Seattle", "Phoenix"] },
      ctx,
    );
    expect(result.best_for.sun).toBe("Phoenix, Arizona, United States");
  });

  it("sun (now) picks lowest cloud cover via hourly[0]", async () => {
    const fixtures: LocationFixture[] = [
      {
        query: "Dallas",
        match: makeMatch("Dallas", 32.78, -96.8, "Texas"),
        current: currentSnap(),
        hourly: [hourlyEntry({ cloud_cover: 80 })],
      },
      {
        query: "Phoenix",
        match: makeMatch("Phoenix", 33.45, -112.07, "Arizona"),
        current: currentSnap(),
        hourly: [hourlyEntry({ cloud_cover: 5 })],
      },
    ];
    const { ctx } = makeCtx(fixtures);
    const result = await call(
      { locations: ["Dallas", "Phoenix"], when: "now" },
      ctx,
    );
    expect(result.best_for.sun).toBe("Phoenix, Arizona, United States");
  });
});

describe("compare_locations — output shape and concurrency", () => {
  it("returns the four expected top-level keys, plus result keys", async () => {
    const fixtures: LocationFixture[] = [
      {
        query: "Dallas",
        match: makeMatch("Dallas", 32.78, -96.8, "Texas"),
        daily: [dailyEntry()],
      },
      {
        query: "Austin",
        match: makeMatch("Austin", 30.27, -97.74, "Texas"),
        daily: [dailyEntry()],
      },
    ];
    const { ctx } = makeCtx(fixtures);
    const result = await call(
      { locations: ["Dallas", "Austin"] },
      ctx,
    );
    expect(Object.keys(result).sort()).toEqual([
      "best_for",
      "results",
      "summary",
      "when",
    ]);
    expect(Object.keys(result.results[0]!).sort()).toEqual([
      "lat",
      "lng",
      "name",
      "snapshot",
      "timezone",
    ]);
    expect(Object.keys(result.results[0]!.snapshot).sort()).toEqual([
      "conditions",
      "precip_chance",
      "temp",
      "wind",
    ]);
    expect(Object.keys(result.best_for).sort()).toEqual([
      "dry",
      "mild",
      "sun",
    ]);
  });

  it("geocodes every location exactly once", async () => {
    const fixtures: LocationFixture[] = [
      {
        query: "Dallas",
        match: makeMatch("Dallas", 32.78, -96.8, "Texas"),
        daily: [dailyEntry()],
      },
      {
        query: "Austin",
        match: makeMatch("Austin", 30.27, -97.74, "Texas"),
        daily: [dailyEntry()],
      },
      {
        query: "Phoenix",
        match: makeMatch("Phoenix", 33.45, -112.07, "Arizona"),
        daily: [dailyEntry()],
      },
    ];
    const { ctx, geocode } = makeCtx(fixtures);
    await call(
      { locations: ["Dallas", "Austin", "Phoenix"] },
      ctx,
    );
    expect(geocode).toHaveBeenCalledTimes(3);
    expect(geocode).toHaveBeenCalledWith("Dallas");
    expect(geocode).toHaveBeenCalledWith("Austin");
    expect(geocode).toHaveBeenCalledWith("Phoenix");
  });

  it("has correct name and description", () => {
    expect(compareLocations.name).toBe("compare_locations");
    expect(compareLocations.description).toBe(
      "Compare weather across 2-5 locations.",
    );
  });
});
