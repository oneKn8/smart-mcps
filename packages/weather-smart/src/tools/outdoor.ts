import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import type { HourlyEntry, Units } from "../client.js";
import { locationInput } from "./location-input.js";
import {
  formatTemp,
  formatWind,
  formatPercent,
  formatHourLabel,
} from "./format.js";
import { resolveLocation } from "../location-resolver.js";
import {
  ACTIVITY_PRESETS,
  passesPreset,
  type ActivityName,
} from "./activity-presets.js";

// Composed shortcut: "when are the best windows for <activity> in the next
// 1-7 days?". Wraps `getHourly`, evaluates each entry against the activity's
// preset envelope (wind/precip/temp/optional uv/cloud/visibility), then
// performs a single greedy O(N) sweep to find contiguous runs of passing
// hours. Runs shorter than `min_window_hours` are dropped, the rest are
// scored, sorted, and the top 3 returned with averaged conditions.
const inputSchema = locationInput.extend({
  activity: z
    .enum(["hike", "run", "picnic", "drone", "bike", "general"])
    .optional()
    .default("general"),
  days: z.number().int().min(1).max(7).optional().default(3),
  min_window_hours: z.number().int().min(1).max(12).optional().default(2),
  units: z.enum(["metric", "imperial"]).optional(),
});

type Input = z.infer<typeof inputSchema>;

type WindowOut = {
  start: string;
  end: string;
  duration_hours: number;
  score: number;
  conditions: {
    temp_avg: string;
    wind_avg: string;
    precip_chance_max: string;
    cloud_cover_avg: string;
  };
};

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  activity: string;
  windows: WindowOut[];
  summary: string;
};

// Internal struct for windows during the greedy sweep. Carries the raw
// indices so we can later compute conditions averages from the source array
// without re-walking it from scratch.
type RawWindow = {
  startIdx: number;
  endIdx: number; // inclusive
};

// Greedy O(N) sweep: walk the pass/fail array, opening a run on every
// false→true transition and closing it on every true→false transition. The
// final loop closes any run that runs to the end of the array. Returns
// half-open intervals as [startIdx, endIdx] inclusive on both ends so the
// caller can read entries[startIdx..endIdx] directly.
function sweepWindows(passes: boolean[]): RawWindow[] {
  const windows: RawWindow[] = [];
  let runStart: number | null = null;
  for (let i = 0; i < passes.length; i++) {
    if (passes[i]) {
      if (runStart === null) runStart = i;
    } else if (runStart !== null) {
      windows.push({ startIdx: runStart, endIdx: i - 1 });
      runStart = null;
    }
  }
  if (runStart !== null) {
    windows.push({ startIdx: runStart, endIdx: passes.length - 1 });
  }
  return windows;
}

// Score the window. We use precip-based differentiation: 1 - (max precip pop
// in window / 100). Equally-passing windows still differentiate — a window
// where precip pop maxes out at 5% scores 0.95 and beats one that grazes
// 28% (just under the hike preset's 30% cap) at 0.72. Pure constants like
// 1.0 across the board would drop the sort signal.
function scoreWindow(window: HourlyEntry[]): number {
  let maxPop = 0;
  for (const entry of window) {
    if (entry.precipitation_probability > maxPop) {
      maxPop = entry.precipitation_probability;
    }
  }
  return 1 - maxPop / 100;
}

// Compute the conditions block for a window: average temperature, average
// wind, MAX precipitation probability (the differentiator the score uses),
// and average cloud cover. Formatters add unit suffixes so the LLM caller
// gets self-describing strings.
function summarizeConditions(
  window: HourlyEntry[],
  units: Units,
): WindowOut["conditions"] {
  let tempSum = 0;
  let windSum = 0;
  let cloudSum = 0;
  let popMax = 0;
  for (const entry of window) {
    tempSum += entry.temperature;
    windSum += entry.wind_speed;
    cloudSum += entry.cloud_cover;
    if (entry.precipitation_probability > popMax) {
      popMax = entry.precipitation_probability;
    }
  }
  const n = window.length;
  return {
    temp_avg: formatTemp(tempSum / n, units),
    wind_avg: formatWind(windSum / n, undefined, units),
    precip_chance_max: formatPercent(popMax),
    cloud_cover_avg: formatPercent(cloudSum / n),
  };
}

export const outdoorWindow = defineTool<Input, Output, WeatherContext>({
  name: "outdoor_window",
  description: "Best outdoor windows in next 1-7 days.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // types for `activity`, `days`, `min_window_hours` are `... | undefined`
  // but the output types are concrete.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    const units = input.units ?? ctx.defaults.units;
    const preset = ACTIVITY_PRESETS[input.activity as ActivityName];

    const { entries, timezone } = await ctx.client.getHourly({
      lat: resolved.lat,
      lng: resolved.lng,
      units,
      hours: input.days * 24,
    });

    // Pass/fail per hour. Greedy sweep below operates on this boolean array
    // so we don't re-evaluate the preset during window assembly.
    const passes = entries.map((e) => passesPreset(e, preset, units));
    const rawWindows = sweepWindows(passes);

    // Filter by minimum duration, then score. duration_hours is INCLUSIVE
    // count: indices 9..11 = 3 hours.
    type ScoredWindow = {
      raw: RawWindow;
      slice: HourlyEntry[];
      duration: number;
      score: number;
    };
    const scored: ScoredWindow[] = [];
    for (const raw of rawWindows) {
      const duration = raw.endIdx - raw.startIdx + 1;
      if (duration < input.min_window_hours) continue;
      const slice = entries.slice(raw.startIdx, raw.endIdx + 1);
      scored.push({ raw, slice, duration, score: scoreWindow(slice) });
    }

    // Sort by score desc; tie-break on earliest start time ascending so the
    // user sees the soonest equally-good window first.
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.raw.startIdx - b.raw.startIdx;
    });

    const top = scored.slice(0, 3);
    const windows: WindowOut[] = top.map((w) => {
      const startEntry = w.slice[0]!;
      const endEntry = w.slice[w.slice.length - 1]!;
      return {
        start: startEntry.time,
        end: endEntry.time,
        duration_hours: w.duration,
        score: w.score,
        conditions: summarizeConditions(w.slice, units),
      };
    });

    let summary: string;
    if (windows.length === 0) {
      summary = `No suitable ${input.activity} windows in next ${input.days} days.`;
    } else {
      // Humanise up to the first 2 window starts in the headline. Date
      // prefix is the YYYY-MM-DD before the `T` — Open-Meteo returns
      // suffix-less ISO local strings so the prefix is timezone-stable.
      const parts = windows.slice(0, 2).map((w) => {
        const date = w.start.split("T")[0] ?? w.start;
        return `${formatHourLabel(w.start)} on ${date}`;
      });
      summary = `Best ${input.activity} windows: ${parts.join(", ")}.`;
    }

    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone,
      },
      activity: input.activity,
      windows,
      summary,
    };
  },
});
