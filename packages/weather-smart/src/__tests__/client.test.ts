import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WeatherClient } from "../client.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let savedUnits: string | undefined;
let savedLocation: string | undefined;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUnits = process.env.WEATHER_DEFAULT_UNITS;
  savedLocation = process.env.WEATHER_DEFAULT_LOCATION;
  // Point HOME at a unique tmp dir that does NOT contain
  // .config/smart-mcps/.env so loadCreds cannot leak real credentials.
  const home = join(tmpdir(), `weather-smart-test-${Date.now()}-${Math.random()}`);
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  delete process.env.WEATHER_DEFAULT_UNITS;
  delete process.env.WEATHER_DEFAULT_LOCATION;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUnits === undefined) delete process.env.WEATHER_DEFAULT_UNITS;
  else process.env.WEATHER_DEFAULT_UNITS = savedUnits;
  if (savedLocation === undefined) delete process.env.WEATHER_DEFAULT_LOCATION;
  else process.env.WEATHER_DEFAULT_LOCATION = savedLocation;
});

describe("WeatherClient — constructor", () => {
  it("succeeds with no env vars set (no required creds)", () => {
    expect(() => new WeatherClient()).not.toThrow();
  });

  it("reads WEATHER_DEFAULT_UNITS from process.env", () => {
    process.env.WEATHER_DEFAULT_UNITS = "imperial";
    const client = new WeatherClient();
    expect(client.getDefaultUnits()).toBe("imperial");
  });

  it("accepts WEATHER_DEFAULT_UNITS=metric", () => {
    process.env.WEATHER_DEFAULT_UNITS = "metric";
    const client = new WeatherClient();
    expect(client.getDefaultUnits()).toBe("metric");
  });

  it("reads WEATHER_DEFAULT_LOCATION from process.env", () => {
    process.env.WEATHER_DEFAULT_LOCATION = "Dallas";
    const client = new WeatherClient();
    expect(client.getDefaultLocation()).toBe("Dallas");
  });

  it("throws when WEATHER_DEFAULT_UNITS is not 'metric' or 'imperial'", () => {
    process.env.WEATHER_DEFAULT_UNITS = "foo";
    expect(() => new WeatherClient()).toThrow(
      /WEATHER_DEFAULT_UNITS.*foo/,
    );
  });
});

