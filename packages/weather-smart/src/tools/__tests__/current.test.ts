import { describe, it, expect, vi } from "vitest";
import { getCurrent } from "../current.js";
import type { WeatherContext } from "../../context.js";
import type {
  WeatherClient,
  CurrentSnapshot,
  GeocodeMatch,
} from "../../client.js";

// Build a WeatherContext with stubbed `geocode` and `getCurrent` methods.
// Tool-level tests stub the client directly — client.test.ts covers the HTTP
// path via msw.
type Stubs = {
  geocode: ReturnType<typeof vi.fn>;
  getCurrent: ReturnType<typeof vi.fn>;
};

function makeCtx(opts: {
  snapshot?: Partial<CurrentSnapshot>;
  matches?: GeocodeMatch[];
  defaultUnits?: "metric" | "imperial";
  defaultLocation?: string | undefined;
}): { ctx: WeatherContext; stubs: Stubs } {
  const snapshot: CurrentSnapshot = {
    time: "2026-04-29T12:00",
    temperature: 72,
    apparent_temperature: 70,
    humidity: 45,
    precipitation: 0,
    weather_code: 1,
    wind_speed: 12,
    wind_direction: 270,
    pressure: 1015,
    timezone: "America/Chicago",
    ...opts.snapshot,
  };
  const stubs: Stubs = {
    geocode: vi.fn().mockResolvedValue({ matches: opts.matches ?? [] }),
    getCurrent: vi.fn().mockResolvedValue(snapshot),
  };
  const ctx: WeatherContext = {
    client: {
      geocode: stubs.geocode,
      getCurrent: stubs.getCurrent,
    } as unknown as WeatherClient,
    defaults: {
      units: opts.defaultUnits ?? "imperial",
      location: opts.defaultLocation,
    },
  };
  return { ctx, stubs };
}

describe("get_current — metadata", () => {
  it("has correct name and description", () => {
    expect(getCurrent.name).toBe("get_current");
    expect(getCurrent.description).toBe(
      "Current weather conditions for a location.",
    );
  });
});

describe("get_current — location resolution", () => {
  it("uses lat/lng directly without geocoding", async () => {
    const { ctx, stubs } = makeCtx({});
    await getCurrent.handler({ lat: 32.78, lng: -96.8 }, ctx);
    expect(stubs.geocode).not.toHaveBeenCalled();
    expect(stubs.getCurrent).toHaveBeenCalledWith({
      lat: 32.78,
      lng: -96.8,
      units: "imperial",
    });
  });

  it("calls geocode then getCurrent for a location string", async () => {
    const { ctx, stubs } = makeCtx({
      matches: [
        {
          name: "Dallas",
          lat: 32.78,
          lng: -96.8,
          timezone: "America/Chicago",
          country: "United States",
          admin1: "Texas",
        },
      ],
    });
    await getCurrent.handler({ location: "Dallas" }, ctx);
    expect(stubs.geocode).toHaveBeenCalledWith("Dallas");
    expect(stubs.getCurrent).toHaveBeenCalledWith({
      lat: 32.78,
      lng: -96.8,
      units: "imperial",
    });
  });
});

describe("get_current — units resolution", () => {
  it("falls back to ctx.defaults.units when input.units omitted", async () => {
    const { ctx, stubs } = makeCtx({ defaultUnits: "metric" });
    await getCurrent.handler({ lat: 0, lng: 0 }, ctx);
    expect(stubs.getCurrent).toHaveBeenCalledWith({
      lat: 0,
      lng: 0,
      units: "metric",
    });
  });

  it("input.units overrides ctx.defaults.units", async () => {
    const { ctx, stubs } = makeCtx({ defaultUnits: "metric" });
    await getCurrent.handler({ lat: 0, lng: 0, units: "imperial" }, ctx);
    expect(stubs.getCurrent).toHaveBeenCalledWith({
      lat: 0,
      lng: 0,
      units: "imperial",
    });
  });
});

describe("get_current — output shape", () => {
  it("returns object with exactly the 9 expected keys", async () => {
    const { ctx } = makeCtx({});
    const result = await getCurrent.handler({ lat: 32.78, lng: -96.8 }, ctx);
    expect(Object.keys(result).sort()).toEqual([
      "conditions",
      "feels_like",
      "humidity",
      "location",
      "observed_at",
      "precipitation",
      "pressure",
      "temp",
      "wind",
    ]);
  });

  it("formats imperial values with F + maps weather code to label", async () => {
    const { ctx } = makeCtx({
      snapshot: { temperature: 78, weather_code: 95 },
      defaultUnits: "imperial",
    });
    const result = await getCurrent.handler({ lat: 0, lng: 0 }, ctx);
    expect(result.temp).toBe("78F");
    expect(result.conditions).toBe("Thunderstorm");
  });

  it("formats metric values with C suffix", async () => {
    const { ctx } = makeCtx({
      snapshot: { temperature: 22 },
      defaultUnits: "metric",
    });
    const result = await getCurrent.handler({ lat: 0, lng: 0 }, ctx);
    expect(result.temp).toBe("22C");
  });
});
