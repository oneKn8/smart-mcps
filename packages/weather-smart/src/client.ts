import { fetchJson, loadCreds } from "smart-mcp-core";
import { TtlCache, TTL } from "./cache.js";

// Optional credentials sourced from process.env, the shared
// ~/.config/smart-mcps/.env, or per-service config files. None are required —
// weather-smart wraps Open-Meteo (no key) and NWS (no key, just User-Agent).
// The two optional vars let the user pin a default unit system and home
// location so they can ask "what's the weather?" without naming a city every
// time.
export type WeatherCreds = {
  WEATHER_DEFAULT_UNITS?: "metric" | "imperial";
  WEATHER_DEFAULT_LOCATION?: string;
};

// loadCreds is constrained to Record<string, string>, so we shape the
// resolved record that way and validate WEATHER_DEFAULT_UNITS at construction
// time before narrowing to the public WeatherCreds type.
type WeatherCredsRecord = Record<
  "WEATHER_DEFAULT_UNITS" | "WEATHER_DEFAULT_LOCATION",
  string
>;

const OPEN_METEO_GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";

// NWS requires every request to identify the caller via User-Agent. Reuse
// across all NWS-bound calls so api.weather.gov can rate-limit per app.
// Phase 4 task 2 only exercises Open-Meteo, but the constant is defined here
// for the upcoming alerts/forecast tools.
const NWS_USER_AGENT = "smart-mcps weather-smart (capcat774@gmail.com)";

// Unit system selector. Maps to the upstream Open-Meteo unit query params:
//   metric   → celsius / kmh / mm
//   imperial → fahrenheit / mph / inch
// Tools normalise the user's request to one of these two before calling the
// client. We don't expose the upstream parameter names directly because they
// drift (e.g. windspeed_unit aliases) and we want one stable internal axis.
export type Units = "metric" | "imperial";

// Builds the Open-Meteo unit query parameter trio from a unit system. Kept
// internal — no caller outside this module needs to construct these.
function unitParams(units: Units): Record<string, string> {
  return units === "imperial"
    ? {
        temperature_unit: "fahrenheit",
        windspeed_unit: "mph",
        precipitation_unit: "inch",
      }
    : {
        temperature_unit: "celsius",
        windspeed_unit: "kmh",
        precipitation_unit: "mm",
      };
}

// Open-Meteo returns hourly/daily payloads as parallel arrays:
//   { time: [...], temperature_2m: [...], precipitation: [...] }
// rather than row-major: [{ time, temperature_2m, precipitation }, ...].
// `zip` turns the parallel form into row-major so downstream slim mappers
// can iterate `.map(r => ({...}))` over rows. Length is taken from the first
// key — Open-Meteo guarantees parallel arrays are equal length, but we
// guard with `?? []` so a missing first key produces an empty result rather
// than a TypeError.
function zip<T extends Record<string, unknown[]>>(
  parallel: T,
): Array<{ [K in keyof T]: T[K][number] }> {
  const keys = Object.keys(parallel) as (keyof T)[];
  if (keys.length === 0) return [];
  const firstKey = keys[0] as keyof T;
  const len = (parallel[firstKey] ?? []).length;
  const out: Array<{ [K in keyof T]: T[K][number] }> = [];
  for (let i = 0; i < len; i++) {
    const row = {} as { [K in keyof T]: T[K][number] };
    for (const k of keys) {
      const arr = parallel[k] ?? [];
      row[k] = arr[i] as T[typeof k][number];
    }
    out.push(row);
  }
  return out;
}

// Slim shape for current-conditions queries. Field names are normalised
// from upstream (Open-Meteo prefixes its variables with the measurement
// height — temperature_2m, wind_speed_10m, etc.). The `timezone` field
// comes from the response root, not from `current`.
export type CurrentSnapshot = {
  time: string;
  temperature: number;
  apparent_temperature: number;
  humidity: number;
  precipitation: number;
  weather_code: number;
  wind_speed: number;
  wind_direction: number;
  pressure: number;
  timezone: string;
};

// Slim shape for one hour of an hourly forecast. Same naming convention as
// CurrentSnapshot. `precipitation_probability` is a percent (0-100).
export type HourlyEntry = {
  time: string;
  temperature: number;
  precipitation_probability: number;
  precipitation: number;
  weather_code: number;
  wind_speed: number;
  cloud_cover: number;
  visibility: number;
  uv_index: number;
};

// Slim shape for one day of a daily forecast. `date` is the local
// calendar date (YYYY-MM-DD); sunrise/sunset are local ISO datetimes.
export type DailyEntry = {
  date: string;
  temp_max: number;
  temp_min: number;
  precipitation_sum: number;
  precipitation_probability_max: number;
  sunrise: string;
  sunset: string;
  wind_speed_max: number;
  weather_code: number;
  uv_index_max: number;
};

