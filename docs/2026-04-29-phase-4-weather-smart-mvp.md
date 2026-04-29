# weather-smart MVP (Phase 4) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task in this session. Each task gets a fresh implementer subagent + spec compliance reviewer + code quality reviewer.

**Goal:** Ship `weather-smart` MCP — 14 read-only tools wrapping Open-Meteo (forecast/hourly/historical/air-quality/geocoding) + NWS (US alerts) with smart shortcuts for daily briefing, umbrella check, frost/heat alerts, sunset planning, multi-location compare, and activity-window scoring. Zero required credentials. Single user. All unit tests green. Tag `phase-4-weather-smart-mvp` on origin.

**Architecture:** New workspace `packages/weather-smart/`. Imports `smart-mcp-core` for `loadCreds`, `fetchJson`, `defineTool`, `createMcpServer`. One `WeatherClient` class spans both upstreams (Open-Meteo + NWS) since they share auth/retry shape. In-memory TTL cache (`cache.ts`) wraps client GETs. `location-resolver.ts` lets every tool accept either `{ lat, lng }` or `{ location: string }`. Tools split by topic: raw data (current/forecast/hourly/historical/air-quality/alerts), resolution (geocode), smart shortcuts (brief/umbrella/frost/heat/outdoor/compare/sunset). Tests use `msw 2.6` for upstream HTTP, `vi.useFakeTimers()` for any time math. **NO destructive ops** — no `guardDestructive`, no `confirm` field anywhere. Pure read-only API.

**Tech Stack:** TypeScript 5.7 ESM, Node 22+, vitest 2.1, msw 2.6, zod 3.24, `@modelcontextprotocol/sdk` 1.12. No new core changes required.

---

## Upstream APIs (locked in by research, 2026-04-28)

### Open-Meteo

Base: `https://api.open-meteo.com/v1`. **No auth header.** No key.

| Purpose | URL |
|---------|-----|
| Forecast (current + hourly + daily) | `https://api.open-meteo.com/v1/forecast` |
| Geocoding | `https://geocoding-api.open-meteo.com/v1/search` |
| Air quality | `https://air-quality-api.open-meteo.com/v1/air-quality` |
| Historical (ERA5) | `https://archive-api.open-meteo.com/v1/archive` |

**CRITICAL gotcha — parallel arrays, NOT array of objects.** Every Open-Meteo response uses the parallel-array shape. Example hourly response:

```json
{
  "latitude": 32.7767,
  "longitude": -96.7970,
  "timezone": "America/Chicago",
  "elevation": 131.0,
  "hourly": {
    "time": ["2026-04-29T00:00", "2026-04-29T01:00", "2026-04-29T02:00"],
    "temperature_2m": [72.5, 71.8, 71.2],
    "precipitation_probability": [10, 15, 20],
    "wind_speed_10m": [8.2, 7.5, 6.9],
    "weather_code": [1, 2, 3]
  }
}
```

The client MUST zip these parallel arrays into `[{ time, temperature_2m, precipitation_probability, wind_speed_10m, weather_code }, ...]` at the boundary so downstream tools never see the raw shape. Same for `daily.*`. Current-conditions response returns scalars, not arrays:

```json
{
  "current": {
    "time": "2026-04-29T14:00",
    "temperature_2m": 78.4,
    "relative_humidity_2m": 45,
    "precipitation": 0,
    "weather_code": 1,
    "wind_speed_10m": 12.3
  }
}
```

**Forecast query params used:**

```
latitude=32.7767
longitude=-96.7970
timezone=auto
current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,apparent_temperature,pressure_msl
hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,cloud_cover,visibility,uv_index
daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,wind_speed_10m_max,weather_code,uv_index_max
forecast_days=N            # 1-16
past_days=0
temperature_unit=fahrenheit|celsius
windspeed_unit=mph|kmh
precipitation_unit=inch|mm
```

`timezone=auto` is REQUIRED. Never omit. Without it Open-Meteo returns UTC and `today` math breaks for users not in UTC.

**Geocoding response shape:**

```json
{
  "results": [
    {
      "id": 4684888,
      "name": "Dallas",
      "latitude": 32.78306,
      "longitude": -96.80667,
      "elevation": 137.0,
      "timezone": "America/Chicago",
      "country": "United States",
      "country_code": "US",
      "admin1": "Texas",
      "admin2": "Dallas County",
      "population": 1300092
    }
  ]
}
```

Empty matches → `results` field absent. Handle that.

**Air quality query params:**

```
latitude=...
longitude=...
current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide
```

Pollen requires separate `hourly=alder_pollen,birch_pollen,grass_pollen,olive_pollen,ragweed_pollen` and is **only available for Europe** in Open-Meteo's free tier (CAMS). For US locations pollen returns null arrays — handle gracefully (return `pollen: undefined` in slim shape, not an error).

**Historical (archive) response:** same parallel-array shape as forecast, but `daily` only (no current). Endpoint:

```
https://archive-api.open-meteo.com/v1/archive?latitude=...&longitude=...&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&temperature_unit=...
```

Date range MUST be ≥2 days back from today (ERA5 has a ~5-day lag). Validate at tool layer.

### NWS

Base: `https://api.weather.gov`. **No auth header**, but **REQUIRED `User-Agent` header** — they actually check this and 403 you without it.

User-Agent value: `smart-mcps weather-smart (capcat774@gmail.com)`.

Endpoint used:

```
GET https://api.weather.gov/alerts/active?point={lat},{lng}
```

Response:

```json
{
  "features": [
    {
      "id": "https://api.weather.gov/alerts/urn:oid:...",
      "properties": {
        "event": "Severe Thunderstorm Warning",
        "severity": "Severe",
        "urgency": "Immediate",
        "certainty": "Observed",
        "headline": "Severe Thunderstorm Warning issued April 29 at 3:42PM CDT...",
        "description": "...",
        "expires": "2026-04-29T16:30:00-05:00",
        "areaDesc": "Dallas, TX; Tarrant, TX"
      }
    }
  ]
}
```

