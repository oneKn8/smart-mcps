import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import { locationInput } from "./location-input.js";
import { formatTemp, formatHourLabel } from "./format.js";
import { resolveLocation } from "../location-resolver.js";
import { groupByDate } from "./temp-scan.js";

// Composed shortcut: "is frost expected in the next 24-168 hours?". Wraps
// `getHourly`, groups entries by local calendar date, and reports each date
// whose minimum temperature falls strictly below the threshold. The default
// threshold is 32F / 0C (the freezing point of water in each unit system) but
// callers can override it for crops with higher tolerances (citrus near 40F,
// tropicals near 50F).
const inputSchema = locationInput.extend({
  hours: z.number().int().min(24).max(168).optional().default(72),
  threshold: z.number().optional(),
  units: z.enum(["metric", "imperial"]).optional(),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  threshold: string;
  hours_scanned: number;
  nights_at_risk: Array<{
    date: string;
    min_temp: string;
    hour: string;
  }>;
  summary: string;
};

export const frostAlert = defineTool<Input, Output, WeatherContext>({
  name: "frost_alert",
  description: "Alert for sub-freezing temps in next 24-168h.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type for `hours` is `number | undefined` but the output is `number`.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    const units = input.units ?? ctx.defaults.units;
    // Default freezing point per unit system. The threshold value lives in
    // the same unit space as the temperatures returned by getHourly, so the
    // comparison below is unit-consistent without conversion.
    const threshold =
      input.threshold ?? (units === "imperial" ? 32 : 0);

    const { entries, timezone } = await ctx.client.getHourly({
      lat: resolved.lat,
      lng: resolved.lng,
      units,
      hours: input.hours,
    });

    // Group hourly entries by local calendar date, then for each date pick
    // the entry with the minimum temperature. Sub-threshold mins become the
    // "nights_at_risk" rows. Ordering is preserved from the input array,
    // which getHourly returns chronologically — Map preserves insertion
    // order, so iteration yields dates ascending.
    const grouped = groupByDate(entries);
    const nightsAtRisk: Output["nights_at_risk"] = [];
    for (const [date, dayEntries] of grouped) {
      let minEntry = dayEntries[0];
      if (!minEntry) continue;
      for (const entry of dayEntries) {
        if (entry.temperature < minEntry.temperature) minEntry = entry;
      }
      // Strict `<` per spec: a min equal to the threshold is not at risk.
      if (minEntry.temperature < threshold) {
        nightsAtRisk.push({
          date,
          min_temp: formatTemp(minEntry.temperature, units),
          hour: minEntry.time,
        });
      }
    }

    let summary: string;
    if (nightsAtRisk.length === 0) {
      summary = `No frost expected in next ${input.hours}h.`;
    } else {
      // Identify the lowest-of-the-low across the at-risk window for a
      // single human-readable headline. Tie-break by earliest hour.
      let coldest = nightsAtRisk[0]!;
      let coldestRaw = Infinity;
      for (const night of nightsAtRisk) {
        // Re-derive the raw temp from the grouped entries — we kept the
        // ISO hour, so look it up in the original entries list.
        const entry = entries.find((e) => e.time === night.hour);
        if (entry && entry.temperature < coldestRaw) {
          coldestRaw = entry.temperature;
          coldest = night;
        }
      }
      const dateList = nightsAtRisk.map((n) => n.date);
      const shown = dateList.slice(0, 3).join(", ");
      const more =
        dateList.length > 3 ? ` and ${dateList.length - 3} more` : "";
      summary = `Frost expected ${shown}${more}, lowest ${coldest.min_temp} at ${formatHourLabel(coldest.hour)}.`;
    }

    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone,
      },
      threshold: formatTemp(threshold, units),
      hours_scanned: input.hours,
      nights_at_risk: nightsAtRisk,
      summary,
    };
  },
});
