import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import { locationInput } from "./location-input.js";
import { formatTemp, formatPrecipitation, formatWind } from "./format.js";
import { resolveLocation } from "../location-resolver.js";

// Past daily weather observations for a location, drawn from Open-Meteo's
// ERA5 reanalysis archive. The archive carries an inherent ~5-day lag, so
// `end_date` must be at least 5 days in the past. The handler enforces
// ordering (`end_date >= start_date`) and a defensive 366-day cap on the
// total range — Open-Meteo will accept longer ranges, but the response would
// be unwieldy to surface through chat.
const inputSchema = locationInput.extend({
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  units: z.enum(["metric", "imperial"]).optional(),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  daily: Array<{
    date: string;
    high: string;
    low: string;
    precip_total: string;
    wind_max: string;
  }>;
};

// Returns the local calendar date `daysAgo` days before the supplied
// reference date, formatted as YYYY-MM-DD. Used to derive the ERA5 lag cutoff
// without timezone arithmetic — string comparison on ISO date-only is robust.
function isoDateMinusDays(reference: Date, daysAgo: number): string {
  const d = new Date(reference);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export const getHistorical = defineTool<Input, Output, WeatherContext>({
  name: "get_historical",
  description: "Past daily weather observations (ERA5).",
  // Cast required because z.ZodType<Input> is invariant; ZodOptional's input
  // type differs from its output type for the units field.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    // Date math is done on UTC midnights to avoid TZ drift across the
    // start/end pair. ERA5 lag and range cap are checked before any I/O so
    // bad inputs surface quickly.
    const start = new Date(input.start_date + "T00:00:00Z");
    const end = new Date(input.end_date + "T00:00:00Z");

    if (end.getTime() < start.getTime()) {
      throw new Error("end_date must be on or after start_date");
    }

    const cutoff = isoDateMinusDays(new Date(), 5);
    if (input.end_date > cutoff) {
      throw new Error(
        "end_date must be at least 5 days in the past (ERA5 reanalysis lag)",
      );
    }

    // Defensive cap. Open-Meteo allows long ranges but a 366+ day window
    // would dump too much data through the LLM caller.
    const dayMs = 24 * 60 * 60 * 1000;
    const rangeDays = Math.round((end.getTime() - start.getTime()) / dayMs);
    if (rangeDays > 366) {
      throw new Error("date range cannot exceed 366 days");
    }

    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    const units = input.units ?? ctx.defaults.units;
    const { entries, timezone } = await ctx.client.getHistorical({
      lat: resolved.lat,
      lng: resolved.lng,
      units,
      start_date: input.start_date,
      end_date: input.end_date,
    });

    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone,
      },
      daily: entries.map((e) => ({
        date: e.date,
        high: formatTemp(e.temp_max, units),
        low: formatTemp(e.temp_min, units),
        precip_total: formatPrecipitation(e.precipitation_sum, units),
        // Daily archive emits only wind speed (no direction); reuse formatWind
        // with an undefined direction to get just speed + unit suffix.
        wind_max: formatWind(e.wind_speed_max, undefined, units),
      })),
    };
  },
});
