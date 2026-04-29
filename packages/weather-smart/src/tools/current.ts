import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import { locationInput } from "./location-input.js";
import { weatherCodeLabel } from "./weather-codes.js";
import {
  formatTemp,
  formatWind,
  formatPercent,
  formatPressure,
  formatPrecipitation,
} from "./format.js";
import { resolveLocation } from "../location-resolver.js";

// Current conditions for a location. Accepts either explicit lat/lng, a
// free-text place name, or falls back to the configured WEATHER_DEFAULT_LOCATION
// when neither is supplied. The optional `units` field overrides the
// per-context default unit system (typically WEATHER_DEFAULT_UNITS).
const inputSchema = locationInput.extend({
  units: z.enum(["metric", "imperial"]).optional(),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  observed_at: string;
  temp: string;
  feels_like: string;
  conditions: string;
  wind: string;
  humidity: string;
  pressure: string;
  precipitation: string;
};

export const getCurrent = defineTool<Input, Output, WeatherContext>({
  name: "get_current",
  description: "Current weather conditions for a location.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `units | undefined` but its output type is the resolved union.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    const units = input.units ?? ctx.defaults.units;
    const snap = await ctx.client.getCurrent({
      lat: resolved.lat,
      lng: resolved.lng,
      units,
    });
    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone: snap.timezone,
      },
      observed_at: snap.time,
      temp: formatTemp(snap.temperature, units),
      feels_like: formatTemp(snap.apparent_temperature, units),
      conditions: weatherCodeLabel(snap.weather_code),
      wind: formatWind(snap.wind_speed, snap.wind_direction, units),
      humidity: formatPercent(snap.humidity),
      pressure: formatPressure(snap.pressure),
      precipitation: formatPrecipitation(snap.precipitation, units),
    };
  },
});