For non-US lat/lng: `lat < 24.5 || lat > 49.4 || lng < -125 || lng > -66.9` (rough US lower-48 bbox; Alaska/Hawaii/PR can be added later if user asks). Short-circuit BEFORE the HTTP call:

```ts
return { location, alerts: [], note: "alerts only available for US locations" };
```

This is cleaner than calling NWS and getting an empty array, and it avoids the `User-Agent` requirement when not needed.

---

## Credential model

Zero required creds. Both env vars optional:

```ts
type WeatherCreds = {
  WEATHER_DEFAULT_UNITS?: "metric" | "imperial";
  WEATHER_DEFAULT_LOCATION?: string;
};
```

Resolution order (matches `loadCreds` pattern): `process.env` → `~/.config/smart-mcps/.env` → fallback. When neither set: units = `"imperial"`, no default location. A tool invoked without `lat`/`lng`/`location` AND no `WEATHER_DEFAULT_LOCATION` throws:

```
Error("location required: pass {lat,lng} or {location} or set WEATHER_DEFAULT_LOCATION")
```

`loadCreds` is still called (consistency) but BOTH vars go into `optional`, NEITHER into `required`.

---

## Cache strategy

`src/cache.ts` exposes:

```ts
export class TtlCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();
  get<T>(key: string): T | undefined { ... }
  set(key: string, value: unknown, ttlMs: number): void { ... }
  clear(): void { ... }
}
```

Per-resource TTL (in ms):

| Resource | TTL | Notes |
|----------|-----|-------|
| current | 5 * 60_000 | 5 min |
| hourly | 30 * 60_000 | 30 min |
| daily forecast | 60 * 60_000 | 1 hr |
| historical | Number.POSITIVE_INFINITY | immutable (never expires) |
| alerts | 0 | safety-critical, never cache |
| air_quality | 30 * 60_000 | 30 min |
| geocode | 24 * 60 * 60_000 | 24 hr |

Cache key = `${methodName}:${JSON.stringify(args)}`. `set(key, value, 0)` is a no-op (skip cache for alerts).

Smart shortcuts call cached client methods, so they inherit cache reuse for free.

---

## Conventions for the implementer subagent

Same as Phase 1-3.5 with weather-specific overlays:

1. **Strict TDD.** Red → green → refactor → atomic commit. One commit per task.
2. **Conventional commits.** `feat(weather): ...`, `test(weather): ...`, `fix(weather): ...`, `refactor(weather): ...`, `chore(weather): ...`, `docs(weather): ...`.
3. **No emojis. No mentions of AI/Claude/Anthropic/former-employer. No co-author lines.**
4. **Tool descriptions ≤ 15 tokens.**
5. **Network forbidden in tests.** Use `msw 2.6` for every Open-Meteo and NWS call at client level. Tool-level tests stub the client directly via `vi.fn().mockResolvedValue(...)`.
6. **No `confirm` field anywhere.** Weather-smart has zero destructive ops. Do NOT import `guardDestructive`.
7. **Schema cast pattern.** When tool input schema has `.optional().default(...)`, use the `inputSchema as unknown as z.ZodType<Input>` cast with the canonical comment from `packages/vercel-smart/src/tools/projects.ts`.
8. **Slim outputs.** Every tool returns explicit `type Output = {...}` and the handler returns this shape exactly. Tools strip upstream extras.
9. **Location resolution.** Every forecast/conditions tool accepts `{ lat?, lng?, location? }`. Use `resolveLocation()` from `location-resolver.ts`. Include resolved `location: { name, lat, lng, timezone }` in every slim output.
10. **Units passthrough.** Open-Meteo handles unit conversion via query params. Never manually convert in code. Format strings always include suffix (`"72F"`, `"15mph"`, `"0.3in"`).
11. **`timezone=auto` is mandatory** on every Open-Meteo forecast/hourly/daily/historical call.
12. **NWS `User-Agent` is mandatory** on every NWS call. Hardcode the value `smart-mcps weather-smart (capcat774@gmail.com)`.
13. **Test isolation gotcha (memory).** Any test that asserts default-units fallback OR default-location fallback OR "no defaults set" MUST in `beforeEach`: save & override `process.env.HOME` to a tmp dir, save & delete `process.env.WEATHER_DEFAULT_UNITS`, save & delete `process.env.WEATHER_DEFAULT_LOCATION`. Restore in `afterEach`. Otherwise `loadCreds` reads the real `~/.config/smart-mcps/.env` and assertions silently pass when they shouldn't. See `packages/vercel-smart/src/__tests__/client.test.ts`'s pattern.
14. **Fixtures.** Use `Test City`, `Sample Park`, `lat: 32.7767, lng: -96.7970` (Dallas), `lat: 51.5074, lng: -0.1278` (London for non-US tests), `lat: -33.8688, lng: 151.2093` (Sydney for southern hemisphere test). Never real customer/project names.
15. **Helpers.** `null-helpers.ts` exports `nullableString`, `nullableNumber`, `nullableBoolean`. Use these in mappers — don't duplicate inline.

---

## Task list

### Task 1: Scaffold `packages/weather-smart` workspace

**Files:**
- Create: `packages/weather-smart/package.json`
- Create: `packages/weather-smart/tsconfig.json`
- Create: `packages/weather-smart/vitest.config.ts`
- Create: `packages/weather-smart/src/server.ts` (placeholder boots empty server)
- Create: `packages/weather-smart/src/tools/index.ts` (placeholder exports `tools = []`)
- Create: `packages/weather-smart/README.md` (placeholder, will be filled in Task 12)

**Steps:**

