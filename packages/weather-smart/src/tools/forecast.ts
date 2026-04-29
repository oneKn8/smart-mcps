import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import { locationInput } from "./location-input.js";
import { weatherCodeLabel } from "./weather-codes.js";
import {
  formatTemp,
  formatWind,
  formatPercent,
  formatPrecipitation,
  formatVisibility,
} from "./format.js";
import { resolveLocation } from "../location-resolver.js";

// --- get_forecast (daily, 1-16 days) -------------------------------------
//
// Daily forecast for a location. `days` defaults to 7 — Open-Meteo's daily
// endpoint accepts 1..16 forecast days, so the schema clamps to that range.

const forecastInputSchema = locationInput.extend({
  days: z.number().int().min(1).max(16).optional().default(7),
  units: z.enum(["metric", "imperial"]).optional(),
});

type ForecastInput = z.infer<typeof forecastInputSchema>;

type ForecastOutput = {
  location: { name: string; lat: number; lng: number; timezone: string };
  daily: Array<{
    date: string;
    high: string;
    low: string;
    conditions: string;
    precip_chance: string;
    precip_total: string;
    sunrise: string;
    sunset: string;
    wind_max: string;
    uv_max: number;
  }>;
};

export const getForecast = defineTool<
  ForecastInput,
  ForecastOutput,
  WeatherContext
>({
  name: "get_forecast",
  description: "Daily forecast for 1-16 days.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `days | undefined` but its output type is the resolved number.
  inputSchema: forecastInputSchema as unknown as z.ZodType<ForecastInput>,
  handler: async (input, ctx) => {
    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    const units = input.units ?? ctx.defaults.units;
    const { entries, timezone } = await ctx.client.getDaily({
      lat: resolved.lat,
      lng: resolved.lng,
      units,
      days: input.days,
    });
    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone,
      },
      daily: entries.map((d) => ({
        date: d.date,
        high: formatTemp(d.temp_max, units),
        low: formatTemp(d.temp_min, units),
        conditions: weatherCodeLabel(d.weather_code),
        precip_chance: formatPercent(d.precipitation_probability_max),
        precip_total: formatPrecipitation(d.precipitation_sum, units),
        sunrise: d.sunrise,
        sunset: d.sunset,
        // Daily forecast emits only wind speed (no direction), so reuse
        // formatWind with an undefined direction to get just the speed +
        // unit suffix.
        wind_max: formatWind(d.wind_speed_max, undefined, units),
        uv_max: d.uv_index_max,
      })),
    };
  },
});

// --- get_hourly (hourly, 1-48 hours) -------------------------------------
//
// Hourly forecast for a location. `hours` defaults to 24. Open-Meteo's hourly
// endpoint always returns full days; the client slices to the requested count.

const hourlyInputSchema = locationInput.extend({
  hours: z.number().int().min(1).max(48).optional().default(24),
  units: z.enum(["metric", "imperial"]).optional(),
});

type HourlyInput = z.infer<typeof hourlyInputSchema>;

type HourlyOutput = {
  location: { name: string; lat: number; lng: number; timezone: string };
  hourly: Array<{
    time: string;
    temp: string;
    conditions: string;
    precip_chance: string;
    precip: string;
    wind: string;
    cloud_cover: string;
    visibility: string;
    uv_index: number;
  }>;
};

export const getHourly = defineTool<HourlyInput, HourlyOutput, WeatherContext>({
  name: "get_hourly",
  description: "Hourly forecast for 1-48 hours.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `hours | undefined` but its output type is the resolved number.
  inputSchema: hourlyInputSchema as unknown as z.ZodType<HourlyInput>,
  handler: async (input, ctx) => {
    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    const units = input.units ?? ctx.defaults.units;
    const { entries, timezone } = await ctx.client.getHourly({
      lat: resolved.lat,
      lng: resolved.lng,
      units,
      hours: input.hours,
    });
    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone,
      },
      hourly: entries.map((h) => ({
        time: h.time,
        temp: formatTemp(h.temperature, units),
        conditions: weatherCodeLabel(h.weather_code),
        precip_chance: formatPercent(h.precipitation_probability),
        precip: formatPrecipitation(h.precipitation, units),
        // Hourly forecast emits only wind speed (no direction), so reuse
        // formatWind with an undefined direction.
        wind: formatWind(h.wind_speed, undefined, units),
        cloud_cover: formatPercent(h.cloud_cover),
        visibility: formatVisibility(h.visibility, units),
        uv_index: h.uv_index,
      })),
    };
  },
});