// Open-Meteo geocoding response shape (slim). The upstream payload carries
// extra fields (country_code, feature_code, admin1_id, etc.) that we don't
// surface. Names are normalised to our naming convention (lat/lng vs.
// upstream's latitude/longitude).
export type GeocodeMatch = {
  name: string;
  lat: number;
  lng: number;
  timezone: string;
  country?: string;
  admin1?: string;
  admin2?: string;
  elevation?: number;
  population?: number;
};

// Builds a stable cache key from a method name and an args bag. JSON.stringify
// preserves field ordering as written here (key insertion order), so callers
// must pass args with consistent key order. Avoids ad-hoc `:`-separated keys
// that collide once any string value contains a literal `:`.
function cacheKey(method: string, args: unknown): string {
  return `${method}:${JSON.stringify(args)}`;
}

export class WeatherClient {
  private readonly creds: WeatherCreds;
  private readonly cache = new TtlCache();

  constructor(creds?: WeatherCreds) {
    if (creds) {
      this.creds = creds;
      return;
    }
    const raw = loadCreds<WeatherCredsRecord>({
      serviceName: "weather-smart",
      required: [],
      optional: ["WEATHER_DEFAULT_UNITS", "WEATHER_DEFAULT_LOCATION"],
    });
    // Validate WEATHER_DEFAULT_UNITS eagerly so bad config surfaces at
    // startup rather than when a downstream formatter receives an unexpected
    // unit string. Same eager-fail pattern as runpod-smart's required-key
    // check.
    const units = (raw as Partial<WeatherCredsRecord>).WEATHER_DEFAULT_UNITS;
    if (units !== undefined && units !== "metric" && units !== "imperial") {
      throw new Error(
        `WEATHER_DEFAULT_UNITS must be 'metric' or 'imperial', got '${units}'`,
      );
    }
    this.creds = raw as WeatherCreds;
  }

  // The optional default unit system used when callers don't specify one.
  // Exposed as a typed accessor so downstream tools can read this without
  // reaching into the private creds record.
  getDefaultUnits(): "metric" | "imperial" | undefined {
    return this.creds.WEATHER_DEFAULT_UNITS;
  }

  // The optional default location used when callers don't name a city.
  // Used by the location resolver to back "what's the weather?" without args.
  getDefaultLocation(): string | undefined {
    return this.creds.WEATHER_DEFAULT_LOCATION;
  }

  // Open-Meteo geocoding. Cached for 24 hours per query+limit pair (cities
  // don't move and names rarely change). Returns {matches: []} when no
  // results — the upstream response simply omits the `results` field on
  // empty matches rather than returning [].
  async geocode(
    query: string,
    limit = 5,
  ): Promise<{ matches: GeocodeMatch[] }> {
    const key = cacheKey("geocode", { query, limit });
    const cached = this.cache.get<{ matches: GeocodeMatch[] }>(key);
    if (cached) return cached;

    const data = await fetchJson<{
      results?: Array<Record<string, unknown>>;
    }>(OPEN_METEO_GEOCODE, {
      searchParams: {
        name: query,
        count: String(limit),
        language: "en",
        format: "json",
      },
    });

    const results = data.results ?? [];
    const matches: GeocodeMatch[] = results.map((r) => ({
      name: r.name as string,
      lat: r.latitude as number,
      lng: r.longitude as number,
      timezone: r.timezone as string,
      country: r.country as string | undefined,
      admin1: r.admin1 as string | undefined,
      admin2: r.admin2 as string | undefined,
      elevation: r.elevation as number | undefined,
      population: r.population as number | undefined,
    }));

    const out = { matches };
    this.cache.set(key, out, TTL.geocode);
    return out;
  }

  // Current conditions for a coordinate. Open-Meteo `current=` query bundles
  // multiple variables into a single response object. `timezone=auto` tells
  // upstream to resolve the local timezone from lat/lng so the returned
  // `time` is local — never UTC. Cached for TTL.current (5 min).
  async getCurrent(args: {
    lat: number;
    lng: number;
    units: Units;
  }): Promise<CurrentSnapshot> {
    const key = cacheKey("getCurrent", args);
    const cached = this.cache.get<CurrentSnapshot>(key);
    if (cached) return cached;

    const data = await fetchJson<{
      timezone: string;
      current: Record<string, unknown>;
    }>(OPEN_METEO_FORECAST, {
      searchParams: {
        latitude: String(args.lat),
        longitude: String(args.lng),
        timezone: "auto",
        current:
          "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,apparent_temperature,pressure_msl",
        ...unitParams(args.units),
      },
    });

    const c = data.current;
    const out: CurrentSnapshot = {
      time: c.time as string,
      temperature: c.temperature_2m as number,
      apparent_temperature: c.apparent_temperature as number,
      humidity: c.relative_humidity_2m as number,
      precipitation: c.precipitation as number,
      weather_code: c.weather_code as number,
      wind_speed: c.wind_speed_10m as number,
      wind_direction: c.wind_direction_10m as number,
      pressure: c.pressure_msl as number,
      timezone: data.timezone,
    };

    this.cache.set(key, out, TTL.current);
    return out;
  }