1. Mirror `packages/runpod-smart/package.json` structure. Set `"name": "weather-smart"`, `"version": "0.1.0"`. Deps: `smart-mcp-core: "*"`, `@modelcontextprotocol/sdk: "^1.12.0"`, `zod: "^3.24.0"`. Dev deps: `vitest`, `msw`, `@types/node`. Scripts: `build` (`tsc -p tsconfig.json && chmod +x dist/server.js`), `test`, `typecheck`, `lint`, `smoke` (`timeout 3 node dist/server.js < /dev/null`).
2. `tsconfig.json` extends `../../tsconfig.base.json`, references `../core`, composite, outDir `dist`.
3. `vitest.config.ts` matches runpod-smart's (globals on, environment node).
4. `src/server.ts` calls `createMcpServer({ name: "weather-smart", version: "0.1.0", tools: [], context: { client: null as any, defaults: { units: "imperial" as const, location: undefined } } })`. (Real context wired in Task 2.)
5. `src/tools/index.ts` exports `export const tools = [] as const;`.
6. Run `npm install` from repo root.
7. Run `npm run build --workspace weather-smart`. Expect clean.
8. Smoke check: `timeout 3 node packages/weather-smart/dist/server.js < /dev/null`. Expect exit 0.

**Commit:** `chore(weather): scaffold workspace`

---

### Task 2: `WeatherClient` + `TtlCache` + `geocode()` method (TDD)

**Files:**
- Create: `packages/weather-smart/src/cache.ts`
- Create: `packages/weather-smart/src/client.ts`
- Create: `packages/weather-smart/src/location-resolver.ts`
- Create: `packages/weather-smart/src/context.ts`
- Create: `packages/weather-smart/src/__tests__/cache.test.ts`
- Create: `packages/weather-smart/src/__tests__/client.test.ts`
- Create: `packages/weather-smart/src/__tests__/location-resolver.test.ts`

**`cache.ts`:**

```ts
export class TtlCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== Number.POSITIVE_INFINITY && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return; // never cache
    const expiresAt = ttlMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttlMs;
    this.store.set(key, { value, expiresAt });
  }

  clear(): void { this.store.clear(); }
}

export const TTL = {
  current: 5 * 60_000,
  hourly: 30 * 60_000,
  daily: 60 * 60_000,
  historical: Number.POSITIVE_INFINITY,
  alerts: 0,
  airQuality: 30 * 60_000,
  geocode: 24 * 60 * 60_000,
} as const;
```

**Cache tests (`cache.test.ts`, ≥10 tests):**
1. `get` returns undefined for missing key
2. `set` then `get` returns value within TTL
3. `get` returns undefined after TTL elapses (use `vi.useFakeTimers()` + `vi.setSystemTime()`)
4. `set` with `ttlMs: 0` is a no-op (subsequent `get` returns undefined)
5. `set` with `Number.POSITIVE_INFINITY` never expires (advance time 100 years)
6. Different keys don't collide
7. Re-setting same key overwrites
8. `clear()` empties the cache
9. Expired entries are evicted on `get` (verify map size shrinks)
10. `TTL` constants match the locked values

**`location-resolver.ts`:**

```ts
export type ResolvedLocation = {
  lat: number;
  lng: number;
  name: string;
  timezone: string;
};

export type LocationInput = {
  lat?: number;
  lng?: number;
  location?: string;
};

export type Defaults = {
  units: "metric" | "imperial";
  location?: string;
};

export type GeocodeFn = (query: string) => Promise<{
  matches: Array<{ name: string; lat: number; lng: number; timezone: string; admin1?: string; country?: string }>;
}>;

export async function resolveLocation(
  input: LocationInput,
  defaults: Defaults,
  geocode: GeocodeFn,
): Promise<ResolvedLocation> {
  if (typeof input.lat === "number" && typeof input.lng === "number") {
    return {
      lat: input.lat,
      lng: input.lng,
      name: `${input.lat.toFixed(4)},${input.lng.toFixed(4)}`,
      timezone: "auto", // Open-Meteo will resolve
    };
  }
  const query = input.location ?? defaults.location;
  if (!query) {
    throw new Error("location required: pass {lat,lng} or {location} or set WEATHER_DEFAULT_LOCATION");
  }
  const { matches } = await geocode(query);
  const top = matches[0];
  if (!top) throw new Error(`no location match for '${query}'`);
  const display = [top.name, top.admin1, top.country].filter(Boolean).join(", ");
  return { lat: top.lat, lng: top.lng, name: display, timezone: top.timezone };
}
```

**Location-resolver tests (`location-resolver.test.ts`, ≥10 tests):**
1. lat/lng input passes through
2. lat/lng input formats name as `"32.7767,-96.7970"` with 4 decimals
3. location string triggers geocode, uses top match
4. location formatted as `"Dallas, Texas, United States"`
5. defaults.location used when input has no lat/lng/location
6. throws when nothing provided and no defaults
7. throws "no location match" when geocode returns empty
8. lat/lng takes precedence over location
9. location takes precedence over defaults
10. handles geocode result missing `admin1` or `country` (filters undefined)

**`context.ts`:**

```ts
import type { WeatherClient } from "./client.js";

export type WeatherContext = {
  client: WeatherClient;
  defaults: {
    units: "metric" | "imperial";
    location: string | undefined;
  };
};
```

**`client.ts` initial:**

```ts
import { fetchJson, loadCreds } from "smart-mcp-core";
import { TtlCache, TTL } from "./cache.js";

export type WeatherCreds = {
  WEATHER_DEFAULT_UNITS?: "metric" | "imperial";
  WEATHER_DEFAULT_LOCATION?: string;
};

const OPEN_METEO_GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";

const NWS_USER_AGENT = "smart-mcps weather-smart (capcat774@gmail.com)";

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

export class WeatherClient {
  readonly creds: WeatherCreds;
  readonly cache = new TtlCache();

  constructor(creds?: WeatherCreds) {
    this.creds = creds ?? loadCreds<WeatherCreds>({
      serviceName: "weather-smart",
      required: [],
      optional: ["WEATHER_DEFAULT_UNITS", "WEATHER_DEFAULT_LOCATION"],
    });
  }

  async geocode(query: string, limit = 5): Promise<{ matches: GeocodeMatch[] }> {
    const cacheKey = `geocode:${query}:${limit}`;
    const cached = this.cache.get<{ matches: GeocodeMatch[] }>(cacheKey);
    if (cached) return cached;

    const data = await fetchJson<{ results?: Array<Record<string, unknown>> }>(OPEN_METEO_GEOCODE, {
      searchParams: { name: query, count: String(limit), language: "en", format: "json" },
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
    this.cache.set(cacheKey, out, TTL.geocode);
    return out;
  }
}
```

