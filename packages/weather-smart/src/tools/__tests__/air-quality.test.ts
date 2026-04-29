import { describe, it, expect, vi } from "vitest";
import { getAirQuality } from "../air-quality.js";
import type { WeatherContext } from "../../context.js";
import type {
  WeatherClient,
  AirQualitySnapshot,
  GeocodeMatch,
} from "../../client.js";

function snap(overrides: Partial<AirQualitySnapshot> = {}): AirQualitySnapshot {
  return {
    time: "2026-04-29T14:00",
    aqi_us: 42,
    pm2_5: 12.3,
    pm10: 18.5,
    ozone: 65.0,
    no2: 22.4,
    so2: 1.2,
    co: 200,
    ...overrides,
  };
}

function makeCtx(opts: {
  snapshot?: Partial<AirQualitySnapshot>;
  matches?: GeocodeMatch[];
  defaultLocation?: string | undefined;
}): {
  ctx: WeatherContext;
  getAirQuality: ReturnType<typeof vi.fn>;
  geocode: ReturnType<typeof vi.fn>;
} {
  const getAirQualityStub = vi.fn().mockResolvedValue(snap(opts.snapshot));
  const geocode = vi.fn().mockResolvedValue({ matches: opts.matches ?? [] });
  const ctx: WeatherContext = {
    client: {
      geocode,
      getAirQuality: getAirQualityStub,
    } as unknown as WeatherClient,
    defaults: {
      units: "imperial",
      location: opts.defaultLocation,
    },
  };
  return { ctx, getAirQuality: getAirQualityStub, geocode };
}

describe("get_air_quality — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getAirQuality.name).toBe("get_air_quality");
    expect(getAirQuality.description).toBe(
      "Air quality index, PM, and pollutants.",
    );
  });
});

describe("get_air_quality — output shape", () => {
  it("returns object with exactly the 11 expected keys", async () => {
    const { ctx } = makeCtx({});
    const result = await getAirQuality.handler({ lat: 32.78, lng: -96.8 }, ctx);
    expect(Object.keys(result).sort()).toEqual([
      "aqi_us",
      "category",
      "co",
      "location",
      "no2",
      "observed_at",
      "ozone",
      "pm10",
      "pm2_5",
      "so2",
    ].sort());
  });
});

describe("get_air_quality — AQI category boundaries", () => {
  const cases: Array<[number, string]> = [
    [50, "Good"],
    [51, "Moderate"],
    [100, "Moderate"],
    [101, "Unhealthy for Sensitive Groups"],
    [150, "Unhealthy for Sensitive Groups"],
    [151, "Unhealthy"],
    [200, "Unhealthy"],
    [201, "Very Unhealthy"],
    [300, "Very Unhealthy"],
    [301, "Hazardous"],
  ];
  for (const [aqi, expected] of cases) {
    it(`maps aqi=${aqi} → ${expected}`, async () => {
      const { ctx } = makeCtx({ snapshot: { aqi_us: aqi } });
      const result = await getAirQuality.handler(
        { lat: 0, lng: 0 },
        ctx,
      );
      expect(result.category).toBe(expected);
    });
  }
});

describe("get_air_quality — pollutant formatting", () => {
  it("includes the µg/m³ suffix using the U+00B5 micro sign", async () => {
    const { ctx } = makeCtx({});
    const result = await getAirQuality.handler({ lat: 0, lng: 0 }, ctx);
    // 0xC2 0xB5 is the UTF-8 encoding of U+00B5 (MICRO SIGN). Confirms we
    // didn't accidentally use ASCII 'u' or the Greek mu (U+03BC).
    expect(result.pm2_5).toContain("µg/m³");
    expect(result.pm10).toContain("µg/m³");
    expect(result.ozone).toContain("µg/m³");
    expect(result.no2).toContain("µg/m³");
    expect(result.so2).toContain("µg/m³");
    expect(result.co).toContain("µg/m³");
  });

  it("formats PM2.5 to 1 decimal", async () => {
    const { ctx } = makeCtx({ snapshot: { pm2_5: 12.34 } });
    const result = await getAirQuality.handler({ lat: 0, lng: 0 }, ctx);
    expect(result.pm2_5).toBe("12.3µg/m³");
  });

  it("formats CO as integer (no decimals)", async () => {
    const { ctx } = makeCtx({ snapshot: { co: 200.7 } });
    const result = await getAirQuality.handler({ lat: 0, lng: 0 }, ctx);
    expect(result.co).toBe("201µg/m³");
  });
});

describe("get_air_quality — location resolution", () => {
  it("falls back to defaults.location when input has no lat/lng/location", async () => {
    const { ctx, geocode } = makeCtx({
      defaultLocation: "Dallas",
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
    const result = await getAirQuality.handler({}, ctx);
    expect(geocode).toHaveBeenCalledWith("Dallas");
    expect(result.location.name).toBe("Dallas, Texas, United States");
  });
});
