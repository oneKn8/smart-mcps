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

// NWS requires every request to identify the caller via User-Agent. Reuse
// across all NWS-bound calls so api.weather.gov can rate-limit per app.
// Phase 4 task 2 only exercises Open-Meteo, but the constant is defined here
// for the upcoming alerts/forecast tools.
const NWS_USER_AGENT = "smart-mcps weather-smart (capcat774@gmail.com)";

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
}

// Re-export so other modules (or future tools) can import the constant
// without re-deriving it.
export { NWS_USER_AGENT, OPEN_METEO_GEOCODE };
