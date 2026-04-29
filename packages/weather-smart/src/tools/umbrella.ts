import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import { locationInput } from "./location-input.js";
import { formatPrecipitation, formatHourLabel } from "./format.js";
import { resolveLocation } from "../location-resolver.js";

// Composed shortcut: should I bring an umbrella in the next 6-48 hours? Wraps
// `getHourly` and applies a triplet recommendation rule:
//   - peak precipitation probability >= 40%
//   - total precipitation > 0.1in (imperial) or 2.5mm (metric)
//   - hours_with_rain (count of hours where pop > 20%) >= 3
// Any one rule triggering returns recommend=true. The rules are intentionally
// loose — false positives ("you didn't need an umbrella after all") are
// cheaper than false negatives ("you got soaked").
const inputSchema = locationInput.extend({
  hours: z.number().int().min(6).max(48).optional().default(24),
  units: z.enum(["metric", "imperial"]).optional(),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  recommend: boolean;
  peak_hour: string | null;
  peak_pop: number;
  total_precip: string;
  hours_with_rain: number;
  summary: string;
};

// Rain-rule threshold for total precip in the user's unit system. Imperial
// uses 0.1in (a meaningful drizzle), metric uses 2.5mm (the same physical
// magnitude, rounded to a familiar metric step). Centralised here so the
// summary text and the recommend rule stay consistent if either is tuned.
function precipThreshold(units: "metric" | "imperial"): number {
  return units === "imperial" ? 0.1 : 2.5;
}

export const umbrellaCheck = defineTool<Input, Output, WeatherContext>({
  name: "umbrella_check",
  description: "Should I bring an umbrella? Next 6-48h.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type for `hours` is `number | undefined` but the output is `number`.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
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

    // Aggregate the three signals in a single pass. peak_pop / peak_hour are
    // taken from the entry with the maximum probability; ties resolve to the
    // earliest hour because a `>` comparison only updates on strictly greater.
    let peakPop = 0;
    let peakHourIso: string | null = null;
    let totalPrecip = 0;
    let hoursWithRain = 0;
    for (const entry of entries) {
      totalPrecip += entry.precipitation;
      if (entry.precipitation_probability > 20) hoursWithRain += 1;
      if (entry.precipitation_probability > peakPop) {
        peakPop = entry.precipitation_probability;
        peakHourIso = entry.time;
      }
    }
    // Edge: when every hour has 0% pop, peakHourIso stays null and peakPop=0.
    // This matches the documented contract.

    const threshold = precipThreshold(units);
    const recommend =
      peakPop >= 40 || totalPrecip > threshold || hoursWithRain >= 3;

    let summary: string;
    if (peakPop === 0 && totalPrecip === 0) {
      summary = `No rain expected in next ${input.hours}h.`;
    } else if (recommend) {
      const peakLabel = peakHourIso ? formatHourLabel(peakHourIso) : "later";
      summary = `Yes — ${peakPop}% chance peaking ${peakLabel}. Bring umbrella.`;
    } else {
      summary = "Likely dry. No umbrella needed.";
    }

    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone,
      },
      recommend,
      peak_hour: peakHourIso,
      peak_pop: peakPop,
      total_precip: formatPrecipitation(totalPrecip, units),
      hours_with_rain: hoursWithRain,
      summary,
    };
  },
});
