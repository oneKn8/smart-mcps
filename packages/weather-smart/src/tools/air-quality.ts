import { defineTool } from "smart-mcp-core";
import type { z } from "zod";
import type { WeatherContext } from "../context.js";
import { locationInput } from "./location-input.js";
import { resolveLocation } from "../location-resolver.js";

// Air quality index, particulate matter, and pollutant snapshot for a
// location. Output values are always µg/m³ — the upstream air-quality
// endpoint does not accept a units knob, so this tool intentionally has no
// `units` field on its input.
const inputSchema = locationInput;

type Input = z.infer<typeof inputSchema>;

type Category =
  | "Good"
  | "Moderate"
  | "Unhealthy for Sensitive Groups"
  | "Unhealthy"
  | "Very Unhealthy"
  | "Hazardous";

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  observed_at: string;
  aqi_us: number;
  category: Category;
  pm2_5: string;
  pm10: string;
  ozone: string;
  no2: string;
  so2: string;
  co: string;
};

// EPA US AQI breakpoints, lower bound inclusive, upper bound inclusive.
// Boundary semantics: 50→Good, 51→Moderate, 100→Moderate, 101→USG, etc.
function aqiCategory(aqi: number): Category {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

// PM, ozone, NO2, SO2 all live in tens-to-hundreds µg/m³ — one decimal is
// enough fidelity for chat output.
function formatMicro(value: number): string {
  return `${value.toFixed(1)}µg/m³`;
}

// CO concentrations are typically in the hundreds to low thousands; a
// decimal point would be noise. Round to integer.
function formatCo(value: number): string {
  return `${Math.round(value)}µg/m³`;
}

export const getAirQuality = defineTool<Input, Output, WeatherContext>({
  name: "get_air_quality",
  description: "Air quality index, PM, and pollutants.",
  inputSchema,
  handler: async (input, ctx) => {
    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    const snap = await ctx.client.getAirQuality({
      lat: resolved.lat,
      lng: resolved.lng,
    });
    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        // Air-quality endpoint doesn't return a timezone, so we surface the
        // resolver's timezone (geocoded city zone, or "auto" when caller
        // supplied raw lat/lng).
        timezone: resolved.timezone,
      },
      observed_at: snap.time,
      aqi_us: snap.aqi_us,
      category: aqiCategory(snap.aqi_us),
      pm2_5: formatMicro(snap.pm2_5),
      pm10: formatMicro(snap.pm10),
      ozone: formatMicro(snap.ozone),
      no2: formatMicro(snap.no2),
      so2: formatMicro(snap.so2),
      co: formatCo(snap.co),
    };
  },
});