**Client tests (`client.test.ts`, ≥8 tests for this task):**
1. Constructor with no env vars (HOME-overridden tmp) succeeds — no required creds
2. Constructor reads `WEATHER_DEFAULT_UNITS` from env
3. `geocode("Dallas")` returns top matches with full mapping
4. `geocode` empty `results` field returns `{ matches: [] }`
5. `geocode` populates cache (second call, no msw handler reset, returns cached)
6. `geocode` 429 retry works (msw responds 429 then 200)
7. `geocode` query string includes `count` and `language`
8. `geocode` matches passed `limit`

**Commit:** `feat(weather): WeatherClient + TtlCache + geocode + location resolver`

---

### Task 3: `geocode` tool (TDD)

**Files:**
- Create: `packages/weather-smart/src/tools/geocode.ts`
- Create: `packages/weather-smart/src/tools/__tests__/geocode.test.ts`
- Modify: `packages/weather-smart/src/tools/index.ts` (export tool)

**Tool spec:**

```ts
// geocode.ts
import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";

const inputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional().default(5),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  matches: Array<{
    name: string;
    lat: number;
    lng: number;
    country: string | null;
    admin1: string | null;
    admin2: string | null;
    timezone: string;
    elevation: number | null;
    population: number | null;
  }>;
  count: number;
};

export const geocode = defineTool<Input, Output, WeatherContext>({
  name: "geocode",
  description: "Resolve location name to candidates.",
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const { matches } = await ctx.client.geocode(input.query, input.limit);
    return {
      matches: matches.map((m) => ({
        name: m.name,
        lat: m.lat,
        lng: m.lng,
        country: m.country ?? null,
        admin1: m.admin1 ?? null,
        admin2: m.admin2 ?? null,
        timezone: m.timezone,
        elevation: m.elevation ?? null,
        population: m.population ?? null,
      })),
      count: matches.length,
    };
  },
});
```

**Tests (≥7):**
1. Returns slim shape with `Object.keys` exactly `["matches", "count"]`
2. Maps undefined optional fields to null
3. `count` matches `matches.length`
4. Default limit 5 used when not specified
5. Custom limit 10 passes through
6. Empty results returns `{ matches: [], count: 0 }`
7. Schema rejects `limit: 0` and `limit: 11`

**Commit:** `feat(weather): geocode tool`

---

### Task 4: Open-Meteo forecast methods (`getCurrent`, `getHourly`, `getDaily`) on client (TDD)

**Files:**
- Modify: `packages/weather-smart/src/client.ts` (add 3 methods + zip helper)
- Modify: `packages/weather-smart/src/__tests__/client.test.ts`

**Add to `client.ts`:**

```ts
const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";

export type Units = "metric" | "imperial";

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

function unitParams(units: Units): Record<string, string> {
  return units === "imperial"
    ? { temperature_unit: "fahrenheit", windspeed_unit: "mph", precipitation_unit: "inch" }
    : { temperature_unit: "celsius", windspeed_unit: "kmh", precipitation_unit: "mm" };
}

function zip<T extends Record<string, unknown[]>>(parallel: T): Array<{ [K in keyof T]: T[K][number] }> {
  const keys = Object.keys(parallel) as (keyof T)[];
  const len = (parallel[keys[0]] ?? []).length;
  const out: Array<{ [K in keyof T]: T[K][number] }> = [];
  for (let i = 0; i < len; i++) {
    const row = {} as { [K in keyof T]: T[K][number] };
    for (const k of keys) row[k] = parallel[k][i];
    out.push(row);
  }
  return out;
}
```

Add three methods (each with cache + msw test). Each takes `{ lat, lng, units }` (timezone always `auto`):

```ts
async getCurrent(args: { lat: number; lng: number; units: Units }): Promise<CurrentSnapshot> {
  const cacheKey = `current:${JSON.stringify(args)}`;
  const cached = this.cache.get<CurrentSnapshot>(cacheKey);
  if (cached) return cached;

  const data = await fetchJson<{
    timezone: string;
    current: Record<string, unknown>;
  }>(OPEN_METEO_FORECAST, {
    searchParams: {
      latitude: String(args.lat),
      longitude: String(args.lng),
      timezone: "auto",
      current: "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,apparent_temperature,pressure_msl",
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

  this.cache.set(cacheKey, out, TTL.current);
  return out;
}

async getHourly(args: { lat: number; lng: number; units: Units; hours: number }): Promise<{ entries: HourlyEntry[]; timezone: string }> {
  const forecastDays = Math.ceil(args.hours / 24);
  const cacheKey = `hourly:${JSON.stringify(args)}`;
  const cached = this.cache.get<{ entries: HourlyEntry[]; timezone: string }>(cacheKey);
  if (cached) return cached;

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
      hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,cloud_cover,visibility,uv_index",
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
  this.cache.set(cacheKey, out, TTL.hourly);
  return out;
}

async getDaily(args: { lat: number; lng: number; units: Units; days: number }): Promise<{ entries: DailyEntry[]; timezone: string }> {
  // similar shape: forecast_days = args.days, daily = "temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,wind_speed_10m_max,weather_code,uv_index_max"
  // zip + map to DailyEntry, cache TTL.daily
}
```

**Client tests (≥12 added):**
- `getCurrent` body-mapping → exact `CurrentSnapshot` shape
- `getCurrent` imperial passes `temperature_unit=fahrenheit` etc.
- `getCurrent` metric passes `temperature_unit=celsius` etc.
- `getCurrent` `timezone=auto` is sent
- `getCurrent` cache: second call hits cache (no second msw handler match)
- `getHourly` zips parallel arrays correctly (3-hour fixture)
- `getHourly` slices to requested `hours` count
- `getHourly` requests sufficient `forecast_days` for hour count
- `getDaily` body-mapping → exact `DailyEntry` shape
- `getDaily` `forecast_days=N` passed through
- `getDaily` cache TTL distinct from hourly
- All three methods retry on 429

**Commit:** `feat(weather): getCurrent + getHourly + getDaily client methods`

---

### Task 5: `get_current`, `get_forecast`, `get_hourly` tools (TDD)