  // Hourly forecast slice. `hours` is the count the caller wants (1+); we
  // ask Open-Meteo for `Math.ceil(hours/24)` forecast days, then slice the
  // zipped rows to the requested count. Open-Meteo always returns full days
  // starting at hour 0 local — the slice runs from the start of "today" so
  // `hours: 6` returns hours 0..5, not the next 6 hours from "now". Cached
  // for TTL.hourly (30 min).
  async getHourly(args: {
    lat: number;
    lng: number;
    units: Units;
    hours: number;
  }): Promise<{ entries: HourlyEntry[]; timezone: string }> {
    const key = cacheKey("getHourly", args);
    const cached = this.cache.get<{
      entries: HourlyEntry[];
      timezone: string;
    }>(key);
    if (cached) return cached;

    const forecastDays = Math.ceil(args.hours / 24);

    const data = await fetchJson<{
      timezone: string;
      hourly: {
        time: string[];
        temperature_2m: number[];
        precipitation_probability: number[];
        precipitation: number[];
        weather_code: number[];
        wind_speed_10m: number[];
        cloud_cover: number[];
        visibility: number[];
        uv_index: number[];
      };
    }>(OPEN_METEO_FORECAST, {
      searchParams: {
        latitude: String(args.lat),
        longitude: String(args.lng),
        timezone: "auto",
        hourly:
          "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,cloud_cover,visibility,uv_index",
        forecast_days: String(forecastDays),
        ...unitParams(args.units),
      },
    });

    const zipped = zip(data.hourly).slice(0, args.hours);
    const entries: HourlyEntry[] = zipped.map((r) => ({
      time: r.time,
      temperature: r.temperature_2m,
      precipitation_probability: r.precipitation_probability,
      precipitation: r.precipitation,
      weather_code: r.weather_code,
      wind_speed: r.wind_speed_10m,
      cloud_cover: r.cloud_cover,
      visibility: r.visibility,
      uv_index: r.uv_index,
    }));

    const out = { entries, timezone: data.timezone };
    this.cache.set(key, out, TTL.hourly);
    return out;
  }

  // Daily forecast slice. `days` is passed straight through to Open-Meteo as
  // forecast_days (valid range 1..16). Cached for TTL.daily (1 hour) — the
  // upstream daily aggregator regenerates less frequently than hourly.
  async getDaily(args: {
    lat: number;
    lng: number;
    units: Units;
    days: number;
  }): Promise<{ entries: DailyEntry[]; timezone: string }> {
    const key = cacheKey("getDaily", args);
    const cached = this.cache.get<{
      entries: DailyEntry[];
      timezone: string;
    }>(key);
    if (cached) return cached;

    const data = await fetchJson<{
      timezone: string;
      daily: {
        time: string[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_sum: number[];
        precipitation_probability_max: number[];
        sunrise: string[];
        sunset: string[];
        wind_speed_10m_max: number[];
        weather_code: number[];
        uv_index_max: number[];
      };
    }>(OPEN_METEO_FORECAST, {
      searchParams: {
        latitude: String(args.lat),
        longitude: String(args.lng),
        timezone: "auto",
        daily:
          "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,wind_speed_10m_max,weather_code,uv_index_max",
        forecast_days: String(args.days),
        ...unitParams(args.units),
      },
    });

    const zipped = zip(data.daily);
    const entries: DailyEntry[] = zipped.map((r) => ({
      date: r.time,
      temp_max: r.temperature_2m_max,
      temp_min: r.temperature_2m_min,
      precipitation_sum: r.precipitation_sum,
      precipitation_probability_max: r.precipitation_probability_max,
      sunrise: r.sunrise,
      sunset: r.sunset,
      wind_speed_max: r.wind_speed_10m_max,
      weather_code: r.weather_code,
      uv_index_max: r.uv_index_max,
    }));

    const out = { entries, timezone: data.timezone };
    this.cache.set(key, out, TTL.daily);
    return out;
  }
}

// Re-export so other modules (or future tools) can import the constant
// without re-deriving it.
export { NWS_USER_AGENT, OPEN_METEO_GEOCODE, OPEN_METEO_FORECAST };
