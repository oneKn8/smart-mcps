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
    expect(client.creds.WEATHER_DEFAULT_UNITS).toBe("imperial");
  });

  it("reads WEATHER_DEFAULT_LOCATION from process.env", () => {
    process.env.WEATHER_DEFAULT_LOCATION = "Dallas";
    const client = new WeatherClient();
    expect(client.creds.WEATHER_DEFAULT_LOCATION).toBe("Dallas");
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