**Files:**
- Create: `packages/weather-smart/src/tools/current.ts`
- Create: `packages/weather-smart/src/tools/forecast.ts`
- Create: `packages/weather-smart/src/tools/__tests__/current.test.ts`
- Create: `packages/weather-smart/src/tools/__tests__/forecast.test.ts`
- Modify: `packages/weather-smart/src/tools/index.ts`

**Common location input shape (factor into `tools/location-input.ts`):**

```ts
export const locationInput = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  location: z.string().min(1).optional(),
});
```

**`current.ts`:**

```ts
const inputSchema = locationInput.extend({
  units: z.enum(["metric", "imperial"]).optional(),
});

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  observed_at: string;
  temp: string;       // "78F" or "26C"
  feels_like: string;
  conditions: string;        // weather code → human label
  wind: string;       // "12mph WSW"
  humidity: string;   // "45%"
  pressure: string;   // "1015hPa"
  precipitation: string;     // "0in" / "0.3in"
};
```

Handler:
1. Resolve location via `resolveLocation(input, ctx.defaults, (q) => ctx.client.geocode(q))`.
2. Resolve units: `input.units ?? ctx.defaults.units`.
3. Call `ctx.client.getCurrent({ lat, lng, units })`.
4. Format strings using helper `formatTemp(value, units)`, `formatWind(value, direction, units)`, `weatherCodeLabel(code)` (lookup table from WMO codes — can borrow from `https://open-meteo.com/en/docs#weathervariables`).

**Weather code labels** (`tools/weather-codes.ts`, ~28 entries):

```ts
export function weatherCodeLabel(code: number): string {
  const map: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Light rain", 63: "Moderate rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Light snow", 73: "Moderate snow", 75: "Heavy snow",
    77: "Snow grains",
    80: "Light rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    85: "Light snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail", 99: "Severe thunderstorm with hail",
  };
  return map[code] ?? `Unknown (${code})`;
}
```

**`forecast.ts`** — defines two tools `get_forecast` (daily 1-16) and `get_hourly` (1-48). Daily output entries include `sunrise`/`sunset` strings. Hourly output entries include `precip_chance: string` like `"30%"`.

**Tests (≥18 across both files):**
- `get_current`: location resolution from lat/lng, location resolution from string, location resolution from defaults, units default fallback, units override, weather code mapping, output keys exact, missing-location error
- `get_forecast`: days=1, days=16, schema rejects 0/17, sunrise/sunset present, slim shape
- `get_hourly`: hours=1, hours=48, schema rejects 0/49, precip_chance formatted as "%"

**Commit:** `feat(weather): get_current + get_forecast + get_hourly tools`

---

### Task 6: `get_historical` + `get_air_quality` (TDD)

**Files:**
- Modify: `packages/weather-smart/src/client.ts` (add `getHistorical`, `getAirQuality`)
- Create: `packages/weather-smart/src/tools/historical.ts`
- Create: `packages/weather-smart/src/tools/air-quality.ts`
- Create: `packages/weather-smart/src/tools/__tests__/historical.test.ts`
- Create: `packages/weather-smart/src/tools/__tests__/air-quality.test.ts`
- Modify: `packages/weather-smart/src/tools/index.ts`

**`getHistorical`** uses `https://archive-api.open-meteo.com/v1/archive`. Same parallel-array zip pattern, daily-only. TTL = `Number.POSITIVE_INFINITY`.

**`getAirQuality`** uses `https://air-quality-api.open-meteo.com/v1/air-quality` with `current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide`. TTL = `TTL.airQuality` (30 min). Pollen omitted from MVP (Europe-only, complicates Phase 4 scope; defer).

**Tools:**

`get_historical` input: `locationInput.extend({ start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), units: z.enum(["metric","imperial"]).optional() })`. Validate `end_date >= start_date` and `end_date <= today - 5 days` at handler. Output: `{ location, daily: Array<{date, high, low, precip_total, wind_max}> }`.

`get_air_quality` input: `locationInput`. Output: `{ location, observed_at, aqi_us: number, pm2_5: string ("12µg/m³"), pm10, ozone, no2, so2, co, category: "Good"|"Moderate"|"Unhealthy for Sensitive"|"Unhealthy"|"Very Unhealthy"|"Hazardous" }`. AQI category derived from `aqi_us` value via standard EPA breakpoints.

**Tests (≥14):**
- Historical: date validation (bad format, end<start, end too recent), body mapping, ERA5 lag enforcement
- Air quality: AQI category mapping at boundaries (50/100/150/200/300), unit suffix on PM values, slim shape

**Commit:** `feat(weather): get_historical + get_air_quality`

---

### Task 7: NWS client + `get_alerts` tool (TDD)

**Files:**
- Modify: `packages/weather-smart/src/client.ts` (add `getNwsAlerts`)
- Create: `packages/weather-smart/src/tools/alerts.ts`
- Create: `packages/weather-smart/src/tools/__tests__/alerts.test.ts`

**Client method:**

```ts
async getNwsAlerts(lat: number, lng: number): Promise<{ alerts: NwsAlert[] }> {
  // No cache (TTL.alerts === 0).
  const data = await fetchJson<{ features?: Array<{ id: string; properties: Record<string, unknown> }> }>(
    "https://api.weather.gov/alerts/active",
    {
      searchParams: { point: `${lat},${lng}` },
      headers: { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" },
    },
  );
  const features = data.features ?? [];
  const alerts: NwsAlert[] = features.map((f) => ({
    id: f.id,
    event: f.properties.event as string,
    severity: f.properties.severity as string,
    urgency: f.properties.urgency as string,
    certainty: f.properties.certainty as string,
    headline: f.properties.headline as string,
    expires: f.properties.expires as string,
    areas: f.properties.areaDesc as string,
  }));
  return { alerts };
}
```