describe("WeatherClient.geocode", () => {
  const mockResults = {
    results: [
      {
        id: 4684888,
        name: "Dallas",
        latitude: 32.7767,
        longitude: -96.797,
        elevation: 137,
        feature_code: "PPLA2",
        country_code: "US",
        admin1_id: 4736286,
        timezone: "America/Chicago",
        population: 1304379,
        country: "United States",
        admin1: "Texas",
        admin2: "Dallas County",
      },
      {
        id: 4192205,
        name: "Dallas",
        latitude: 33.918,
        longitude: -84.6402,
        timezone: "America/New_York",
        country: "United States",
        admin1: "Georgia",
      },
    ],
    generationtime_ms: 0.6,
  };

  it("calls Open-Meteo geocoding API and maps results to GeocodeMatch[]", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://geocoding-api.open-meteo.com/v1/search",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json(mockResults);
        },
      ),
    );
    const client = new WeatherClient();
    const result = await client.geocode("Dallas");
    expect(seenUrl).toContain("name=Dallas");
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toEqual({
      name: "Dallas",
      lat: 32.7767,
      lng: -96.797,
      timezone: "America/Chicago",
      country: "United States",
      admin1: "Texas",
      admin2: "Dallas County",
      elevation: 137,
      population: 1304379,
    });
  });

  it("returns { matches: [] } when the response has no results field", async () => {
    server.use(
      http.get("https://geocoding-api.open-meteo.com/v1/search", () =>
        HttpResponse.json({ generationtime_ms: 0.4 }),
      ),
    );
    const client = new WeatherClient();
    const result = await client.geocode("Atlantis");
    expect(result.matches).toEqual([]);
  });

  it("populates cache: second call does not hit the network", async () => {
    let calls = 0;
    server.use(
      http.get("https://geocoding-api.open-meteo.com/v1/search", () => {
        calls++;
        return HttpResponse.json(mockResults);
      }),
    );
    const client = new WeatherClient();
    await client.geocode("Dallas");
    await client.geocode("Dallas");
    expect(calls).toBe(1);
  });

  it("query string includes count, language, and format params", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://geocoding-api.open-meteo.com/v1/search",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json(mockResults);
        },
      ),
    );
    const client = new WeatherClient();
    await client.geocode("Dallas");
    expect(seenUrl).toContain("count=5");
    expect(seenUrl).toContain("language=en");
    expect(seenUrl).toContain("format=json");
  });

  it("uses the limit param in the count query string", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://geocoding-api.open-meteo.com/v1/search",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json(mockResults);
        },
      ),
    );
    const client = new WeatherClient();
    await client.geocode("Dallas", 3);
    expect(seenUrl).toContain("count=3");
  });

  it("different limits produce distinct cache keys", async () => {
    let calls = 0;
    server.use(
      http.get("https://geocoding-api.open-meteo.com/v1/search", () => {
        calls++;
        return HttpResponse.json(mockResults);
      }),
    );
    const client = new WeatherClient();
    await client.geocode("Dallas", 5);
    await client.geocode("Dallas", 3);
    expect(calls).toBe(2);
  });

  it("different queries produce distinct cache keys", async () => {
    let calls = 0;
    server.use(
      http.get("https://geocoding-api.open-meteo.com/v1/search", () => {
        calls++;
        return HttpResponse.json(mockResults);
      }),
    );
    const client = new WeatherClient();
    await client.geocode("Dallas");
    await client.geocode("Austin");
    expect(calls).toBe(2);
  });

  it("maps optional fields to undefined when missing in upstream response", async () => {
    server.use(
      http.get("https://geocoding-api.open-meteo.com/v1/search", () =>
        HttpResponse.json({
          results: [
            {
              name: "MinimalCity",
              latitude: 1.23,
              longitude: 4.56,
              timezone: "UTC",
            },
          ],
        }),
      ),
    );
    const client = new WeatherClient();
    const result = await client.geocode("MinimalCity");
    expect(result.matches[0]).toEqual({
      name: "MinimalCity",
      lat: 1.23,
      lng: 4.56,
      timezone: "UTC",
      country: undefined,
      admin1: undefined,
      admin2: undefined,
      elevation: undefined,
      population: undefined,
    });
  });
});

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const mockCurrent = {
  latitude: 32.7767,
  longitude: -96.797,
  timezone: "America/Chicago",
  current: {
    time: "2026-04-29T14:00",
    temperature_2m: 78.4,
    relative_humidity_2m: 45,
    precipitation: 0,
    weather_code: 1,
    wind_speed_10m: 12.3,
    wind_direction_10m: 180,
    apparent_temperature: 80.1,
    pressure_msl: 1015.2,
  },
};

