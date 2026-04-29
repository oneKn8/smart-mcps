import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import type { Units, HourlyEntry } from "../client.js";
import { locationInput } from "./location-input.js";
import {
  formatTemp,
  formatWind,
  formatPercent,
  formatVisibility,
  formatHourLabel,
} from "./format.js";
import { resolveLocation } from "../location-resolver.js";

// Composed shortcut: when does the sun set, and is it worth watching? Pulls
// the daily forecast for the requested offset to read the local sunset ISO
// string, then walks the matching hourly window to find the hour closest to
// sunset and grades the conditions there. Quality bands are intentionally
// strict for "great" so the recommendation is meaningful — a sunset call that
// always returns "great" is useless.
const inputSchema = locationInput.extend({
  date_offset: z.number().int().min(0).max(7).optional().default(0),
  units: z.enum(["metric", "imperial"]).optional(),
});

type Input = z.infer<typeof inputSchema>;

type ConditionsAtSunset = {
  cloud_cover: string;
  temp: string;
  precip_chance: string;
  visibility: string;
  wind: string;
};

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  date: string;
  sunset: string;
  conditions_at_sunset: ConditionsAtSunset;
  viewing_quality: "great" | "good" | "poor";
  summary: string;
};

// Visibility threshold helpers. Open-Meteo returns visibility in feet for
// imperial and metres for metric — we convert via formatVisibility for the
// surfaced string but compare on the raw upstream value here. 6mi ≈ 31680ft;
// 4mi ≈ 21120ft. Metric thresholds: 9.6km = 9600m; 6.4km = 6400m.
function visibilityGreatThreshold(units: Units): number {
  return units === "imperial" ? 31680 : 9600;
}
function visibilityGoodThreshold(units: Units): number {
  return units === "imperial" ? 21120 : 6400;
}

// Wind threshold: 15mph ≈ 24km/h (the strict "great" upper bound). Wind speed
// arrives in mph or km/h matching the requested units, so the threshold flips
// with units rather than converting on the fly.
function windGreatThreshold(units: Units): number {
  return units === "imperial" ? 15 : 24;
}

// Walk the hourly entries and return the one whose ISO-local time string is
// closest in absolute milliseconds to the supplied sunset ISO. Open-Meteo's
// hourly entries are aligned to the top of every hour, so the closest match
// is always within 30 minutes of the actual sunset. Returns null only when
// the entries array is empty (caller throws).
function findClosestHour(
  entries: HourlyEntry[],
  sunsetIso: string,
): HourlyEntry | null {
  if (entries.length === 0) return null;
  const sunsetMs = new Date(sunsetIso).getTime();
  let best = entries[0]!;
  let bestDelta = Math.abs(new Date(best.time).getTime() - sunsetMs);
  for (let i = 1; i < entries.length; i++) {
    const candidate = entries[i]!;
    const delta = Math.abs(new Date(candidate.time).getTime() - sunsetMs);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

// Grade the viewing window. "great" requires every signal in band: enough
// cloud for colour but not so much it blocks the sun (30-70 inclusive),
// negligible rain, high visibility, light wind. "good" relaxes every band.
// Anything else is "poor". Bands are inclusive at every boundary so the test
// fixtures at 30/70/15 land deterministically.
function gradeViewing(
  hour: HourlyEntry,
  units: Units,
): {
  quality: "great" | "good" | "poor";
  reason: string;
} {
  const cloud = hour.cloud_cover;
  const precip = hour.precipitation_probability;
  const visibility = hour.visibility;
  const wind = hour.wind_speed;

  const greatVis = visibilityGreatThreshold(units);
  const goodVis = visibilityGoodThreshold(units);
  const greatWind = windGreatThreshold(units);

  const isGreat =
    cloud >= 30 &&
    cloud <= 70 &&
    precip < 10 &&
    visibility > greatVis &&
    wind < greatWind;
  if (isGreat) return { quality: "great", reason: "" };

  const isGood =
    cloud >= 0 && cloud <= 90 && precip < 25 && visibility > goodVis;
  if (isGood) return { quality: "good", reason: "" };

  // Identify the dominant failing condition for the prose summary. Order
  // matters — heavy clouds and active rain trump visibility / wind in user
  // perception, so we report them first.
  let reason: string;
  if (cloud > 90) reason = "heavy cloud cover";
  else if (precip >= 25) reason = "rain expected";
  else if (visibility <= goodVis) reason = "low visibility";
  else if (wind >= greatWind * 2) reason = "high wind";
  else reason = "marginal conditions";
  return { quality: "poor", reason };
}

export const sunsetCheck = defineTool<Input, Output, WeatherContext>({
  name: "sunset_check",
  description: "Sunset time and viewing conditions.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type for `date_offset` is `... | undefined` but the output is concrete.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    const units = input.units ?? ctx.defaults.units;
    const days = input.date_offset + 1;

    // Fetch daily and hourly concurrently. Daily yields the sunset timestamp
    // for the requested offset; hourly supplies the conditions at that time.
    const [daily, hourly] = await Promise.all([
      ctx.client.getDaily({
        lat: resolved.lat,
        lng: resolved.lng,
        units,
        days,
      }),
      ctx.client.getHourly({
        lat: resolved.lat,
        lng: resolved.lng,
        units,
        hours: days * 24,
      }),
    ]);

    const dayEntry = daily.entries[input.date_offset];
    if (!dayEntry) {
      throw new Error(
        `no daily forecast at offset ${input.date_offset} for '${resolved.name}'`,
      );
    }

    const closest = findClosestHour(hourly.entries, dayEntry.sunset);
    if (!closest) {
      throw new Error(`no hourly data covering sunset for '${resolved.name}'`);
    }

    const conditions_at_sunset: ConditionsAtSunset = {
      cloud_cover: formatPercent(closest.cloud_cover),
      temp: formatTemp(closest.temperature, units),
      precip_chance: formatPercent(closest.precipitation_probability),
      visibility: formatVisibility(closest.visibility, units),
      wind: formatWind(closest.wind_speed, undefined, units),
    };

    const { quality, reason } = gradeViewing(closest, units);
    const hourLabel = formatHourLabel(dayEntry.sunset);

    let summary: string;
    if (quality === "great") {
      summary = `Great sunset viewing at ${hourLabel}. ${conditions_at_sunset.cloud_cover} clouds, ${conditions_at_sunset.visibility} visibility.`;
    } else if (quality === "good") {
      summary = `Decent sunset at ${hourLabel}. ${conditions_at_sunset.cloud_cover} clouds.`;
    } else {
      summary = `Poor sunset conditions at ${hourLabel}. ${reason}.`;
    }

    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone: hourly.timezone,
      },
      date: dayEntry.date,
      sunset: dayEntry.sunset,
      conditions_at_sunset,
      viewing_quality: quality,
      summary,
    };
  },
});
