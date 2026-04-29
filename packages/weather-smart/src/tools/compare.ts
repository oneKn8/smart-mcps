import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import type { Units, HourlyEntry, DailyEntry } from "../client.js";
import { weatherCodeLabel } from "./weather-codes.js";
import { formatTemp, formatWind, formatPercent } from "./format.js";

// Composed shortcut: side-by-side comparison of weather across 2-5 named
// locations for now / today / tomorrow. Geocodes every location and fetches
// per-location weather concurrently via Promise.all so wall-clock latency is
// dominated by the slowest single fetch, not the sum. Surfaces three
// "best_for" picks (sun, dry, mild) so the LLM caller can answer "which city
// should I pick?" without re-walking the structured payload.
const inputSchema = z.object({
  locations: z.array(z.string().min(1)).min(2).max(5),
  when: z.enum(["now", "today", "tomorrow"]).optional().default("today"),
  units: z.enum(["metric", "imperial"]).optional(),
});

type Input = z.infer<typeof inputSchema>;

type Snapshot = {
  temp: string;
  conditions: string;
  precip_chance: string;
  wind: string;
};

type Result = {
  name: string;
  lat: number;
  lng: number;
  timezone: string;
  snapshot: Snapshot;
};

type Output = {
  when: string;
  results: Result[];
  best_for: {
    sun: string | null;
    dry: string | null;
    mild: string | null;
  };
  summary: string;
};

// Internal per-location aggregate carried through the pick logic. We retain
// the raw numeric signals (cloud_cover, uv, precip_chance, temp) on the
// metrics struct so best_for ranking can compare on raw numbers instead of
// re-parsing the formatted string output.
type LocationMetrics = {
  result: Result;
  rawTemp: number;
  rawPrecipChance: number;
  // For "now" we use cloud_cover (lower = sunnier). For "today"/"tomorrow"
  // DailyEntry has no cloud_cover so we substitute uv_index_max (higher =
  // sunnier — fewer clouds blocking direct sun is the dominant UV driver).
  // sunSignal is the value we compare on; sunHigherWins flips the comparator.
  sunSignal: number;
  sunHigherWins: boolean;
};

// Mild target temperatures: 70F (imperial) and 21C (metric). Both represent
// the canonical "shirt-sleeve comfortable" point. Closest absolute delta to
// this target wins.
function mildTarget(units: Units): number {
  return units === "imperial" ? 70 : 21;
}

// Build the snapshot + metrics from current + first hourly entry. Hourly
// supplies the precipitation probability which getCurrent doesn't expose, so
// we run the two requests in parallel per location. cloud_cover from hourly[0]
// is also the cleanest "is it sunny right now" signal.
function buildNowMetrics(
  resolved: Result,
  current: {
    temperature: number;
    weather_code: number;
    wind_speed: number;
    wind_direction: number;
  },
  firstHour: HourlyEntry,
  units: Units,
): LocationMetrics {
  const snapshot: Snapshot = {
    temp: formatTemp(current.temperature, units),
    conditions: weatherCodeLabel(current.weather_code),
    precip_chance: formatPercent(firstHour.precipitation_probability),
    wind: formatWind(current.wind_speed, current.wind_direction, units),
  };
  return {
    result: { ...resolved, snapshot },
    rawTemp: current.temperature,
    rawPrecipChance: firstHour.precipitation_probability,
    sunSignal: firstHour.cloud_cover,
    sunHigherWins: false,
  };
}

// Build the snapshot + metrics from a daily entry. Wind direction is unknown
// for daily aggregates (Open-Meteo only returns daily wind_speed_max), so the
// formatted wind string drops the compass component. UV index acts as the
// sun-proxy because DailyEntry exposes no cloud_cover.
function buildDailyMetrics(
  resolved: Result,
  day: DailyEntry,
  units: Units,
): LocationMetrics {
  const snapshot: Snapshot = {
    temp: formatTemp(day.temp_max, units),
    conditions: weatherCodeLabel(day.weather_code),
    precip_chance: formatPercent(day.precipitation_probability_max),
    wind: formatWind(day.wind_speed_max, undefined, units),
  };
  return {
    result: { ...resolved, snapshot },
    rawTemp: day.temp_max,
    rawPrecipChance: day.precipitation_probability_max,
    sunSignal: day.uv_index_max,
    sunHigherWins: true,
  };
}