describe("WeatherClient.getCurrent", () => {
  it("maps Open-Meteo current response to slim CurrentSnapshot shape", async () => {
    server.use(
      http.get(FORECAST_URL, () => HttpResponse.json(mockCurrent)),
    );
    const client = new WeatherClient();
    const result = await client.getCurrent({
      lat: 32.7767,
      lng: -96.797,
      units: "imperial",
    });
    expect(result).toEqual({
      time: "2026-04-29T14:00",
      temperature: 78.4,
      apparent_temperature: 80.1,
      humidity: 45,
      precipitation: 0,
      weather_code: 1,
      wind_speed: 12.3,
      wind_direction: 180,
      pressure: 1015.2,
      timezone: "America/Chicago",
    });
  });

  it("imperial units pass fahrenheit/mph/inch unit params", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(FORECAST_URL, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockCurrent);
      }),
    );
    const client = new WeatherClient();
    await client.getCurrent({ lat: 32.7767, lng: -96.797, units: "imperial" });
    const url = new URL(seenUrl!);
    expect(url.searchParams.get("temperature_unit")).toBe("fahrenheit");
    expect(url.searchParams.get("windspeed_unit")).toBe("mph");
    expect(url.searchParams.get("precipitation_unit")).toBe("inch");
  });

  it("metric units pass celsius/kmh/mm unit params", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(FORECAST_URL, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockCurrent);
      }),
    );
    const client = new WeatherClient();
    await client.getCurrent({ lat: 32.7767, lng: -96.797, units: "metric" });
    const url = new URL(seenUrl!);
    expect(url.searchParams.get("temperature_unit")).toBe("celsius");
    expect(url.searchParams.get("windspeed_unit")).toBe("kmh");
    expect(url.searchParams.get("precipitation_unit")).toBe("mm");
  });

  it("sends timezone=auto in the query string", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(FORECAST_URL, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockCurrent);
      }),
    );
    const client = new WeatherClient();
    await client.getCurrent({ lat: 32.7767, lng: -96.797, units: "metric" });
    const url = new URL(seenUrl!);
    expect(url.searchParams.get("timezone")).toBe("auto");
  });

  it("populates cache: second call does not hit network", async () => {
    let calls = 0;
    server.use(
      http.get(FORECAST_URL, () => {
        calls++;
        return HttpResponse.json(mockCurrent);
      }),
    );
    const client = new WeatherClient();
    const args = { lat: 32.7767, lng: -96.797, units: "metric" as const };
    await client.getCurrent(args);
    await client.getCurrent(args);
    expect(calls).toBe(1);
  });

  it("retries on 429 and ultimately succeeds", async () => {
    let calls = 0;
    server.use(
      http.get(FORECAST_URL, () => {
        calls++;
        if (calls === 1) {
          return new HttpResponse(null, {
            status: 429,
            headers: { "retry-after": "0" },
          });
        }
        return HttpResponse.json(mockCurrent);
      }),
    );
    const client = new WeatherClient();
    const result = await client.getCurrent({
      lat: 32.7767,
      lng: -96.797,
      units: "metric",
    });
    expect(result.temperature).toBe(78.4);
    expect(calls).toBe(2);
  });
});

const mockHourly3 = {
  timezone: "America/Chicago",
  hourly: {
    time: ["2026-04-29T00:00", "2026-04-29T01:00", "2026-04-29T02:00"],
    temperature_2m: [72.5, 71.8, 71.2],
    precipitation_probability: [10, 15, 20],
    precipitation: [0, 0, 0.05],
    weather_code: [1, 2, 3],
    wind_speed_10m: [8.2, 7.5, 6.9],
    cloud_cover: [25, 40, 60],
    visibility: [10, 9, 8],
    uv_index: [4, 3, 2],
  },
};

function makeHourly24() {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const precipitation_probability: number[] = [];
  const precipitation: number[] = [];
  const weather_code: number[] = [];
  const wind_speed_10m: number[] = [];
  const cloud_cover: number[] = [];
  const visibility: number[] = [];
  const uv_index: number[] = [];
  for (let i = 0; i < 24; i++) {
    time.push(`2026-04-29T${String(i).padStart(2, "0")}:00`);
    temperature_2m.push(70 + i);
    precipitation_probability.push(i);
    precipitation.push(0);
    weather_code.push(1);
    wind_speed_10m.push(5 + i);
    cloud_cover.push(20);
    visibility.push(10);
    uv_index.push(2);
  }
  return {
    timezone: "America/Chicago",
    hourly: {
      time,
      temperature_2m,
      precipitation_probability,
      precipitation,
      weather_code,
      wind_speed_10m,
      cloud_cover,
      visibility,
      uv_index,
    },
  };
}

