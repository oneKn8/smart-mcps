import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import { locationInput } from "./location-input.js";
import { formatTemp, formatHourLabel } from "./format.js";
import { resolveLocation } from "../location-resolver.js";
import { groupByDate } from "./temp-scan.js";

// Composed shortcut: "are there high-heat days in the next 1-7 days?". Wraps
// `getHourly` (24*days hours), groups by local calendar date, and reports
// each date whose maximum temperature exceeds the threshold. Defaults to
// 95F / 35C — the lower edge of the NWS heat advisory range — but callers
// can pass a tighter or looser threshold for crops, livestock, or events.
const inputSchema = locationInput.extend({
  days: z.number().int().min(1).max(7).optional().default(7),
  threshold: z.number().optional(),
  units: z.enum(["metric", "imperial"]).optional(),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  threshold: string;
  days_scanned: number;
  days_at_risk: Array<{
    date: string;
    max_temp: string;
    peak_hour: string;
  }>;
  summary: string;
};

export const heatAdvisory = defineTool<Input, Output, WeatherContext>({
  name: "heat_advisory",
  description: "Alert for high-heat windows next 1-7d.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type for `days` is `number | undefined` but the output is `number`.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    const units = input.units ?? ctx.defaults.units;
    // Default heat-advisory line per unit system. Values are unit-consistent
    // with getHourly's temperature axis so no conversion is needed below.
    const threshold =
      input.threshold ?? (units === "imperial" ? 95 : 35);

    const hours = input.days * 24;
    const { entries, timezone } = await ctx.client.getHourly({
      lat: resolved.lat,
      lng: resolved.lng,
      units,
      hours,
    });

    // Group hourly entries by local calendar date, then pick the peak temp
    // per day. Strict `>` per spec — a day topping out exactly at threshold
    // is not flagged.
    const grouped = groupByDate(entries);
    const daysAtRisk: Output["days_at_risk"] = [];
    for (const [date, dayEntries] of grouped) {
      let peakEntry = dayEntries[0];
      if (!peakEntry) continue;
      for (const entry of dayEntries) {
        if (entry.temperature > peakEntry.temperature) peakEntry = entry;
      }
      if (peakEntry.temperature > threshold) {
        daysAtRisk.push({
          date,
          max_temp: formatTemp(peakEntry.temperature, units),
          peak_hour: peakEntry.time,
        });
      }
    }

    let summary: string;
    if (daysAtRisk.length === 0) {
      summary = `No high-heat days expected in next ${input.days}d.`;
    } else {
      // Hottest of the hot — used in the headline. Tie-break by earliest
      // peak hour (the first matching entry wins under `<`).
      let hottest = daysAtRisk[0]!;
      let hottestRaw = -Infinity;
      for (const day of daysAtRisk) {
        const entry = entries.find((e) => e.time === day.peak_hour);
        if (entry && entry.temperature > hottestRaw) {
          hottestRaw = entry.temperature;
          hottest = day;
        }
      }
      const dateList = daysAtRisk.map((d) => d.date);
      const shown = dateList.slice(0, 3).join(", ");
      const more =
        dateList.length > 3 ? ` and ${dateList.length - 3} more` : "";
      summary = `High heat ${shown}${more}, peak ${hottest.max_temp} at ${formatHourLabel(hottest.peak_hour)}.`;
    }

    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone,
      },
      threshold: formatTemp(threshold, units),
      days_scanned: input.days,
      days_at_risk: daysAtRisk,
      summary,
    };
  },
});