**Note:** `fetchJson` already supports `headers` in opts (verify by reading `packages/core/src/http.ts` first; if not, add `headers` field — it's likely already there since the email-smart NWS-style transport may have used it).

**Tool `get_alerts`:**

```ts
const inputSchema = locationInput;

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  alerts: Array<{ event; severity; urgency; certainty; headline; expires; areas }>;
  note?: string;
};
```

Handler:
1. Resolve location.
2. Bbox check: `if (lat < 24.5 || lat > 49.4 || lng < -125 || lng > -66.9)` short-circuit `{ location, alerts: [], note: "alerts only available for US locations" }`.
3. Else call `ctx.client.getNwsAlerts(lat, lng)`.

**Tests (≥10):**
1. US lat/lng calls NWS, returns mapped alerts
2. Non-US lat/lng (London 51.5/-0.1) short-circuits with note, NO HTTP call
3. Non-US (Sydney) short-circuits
4. NWS empty `features` → empty alerts array, no note (US, just no active alerts)
5. NWS missing `features` field → empty alerts array
6. User-Agent header included on NWS request (verify via msw handler interceptor)
7. Severity/urgency/certainty/headline mapped correctly from `properties`
8. `areaDesc` mapped to `areas`
9. Cache is NOT used (alerts TTL=0): two consecutive calls both hit msw
10. NWS 403 (missing User-Agent simulation) bubbles error

**Commit:** `feat(weather): NWS client + get_alerts with non-US short-circuit`

---

### Task 8: `daily_brief` + `umbrella_check` smart shortcuts (TDD)

**Files:**
- Create: `packages/weather-smart/src/tools/brief.ts`
- Create: `packages/weather-smart/src/tools/umbrella.ts`
- Create: `packages/weather-smart/src/tools/__tests__/brief.test.ts`
- Create: `packages/weather-smart/src/tools/__tests__/umbrella.test.ts`
- Modify: `packages/weather-smart/src/tools/index.ts`

**`daily_brief`:**

Input: `locationInput.extend({ units: z.enum(["metric","imperial"]).optional() })`.

Output:
```ts
{
  location: { name, lat, lng, timezone };
  current: { temp, feels_like, conditions, wind, humidity };
  today: { high, low, conditions, precip_chance, sunrise, sunset, wind_max };
  tomorrow: { high, low, conditions, precip_chance };
  brief: string;  // 2-3 sentences, prose, e.g. "Currently 78F partly cloudy in Dallas. Today reaches 84F with a 20% chance of afternoon showers. Tomorrow drops to 79F under clear skies."
}
```

Handler: resolve location, fetch current + 2-day daily in parallel via `Promise.all`, compose strings.

**`umbrella_check`:**

Input: `locationInput.extend({ hours: z.number().int().min(6).max(48).optional().default(24), units: z.enum(["metric","imperial"]).optional() })`.

Output:
```ts
{
  location: { name, lat, lng, timezone };
  recommend: boolean;
  peak_hour: string | null;        // ISO time or null if no precip
  peak_pop: number;                // 0-100 percentage
  total_precip: string;            // "0.4in"
  hours_with_rain: number;
  summary: string;                 // "Yes — 70% chance peaking at 5pm. Bring umbrella."
}
```

Recommendation rule: `recommend = (peak_pop >= 40) || (total_precip > 0.1in equivalent) || (hours_with_rain >= 3)`. Tunable, but lock these for MVP.

**Tests (≥18 across both):**
- `daily_brief`: location resolution, units default, output keys exact, brief contains location name + temps + condition word
- `daily_brief`: handles tomorrow having identical conditions (no awkward duplication)
- `umbrella_check`: zero precip → recommend false, peak_hour null, summary mentions "no rain"
- `umbrella_check`: high pop → recommend true, peak hour ISO, summary mentions peak hour
- `umbrella_check`: medium total_precip but low pop → recommend true (rule: total_precip > 0.1)
- `umbrella_check`: hours range bounds (6 minimum, 48 max)
- Both: error path when location unresolvable

**Commit:** `feat(weather): daily_brief + umbrella_check shortcuts`

---

### Task 9: `frost_alert` + `heat_advisory` (TDD)

**Files:**
- Create: `packages/weather-smart/src/tools/frost.ts`
- Create: `packages/weather-smart/src/tools/heat.ts`
- Create: `packages/weather-smart/src/tools/__tests__/frost.test.ts`
- Create: `packages/weather-smart/src/tools/__tests__/heat.test.ts`
- Modify: `packages/weather-smart/src/tools/index.ts`

**`frost_alert` input:**

```ts
locationInput.extend({
  hours: z.number().int().min(24).max(168).optional().default(72),
  threshold: z.number().optional(),       // in user's unit; default = 32 imperial / 0 metric
  units: z.enum(["metric", "imperial"]).optional(),
})
```

Output:
```ts
{
  location, threshold: string ("32F"),
  hours_scanned: number,
  nights_at_risk: Array<{ date: string, min_temp: string, hour: string }>,
  summary: string,    // "Frost expected Mon at 4am (28F) and Wed at 5am (30F)." OR "No frost expected in next 72h."
}
```

Implementation: pull hourly forecast, group by local date (date string before "T"), find min temp per date, filter to dates with min < threshold, return earliest hour at min.

**`heat_advisory` input:**

```ts
locationInput.extend({
  days: z.number().int().min(1).max(7).optional().default(7),
  threshold: z.number().optional(),       // default = 95 imperial / 35 metric
  units: z.enum(["metric", "imperial"]).optional(),
})
```

Output:
```ts
{
  location, threshold: string ("95F"),
  days_scanned: number,
  days_at_risk: Array<{ date: string, max_temp: string, peak_hour: string }>,
  summary: string,
}
```

**Tests (≥16 across both):**
- Default threshold per unit system (32F vs 0C)
- Custom threshold passed through
- All-clear path (no risk days) returns empty array + appropriate summary
- Multi-day risk path
- `peak_hour` is the actual local hour string from data
- `nights_at_risk` ordered chronologically
- Output keys exact

**Commit:** `feat(weather): frost_alert + heat_advisory`

---

### Task 10: `outdoor_window` + activity presets (TDD)

**Files:**
- Create: `packages/weather-smart/src/tools/activity-presets.ts`
- Create: `packages/weather-smart/src/tools/outdoor.ts`
- Create: `packages/weather-smart/src/tools/__tests__/activity-presets.test.ts`
- Create: `packages/weather-smart/src/tools/__tests__/outdoor.test.ts`
- Modify: `packages/weather-smart/src/tools/index.ts`

**`activity-presets.ts`:**

```ts
export type ActivityPreset = {
  name: "hike" | "run" | "picnic" | "drone" | "bike" | "general";
  max_wind_mph: number;
  max_precip_pop: number;        // 0-100
  min_temp_f: number;
  max_temp_f: number;
  max_uv?: number;               // hike summer cap
  max_cloud_cover?: number;      // picnic
  min_visibility_mi?: number;    // drone
};

export const ACTIVITY_PRESETS: Record<ActivityPreset["name"], ActivityPreset> = {
  hike:    { name: "hike",    max_wind_mph: 20, max_precip_pop: 30, min_temp_f: 50, max_temp_f: 85, max_uv: 8 },
  run:     { name: "run",     max_wind_mph: 15, max_precip_pop: 20, min_temp_f: 40, max_temp_f: 75 },
  picnic:  { name: "picnic",  max_wind_mph: 12, max_precip_pop: 15, min_temp_f: 65, max_temp_f: 85, max_cloud_cover: 60 },
  drone:   { name: "drone",   max_wind_mph: 10, max_precip_pop: 5,  min_temp_f: 40, max_temp_f: 95, min_visibility_mi: 5 },
  bike:    { name: "bike",    max_wind_mph: 18, max_precip_pop: 25, min_temp_f: 45, max_temp_f: 85 },
  general: { name: "general", max_wind_mph: 25, max_precip_pop: 40, min_temp_f: 35, max_temp_f: 95 },
};

export function scoreHour(entry: HourlyEntry, preset: ActivityPreset, units: Units): number {
  // Convert thresholds if metric inputs (preset is imperial-native; convert hourly values OR convert preset).
  // For MVP: preset always imperial-native; if units==metric, convert preset thresholds to metric on the fly.
  // Score: 1.0 = perfect; 0 = fails any hard constraint; partial = scaled distance from thresholds.
  // Simplest: compute boolean pass for each constraint; score = (passes / totalConstraints). Tied windows ordered by start time.
  // Acceptable. Document as "MVP scoring; full gradient scoring deferred."
}
```

**`outdoor_window` input:**

```ts
locationInput.extend({
  activity: z.enum(["hike","run","picnic","drone","bike","general"]).optional().default("general"),
  days: z.number().int().min(1).max(7).optional().default(3),
  min_window_hours: z.number().int().min(1).max(12).optional().default(2),
  units: z.enum(["metric","imperial"]).optional(),
})
```

Output:
```ts
{
  location, activity: string,
  windows: Array<{
    start: string,    // ISO
    end: string,
    duration_hours: number,
    score: number,    // 0-1
    conditions: { temp_avg, wind_avg, precip_chance_max, cloud_cover_avg }
  }>,
  summary: string,    // "Best hike windows: Sat 9am-12pm (perfect), Sat 3pm-5pm (good)."
}
```

Algorithm:
1. Pull hourly forecast for `days * 24` hours.
2. For each hour, compute pass/fail for each preset constraint.
3. Greedy-sweep contiguous passing hours into windows.
4. Filter windows with `duration_hours >= min_window_hours`.
5. Score window = mean of hourly pass-rates inside it.
6. Return top 3 windows by score, tie-break by earliest start.

**Tests (≥14):**
- Each preset: a fixture exists where hours pass, returns expected window
- All-fail fixture (gale-force wind for 7d) returns empty windows + summary "No suitable hike windows in next 3 days."
- `min_window_hours` filter works (1-hour gap doesn't qualify)
- Top 3 cap
- Ties broken by earliest start
- Activity preset thresholds: at-boundary tests (wind exactly at max passes/fails — pick one and document)
- Schema rejects unknown activity

**Commit:** `feat(weather): outdoor_window with activity presets`

---

### Task 11: `compare_locations` + `sunset_check` (TDD)

**Files:**
- Create: `packages/weather-smart/src/tools/compare.ts`
- Create: `packages/weather-smart/src/tools/sunset.ts`
- Create: `packages/weather-smart/src/tools/__tests__/compare.test.ts`
- Create: `packages/weather-smart/src/tools/__tests__/sunset.test.ts`
- Modify: `packages/weather-smart/src/tools/index.ts`

**`compare_locations` input:**

```ts
z.object({
  locations: z.array(z.string().min(1)).min(2).max(5),  // names only — uses geocoding
  when: z.enum(["now", "today", "tomorrow"]).optional().default("today"),
  units: z.enum(["metric","imperial"]).optional(),
})
```

Output:
```ts
{
  when: string,
  results: Array<{
    name: string, lat, lng, timezone,
    snapshot: {
      temp: string, conditions: string, precip_chance: string, wind: string,
    }
  }>,
  best_for: { sun: string|null, dry: string|null, mild: string|null },
  summary: string,
}
```

`when=now` → `getCurrent`. `when=today`/`tomorrow` → `getDaily(days=2)` and pick day index. Run all locations via `Promise.all`. `best_for.sun` = location with lowest cloud cover or highest UV; `best_for.dry` = lowest precip chance; `best_for.mild` = temp closest to 70F.

**`sunset_check` input:**

```ts
locationInput.extend({
  date_offset: z.number().int().min(0).max(7).optional().default(0),  // 0=today, 1=tomorrow
  units: z.enum(["metric","imperial"]).optional(),
})
```

Output:
```ts
{
  location,
  date: string,
  sunset: string,                     // ISO local
  conditions_at_sunset: {
    cloud_cover: string ("45%"),
    temp: string,
    precip_chance: string,
    visibility: string ("8mi"),
    wind: string,
  },
  viewing_quality: "great" | "good" | "poor",
  summary: string,
}
```

Implementation: pull `getDaily(days = date_offset+1)` to get sunset time, pull `getHourly(hours = (date_offset+1)*24)`, find hourly entry whose time is closest to sunset. Apply quality rules:
- **great**: cloud cover 30-70%, precip chance < 10%, visibility > 6mi, wind < 15 mph
- **good**: cloud cover 0-90% else, precip chance < 25%, visibility > 4mi
- **poor**: anything else

**Tests (≥16):**
- compare: 2 locations, 5 locations (max), schema rejects 1 / 6
- compare: when=now uses getCurrent, when=today/tomorrow uses getDaily
- compare: best_for.dry picks lowest precip, ties broken by first occurrence
- compare: parallel fetch (verify all locations geocoded once)
- sunset: today (offset 0) and tomorrow (1)
- sunset: 30-70% clouds + low precip → "great"
- sunset: 100% clouds → "poor"
- sunset: rain → "poor"
- sunset: unit suffix on visibility/wind/temp
- sunset: schema rejects offset 8

**Commit:** `feat(weather): compare_locations + sunset_check`

---

### Task 12: Wire, README, install-clients smoke, tag

**Files:**
- Modify: `packages/weather-smart/src/tools/index.ts` (final 14-tool array)
- Modify: `packages/weather-smart/src/server.ts` (real context wiring)
- Create: `packages/weather-smart/src/__tests__/wire.test.ts`
- Modify: `packages/weather-smart/README.md`

**`tools/index.ts` final:**

```ts
import { geocode } from "./geocode.js";
import { getCurrent } from "./current.js";
import { getForecast, getHourly } from "./forecast.js";
import { getHistorical } from "./historical.js";
import { getAirQuality } from "./air-quality.js";
import { getAlerts } from "./alerts.js";
import { dailyBrief } from "./brief.js";
import { umbrellaCheck } from "./umbrella.js";
import { frostAlert } from "./frost.js";
import { heatAdvisory } from "./heat.js";
import { outdoorWindow } from "./outdoor.js";
import { compareLocations } from "./compare.js";
import { sunsetCheck } from "./sunset.js";
import type { ToolDefinition } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";

export const tools = [
  geocode, getCurrent, getForecast, getHourly,
  getHistorical, getAirQuality, getAlerts,
  dailyBrief, umbrellaCheck, frostAlert, heatAdvisory,
  outdoorWindow, compareLocations, sunsetCheck,
] as unknown as ToolDefinition<unknown, unknown, WeatherContext>[];
```

**`server.ts` final:**

```ts
import { createMcpServer, loadCreds } from "smart-mcp-core";
import { WeatherClient, type WeatherCreds } from "./client.js";
import { tools } from "./tools/index.js";

const creds = loadCreds<WeatherCreds>({
  serviceName: "weather-smart",
  required: [],
  optional: ["WEATHER_DEFAULT_UNITS", "WEATHER_DEFAULT_LOCATION"],
});

const client = new WeatherClient(creds);

const context = {
  client,
  defaults: {
    units: (creds.WEATHER_DEFAULT_UNITS ?? "imperial") as "metric" | "imperial",
    location: creds.WEATHER_DEFAULT_LOCATION,
  },
};

createMcpServer({
  name: "weather-smart",
  version: "0.1.0",
  tools,
  context,
});
```

**`wire.test.ts` (4 tests):**
1. `tools.length === 14`
2. All names unique
3. All names match `^[a-z][a-z_]*$`
4. All descriptions ≤ 15 tokens (split on whitespace)

**`README.md`:** match the email-smart structure — identity, install, env vars (both optional), tool list grouped by category with one-line examples, deferrals, license. ~150 lines.

**Verification:**
1. `npm run build` from repo root → clean across all workspaces
2. `npm test` → all 738 + ~160 = ~900 tests green
3. `npm run typecheck --workspaces` → clean
4. Smoke: `timeout 3 node packages/weather-smart/dist/server.js < /dev/null` → exit 0
5. `./scripts/install-clients.sh weather-smart` → registered in `~/.claude.json`
6. **Live smoke (manual after merge, NOT in test suite):** restart Claude Code, in a separate session call `geocode("Dallas")` → real candidates returned; call `get_current({ location: "Dallas, TX" })` → real weather returned; call `get_alerts({ location: "London" })` → returns `{ alerts: [], note: "alerts only available for US locations" }`.
7. `git tag phase-4-weather-smart-mvp && git push origin main --tags`

**Commit:** `feat(weather): wire tools + README + ship Phase 4 MVP`

**After commit:** `git tag phase-4-weather-smart-mvp` and `git push origin main --tags`.

---

## Test count target

Final monorepo: ~900 tests.

| Workspace | Tests |
|-----------|-------|
| core | 61 |
| vercel-smart | 135 |
| runpod-smart | 191 |
| email-smart | 351 |
| **weather-smart** | **~160** |

Per-task breakdown:
- Task 2: 10 (cache) + 10 (resolver) + 8 (client) = 28
- Task 3: 7
- Task 4: 12
- Task 5: 18
- Task 6: 14
- Task 7: 10
- Task 8: 18
- Task 9: 16
- Task 10: 14
- Task 11: 16
- Task 12: 4 (wire only)
- **Total: ~157**

If a task lands more tests than estimated (edge cases discovered during TDD), document in the commit body. Underrunning by >20% is a quality signal — the spec reviewer should push back.

---

## Phase deferrals (weather-smart-full or later phases)

- Marine forecast (wave height, period, direction)
- Flood forecast
- Pollen (Europe-only in free tier; needs different approach for US)
- Ensemble forecast (uncertainty bands)
- Seasonal forecast
- Climate projections (CMIP6)
- Per-model exposure tools (`gfs_forecast`, `ecmwf_forecast`)
- Batch multi-location tools beyond `compare_locations`
- Saved-locations CRUD (state, not data)
- Push alerts / webhooks
- Persistent cache
- Live integration tests in CI
- Google Weather as a surgical supplement (only if real gap appears, e.g. nowcasting)
- Alaska/Hawaii/PR US-bbox extension for NWS
- Gradient-based scoring in `outdoor_window` (currently boolean pass-rate)

## Post-Phase-4 sequencing

Phase 5 = `map-smart` (POI/places via OSM Nominatim + Overpass, no key). Composes with weather-smart at LLM level. Plan when Phase 4 ships and is live-verified.