// First-occurrence tie-break: walk the list in order and update only on a
// strict improvement. Returns the winning location name, or null when the
// list is empty.
function pickBest<T>(
  items: T[],
  betterThan: (a: T, b: T) => boolean,
  name: (item: T) => string,
): string | null {
  if (items.length === 0) return null;
  let best = items[0]!;
  for (let i = 1; i < items.length; i++) {
    const candidate = items[i]!;
    if (betterThan(candidate, best)) best = candidate;
  }
  return name(best);
}

export const compareLocations = defineTool<Input, Output, WeatherContext>({
  name: "compare_locations",
  description: "Compare weather across 2-5 locations.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type for `when` is `... | undefined` but the output type is concrete.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const units = input.units ?? ctx.defaults.units;

    // Geocode every location in parallel. Top match wins per query — same
    // policy as the shared resolver. Failed matches throw so the LLM caller
    // sees which name didn't resolve.
    const resolvedList = await Promise.all(
      input.locations.map(async (query) => {
        const { matches } = await ctx.client.geocode(query);
        const top = matches[0];
        if (!top) throw new Error(`no location match for '${query}'`);
        const display = [top.name, top.admin1, top.country]
          .filter((part): part is string => Boolean(part))
          .join(", ");
        return {
          name: display,
          lat: top.lat,
          lng: top.lng,
          timezone: top.timezone,
          snapshot: {} as Snapshot, // filled in by the weather pass below
        };
      }),
    );

    // Per-location weather fetch — also parallelised. The branching on `when`
    // determines the upstream calls; for "now" we additionally pull a single
    // hourly entry to source precipitation probability (getCurrent doesn't
    // return it).
    const metrics: LocationMetrics[] = await Promise.all(
      resolvedList.map(async (resolved): Promise<LocationMetrics> => {
        if (input.when === "now") {
          const [current, hourly] = await Promise.all([
            ctx.client.getCurrent({
              lat: resolved.lat,
              lng: resolved.lng,
              units,
            }),
            ctx.client.getHourly({
              lat: resolved.lat,
              lng: resolved.lng,
              units,
              hours: 1,
            }),
          ]);
          const firstHour = hourly.entries[0];
          if (!firstHour) {
            throw new Error(`no hourly data for '${resolved.name}'`);
          }
          return buildNowMetrics(resolved, current, firstHour, units);
        }

        const days = input.when === "tomorrow" ? 2 : 1;
        const dayIdx = input.when === "tomorrow" ? 1 : 0;
        const daily = await ctx.client.getDaily({
          lat: resolved.lat,
          lng: resolved.lng,
          units,
          days,
        });
        const dayEntry = daily.entries[dayIdx];
        if (!dayEntry) {
          throw new Error(
            `no daily forecast for '${resolved.name}' at offset ${dayIdx}`,
          );
        }
        return buildDailyMetrics(resolved, dayEntry, units);
      }),
    );

    // best_for picks: each metric is compared with strict-better semantics so
    // ties fall through to the first-occurrence winner.
    const target = mildTarget(units);
    const best_for = {
      sun: pickBest(
        metrics,
        (a, b) =>
          a.sunHigherWins ? a.sunSignal > b.sunSignal : a.sunSignal < b.sunSignal,
        (m) => m.result.name,
      ),
      dry: pickBest(
        metrics,
        (a, b) => a.rawPrecipChance < b.rawPrecipChance,
        (m) => m.result.name,
      ),
      mild: pickBest(
        metrics,
        (a, b) => Math.abs(a.rawTemp - target) < Math.abs(b.rawTemp - target),
        (m) => m.result.name,
      ),
    };

    const results = metrics.map((m) => m.result);
    const headline = results
      .map(
        (r) =>
          `${r.name} (${r.snapshot.temp}, ${r.snapshot.conditions.toLowerCase()})`,
      )
      .join(", ");
    const summary =
      `Comparing ${results.length} locations for ${input.when}: ${headline}. ` +
      `Best for sun: ${best_for.sun ?? "none"}. ` +
      `Best for dry: ${best_for.dry ?? "none"}. ` +
      `Best for mild: ${best_for.mild ?? "none"}.`;

    return {
      when: input.when,
      results,
      best_for,
      summary,
    };
  },
});