describe("WeatherClient.getHourly", () => {
  it("zips parallel arrays into row-major HourlyEntry[]", async () => {
    server.use(http.get(FORECAST_URL, () => HttpResponse.json(mockHourly3)));
    const client = new WeatherClient();
    const result = await client.getHourly({
      lat: 32.7767,
      lng: -96.797,
      units: "imperial",
      hours: 3,
    });
    expect(result.timezone).toBe("America/Chicago");
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toEqual({
      time: "2026-04-29T00:00",
      temperature: 72.5,
      precipitation_probability: 10,
      precipitation: 0,
      weather_code: 1,
      wind_speed: 8.2,
      cloud_cover: 25,
      visibility: 10,
      uv_index: 4,
    });
    expect(result.entries[2]).toEqual({
      time: "2026-04-29T02:00",
      temperature: 71.2,
      precipitation_probability: 20,
      precipitation: 0.05,
      weather_code: 3,
      wind_speed: 6.9,
      cloud_cover: 60,
      visibility: 8,
      uv_index: 2,
    });
  });

  it("slices to the requested hours count", async () => {
    server.use(http.get(FORECAST_URL, () => HttpResponse.json(makeHourly24())));
    const client = new WeatherClient();
    const result = await client.getHourly({
      lat: 32.7767,
      lng: -96.797,
      units: "imperial",
      hours: 6,
    });
    expect(result.entries).toHaveLength(6);
    expect(result.entries[0]?.temperature).toBe(70);
    expect(result.entries[5]?.temperature).toBe(75);
  });

  it("requests forecast_days = ceil(hours / 24)", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(FORECAST_URL, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(makeHourly24());
      }),
    );
    const client = new WeatherClient();
    await client.getHourly({
      lat: 32.7767,
      lng: -96.797,
      units: "imperial",
      hours: 30,
    });
    const url = new URL(seenUrl!);
    expect(url.searchParams.get("forecast_days")).toBe("2");
  });

  it("sends timezone=auto", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(FORECAST_URL, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockHourly3);
      }),
    );
    const client = new WeatherClient();
    await client.getHourly({
      lat: 32.7767,
      lng: -96.797,
      units: "metric",
      hours: 3,
    });
    const url = new URL(seenUrl!);
    expect(url.searchParams.get("timezone")).toBe("auto");
  });

  it("retries on 429 and ultimately succeeds", async () => {
    let calls = 0;
    server.use(
      http.get(FORECAST_URL, () => {
        calls++;
        if (calls === 1) {
          return new HttpResponse(null, {
            status: 429,
            headers: { "retry-after": "0" },
          });
        }
        return HttpResponse.json(mockHourly3);
      }),
    );
    const client = new WeatherClient();
    const result = await client.getHourly({
      lat: 32.7767,
      lng: -96.797,
      units: "metric",
      hours: 3,
    });
    expect(result.entries).toHaveLength(3);
    expect(calls).toBe(2);
  });

  it("returns empty entries when upstream time array is empty", async () => {
    server.use(
      http.get(FORECAST_URL, () =>
        HttpResponse.json({
          timezone: "America/Chicago",
          hourly: {
            time: [],
            temperature_2m: [],
            precipitation_probability: [],
            precipitation: [],
            weather_code: [],
            wind_speed_10m: [],
            cloud_cover: [],
            visibility: [],
            uv_index: [],
          },
        }),
      ),
    );
    const client = new WeatherClient();
    const result = await client.getHourly({
      lat: 32.7767,
      lng: -96.797,
      units: "metric",
      hours: 3,
    });
    expect(result.entries).toEqual([]);
    expect(result.timezone).toBe("America/Chicago");
  });
});

const mockDaily1 = {
  timezone: "America/Chicago",
  daily: {
    time: ["2026-04-29"],
    temperature_2m_max: [82.5],
    temperature_2m_min: [65.1],
    precipitation_sum: [0.1],
    precipitation_probability_max: [25],
    sunrise: ["2026-04-29T06:42"],
    sunset: ["2026-04-29T19:55"],
    wind_speed_10m_max: [15.4],
    weather_code: [2],
    uv_index_max: [8],
  },
};

