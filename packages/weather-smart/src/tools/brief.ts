import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import { locationInput } from "./location-input.js";
import { weatherCodeLabel } from "./weather-codes.js";
import { formatTemp, formatWind, formatPercent } from "./format.js";
import { resolveLocation } from "../location-resolver.js";

// Composed shortcut: returns "what's it doing right now, today, and tomorrow?"
// in a single call. Wraps `getCurrent` + a 2-day `getDaily`, run in parallel,
// then renders compact slim shapes plus a 2-3 sentence prose digest. The prose
// is intentionally derived from the same fields the structured payload exposes
// so an LLM caller can either quote `brief` verbatim or reformat from the
// structured fields.
const inputSchema = locationInput.extend({
  units: z.enum(["metric", "imperial"]).optional(),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  current: {
    temp: string;
    feels_like: string;
    conditions: string;
    wind: string;
    humidity: string;
  };
  today: {
    high: string;
    low: string;
    conditions: string;
    precip_chance: string;
    sunrise: string;
    sunset: string;
    wind_max: string;
  };
  tomorrow: {
    high: string;
    low: string;
    conditions: string;
    precip_chance: string;
  };
  brief: string;
};

export const dailyBrief = defineTool<Input, Output, WeatherContext>({
  name: "daily_brief",
  description: "Quick brief: now, today, tomorrow.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type differs from its output type for optional fields.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    const units = input.units ?? ctx.defaults.units;

    // Fetch current snapshot and 2-day daily forecast concurrently. Both calls
    // are independent — neither depends on the other's output — so Promise.all
    // halves wall-clock latency vs sequential awaits.
    const [snap, daily] = await Promise.all([
      ctx.client.getCurrent({ lat: resolved.lat, lng: resolved.lng, units }),
      ctx.client.getDaily({
        lat: resolved.lat,
        lng: resolved.lng,
        units,
        days: 2,
      }),
    ]);

    const todayEntry = daily.entries[0];
    const tomorrowEntry = daily.entries[1];
    if (!todayEntry || !tomorrowEntry) {
      throw new Error("daily forecast missing today/tomorrow entries");
    }

    const current = {
      temp: formatTemp(snap.temperature, units),
      feels_like: formatTemp(snap.apparent_temperature, units),
      conditions: weatherCodeLabel(snap.weather_code),
      wind: formatWind(snap.wind_speed, snap.wind_direction, units),
      humidity: formatPercent(snap.humidity),
    };

    const today = {
      high: formatTemp(todayEntry.temp_max, units),
      low: formatTemp(todayEntry.temp_min, units),
      conditions: weatherCodeLabel(todayEntry.weather_code),
      precip_chance: formatPercent(todayEntry.precipitation_probability_max),
      sunrise: todayEntry.sunrise,
      sunset: todayEntry.sunset,
      wind_max: formatWind(todayEntry.wind_speed_max, undefined, units),
    };

    const tomorrow = {
      high: formatTemp(tomorrowEntry.temp_max, units),
      low: formatTemp(tomorrowEntry.temp_min, units),
      conditions: weatherCodeLabel(tomorrowEntry.weather_code),
      precip_chance: formatPercent(tomorrowEntry.precipitation_probability_max),
    };

    // Compose the prose digest. Sentence 3 only contrasts tomorrow if its
    // weather code differs from today's — otherwise we collapse to a single
    // "looks similar" clause to avoid awkward duplication like "Tomorrow: 84F
    // with Partly cloudy" right after "Today's high 84F partly cloudy".
    const sameCode = todayEntry.weather_code === tomorrowEntry.weather_code;
    const tomorrowSentence = sameCode
      ? "Tomorrow looks similar."
      : `Tomorrow: ${tomorrow.high} with ${tomorrow.conditions.toLowerCase()}.`;
    const brief = [
      `Currently ${current.conditions.toLowerCase()} at ${current.temp} in ${resolved.name}.`,
      `Today's high ${today.high}, low ${today.low}, ${today.precip_chance} chance of precipitation.`,
      tomorrowSentence,
    ].join(" ");

    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone: daily.timezone,
      },
      current,
      today,
      tomorrow,
      brief,
    };
  },
});