const mockDaily7 = {
  timezone: "America/Chicago",
  daily: {
    time: Array.from({ length: 7 }, (_, i) => `2026-04-${29 + i}`),
    temperature_2m_max: Array.from({ length: 7 }, (_, i) => 80 + i),
    temperature_2m_min: Array.from({ length: 7 }, (_, i) => 60 + i),
    precipitation_sum: Array.from({ length: 7 }, () => 0),
    precipitation_probability_max: Array.from({ length: 7 }, () => 10),
    sunrise: Array.from({ length: 7 }, () => "06:42"),
    sunset: Array.from({ length: 7 }, () => "19:55"),
    wind_speed_10m_max: Array.from({ length: 7 }, () => 10),
    weather_code: Array.from({ length: 7 }, () => 1),
    uv_index_max: Array.from({ length: 7 }, () => 7),
  },
};

describe("WeatherClient.getDaily", () => {
  it("maps Open-Meteo daily response to slim DailyEntry shape", async () => {
    server.use(http.get(FORECAST_URL, () => HttpResponse.json(mockDaily1)));
    const client = new WeatherClient();
    const result = await client.getDaily({
      lat: 32.7767,
      lng: -96.797,
      units: "imperial",
      days: 1,
    });
    expect(result.timezone).toBe("America/Chicago");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      date: "2026-04-29",
      temp_max: 82.5,
      temp_min: 65.1,
      precipitation_sum: 0.1,
      precipitation_probability_max: 25,
      sunrise: "2026-04-29T06:42",
      sunset: "2026-04-29T19:55",
      wind_speed_max: 15.4,
      weather_code: 2,
      uv_index_max: 8,
    });
  });

  it("passes forecast_days = days through to upstream", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(FORECAST_URL, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockDaily7);
      }),
    );
    const client = new WeatherClient();
    await client.getDaily({
      lat: 32.7767,
      lng: -96.797,
      units: "imperial",
      days: 7,
    });
    const url = new URL(seenUrl!);
    expect(url.searchParams.get("forecast_days")).toBe("7");
  });

  it("uses a distinct cache key from getHourly", async () => {
    let hourlyCalls = 0;
    let dailyCalls = 0;
    server.use(
      http.get(FORECAST_URL, ({ request }) => {
        const u = new URL(request.url);
        if (u.searchParams.has("daily")) {
          dailyCalls++;
          return HttpResponse.json(mockDaily7);
        }
        hourlyCalls++;
        return HttpResponse.json(makeHourly24());
      }),
    );
    const client = new WeatherClient();
    await client.getHourly({
      lat: 32.7767,
      lng: -96.797,
      units: "imperial",
      hours: 24,
    });
    await client.getDaily({
      lat: 32.7767,
      lng: -96.797,
      units: "imperial",
      days: 7,
    });
    expect(hourlyCalls).toBe(1);
    expect(dailyCalls).toBe(1);
  });

  it("sends timezone=auto", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(FORECAST_URL, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockDaily1);
      }),
    );
    const client = new WeatherClient();
    await client.getDaily({
      lat: 32.7767,
      lng: -96.797,
      units: "metric",
      days: 1,
    });
    const url = new URL(seenUrl!);
    expect(url.searchParams.get("timezone")).toBe("auto");
  });

  it("retries on 429 and ultimately succeeds", async () => {
    let calls = 0;
    server.use(
      http.get(FORECAST_URL, () => {
        calls++;
        if (calls === 1) {
          return new HttpResponse(null, {
            status: 429,
            headers: { "retry-after": "0" },
          });
        }
        return HttpResponse.json(mockDaily1);
      }),
    );
    const client = new WeatherClient();
    const result = await client.getDaily({
      lat: 32.7767,
      lng: -96.797,
      units: "metric",
      days: 1,
    });
    expect(result.entries).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
