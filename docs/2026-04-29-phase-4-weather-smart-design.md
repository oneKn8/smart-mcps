# Phase 4 — weather-smart Design

Personal multi-source weather MCP. Read-only. Zero required credentials.

## Goal

Ship a 14-tool weather MCP that wraps Open-Meteo + NWS with a smart-shortcut layer focused on Santo's actual usage: daily briefs, umbrella checks, frost/heat alerts, sunset planning, multi-location compares, and activity-window scoring (hike, run, picnic, drone, bike). No API key, no billing account, no setup beyond the shared `~/.config/smart-mcps/.env`.

## Acceptance criteria

- 14 tools registered, all returning explicit `type Output = {...}` slim shapes.
- Boots clean under MCP stdio with no env vars set (smoke check exits 0).
- All 14 tools work with location input as either `{ lat, lng }` or `{ location: string }` and fall back to `WEATHER_DEFAULT_LOCATION` when both are missing.
- Imperial units when `WEATHER_DEFAULT_UNITS` unset.
- In-memory TTL cache hits before second identical request inside the TTL window.
- NWS alerts return `{ alerts: [], note: "alerts only available for US locations" }` for non-US lat/lng.
- ~160 unit tests, all green. No live integration tests in unit suite (live smoke after merge).
- Registered via `scripts/install-clients.sh` auto-discovery.
- Tag `phase-4-weather-smart-mvp` pushed.

## Upstream choice

**Open-Meteo (primary).** No key. ECMWF IFS at 9km global resolution, GFS, ICON, JMA. 16-day hourly forecast. ERA5 reanalysis back to 1940. Free air quality, geocoding. 10k calls/day non-commercial soft cap.

**NWS (alerts only).** No key. CAP v1.2 alerts for US locations. Required `User-Agent` header.

**Why not Google Weather:** breaks zero-key ethos (GCP project + billing required), 30-day history vs ERA5's 1940-present, 10-day forecast vs Open-Meteo's 16-day, doubles maintenance for marginal cross-source gain. Documented as a future surgical add (e.g. `get_nowcast` only) if a real gap appears.

**Why not OpenWeatherMap / AccuWeather / WeatherAPI:** all keyed, all weaker on free tier, no architectural pattern fit.

Endpoints used:

| Purpose | URL |
|---------|-----|
| Forecast | `https://api.open-meteo.com/v1/forecast` |
| Geocoding | `https://geocoding-api.open-meteo.com/v1/search` |
| Air quality | `https://air-quality-api.open-meteo.com/v1/air-quality` |
| Historical (ERA5) | `https://archive-api.open-meteo.com/v1/archive` |
| NWS alerts | `https://api.weather.gov/alerts/active` |

User-Agent for NWS: `smart-mcps weather-smart (capcat774@gmail.com)`.

## Credential model

Zero required. `loadCreds<WeatherCreds>` is still called for consistency with the suite pattern, with both vars in `optional` only:

```ts
type WeatherCreds = {
  WEATHER_DEFAULT_UNITS?: "metric" | "imperial";
  WEATHER_DEFAULT_LOCATION?: string;
};
```

Resolution order: `process.env` → `~/.config/smart-mcps/.env` → fallback (`imperial` units, no default location). When `WEATHER_DEFAULT_LOCATION` unset and a tool is invoked without `lat`/`lng`/`location`, throw `Error("location required: pass {lat,lng} or {location} or set WEATHER_DEFAULT_LOCATION")`.

## Tool surface (14 tools)

### Raw data (6)

| # | Tool | Input | Output |
|---|------|-------|--------|
| 1 | `get_current` | `{ lat?, lng?, location?, units? }` | `{ location, observed_at, temp, feels_like, conditions, wind, humidity, pressure }` |
| 2 | `get_forecast` | `{ lat?, lng?, location?, days?: 1-16, units? }` | `{ location, daily: [{date, high, low, sunrise, sunset, precip_chance, precip_total, wind_max, conditions}] }` |
| 3 | `get_hourly` | `{ lat?, lng?, location?, hours?: 1-48, units? }` | `{ location, hourly: [{time, temp, conditions, precip_chance, precip, wind, cloud_cover}] }` |
| 4 | `get_historical` | `{ lat?, lng?, location?, start_date, end_date, units? }` | `{ location, daily: [{date, high, low, precip_total, wind_max}] }` |
| 5 | `get_air_quality` | `{ lat?, lng?, location? }` | `{ location, observed_at, aqi_us, pm2_5, pm10, ozone, no2, so2, co, pollen?: {tree, grass, weed} }` |
| 6 | `get_alerts` | `{ lat?, lng?, location? }` | `{ location, alerts: [{event, severity, urgency, certainty, headline, expires, areas}] }` (US) or `{ alerts: [], note }` (non-US) |

### Resolution (1)

| # | Tool | Input | Output |
|---|------|-------|--------|
| 7 | `geocode` | `{ query: string, limit?: 1-10 }` | `{ matches: [{name, lat, lng, country, admin1, admin2, timezone, elevation, population}] }` (top 5 default) |

### Smart shortcuts (7)

| # | Tool | Purpose |
|---|------|---------|
| 8 | `daily_brief` | Current + today + tomorrow digest. Returns prose `brief` + structured fields. |
| 9 | `umbrella_check` | Next 12-24h precip scan. Returns `recommend: bool`, peak window, total expected precip. |
| 10 | `frost_alert` | Next 72h sub-threshold temp scan. Default threshold 32°F (0°C). Returns nights at risk. |
| 11 | `heat_advisory` | Next 7d high-temp scan. Default threshold 95°F (35°C). Returns days at risk. |
| 12 | `outdoor_window` | Activity-aware window scan over next 7d hourly. Activity presets: `hike`, `run`, `picnic`, `drone`, `bike`, `general`. Each preset hardcodes wind/precip/temp/UV thresholds. Returns top 2-3 windows with score + conditions. |
| 13 | `compare_locations` | Same forecast slice across 2-5 locations. Returns per-location summary + `best_for: { sun, dry, mild }`. |
| 14 | `sunset_check` | Sunset time + conditions in the hour around sunset. Returns `viewing_quality: "great"\|"good"\|"poor"` based on cloud cover, precip chance, visibility, wind. |

All shortcut outputs include a `summary: string` field for direct LLM passthrough.

### Activity presets (`outdoor_window`)

| Preset | Max wind | Max precip prob | Temp range | Other |
|--------|----------|-----------------|------------|-------|
| `hike` | 20 mph | 30% | 50-85°F | UV index < 8 in summer |
| `run` | 15 mph | 20% | 40-75°F | — |
| `picnic` | 12 mph | 15% | 65-85°F | cloud cover < 60% |
| `drone` | 10 mph | 5% | 40-95°F | visibility > 5mi, no precip |
| `bike` | 18 mph | 25% | 45-85°F | — |
| `general` | 25 mph | 40% | 35-95°F | — |

Scoring: weighted sum of normalized distances from preset thresholds. Higher = better. Tied windows ordered by start time.

### Sunset viewing quality (`sunset_check`)

- **great**: cloud cover 30-70% (some clouds for color), precip chance < 10%, visibility > 6mi, wind < 15 mph
- **good**: cloud cover 0-90%, precip chance < 25%, visibility > 4mi
- **poor**: anything else

## Architecture

```
packages/weather-smart/
  src/
    client.ts                  # WeatherClient — openMeteo* + nws* methods, all read-only
    cache.ts                   # TTL Map cache, exported for tests
    context.ts                 # WeatherContext { client, defaults: { units, location } }
    server.ts                  # createMcpServer<WeatherContext>
    tools/
      index.ts                 # 14-tool array, cast to ToolDefinition<unknown,unknown,WeatherContext>[]
      current.ts               # get_current
      forecast.ts              # get_forecast, get_hourly
      historical.ts            # get_historical
      air-quality.ts           # get_air_quality
      alerts.ts                # get_alerts
      geocode.ts               # geocode
      brief.ts                 # daily_brief
      umbrella.ts              # umbrella_check
      frost.ts                 # frost_alert
      heat.ts                  # heat_advisory
      outdoor.ts               # outdoor_window + activity presets
      compare.ts               # compare_locations
      sunset.ts                # sunset_check
      null-helpers.ts          # nullableString/Number/Boolean
      location-resolver.ts     # accept {lat,lng}|{location} → {lat,lng,name,timezone}
      activity-presets.ts      # ACTIVITY_PRESETS const + scoring fn
    __tests__/
      client.test.ts
      cache.test.ts
      location-resolver.test.ts
      wire.test.ts
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
```

## Cache strategy

In-memory `Map<string, { value: unknown; expiresAt: number }>`. Key = method name + JSON-stringified args. Per-resource TTL:

| Resource | TTL |
|----------|-----|
| current | 5 min |
| hourly | 30 min |
| daily forecast | 1 hr |
| historical | infinite (immutable) |
| alerts | 0 (never cache) |
| air_quality | 30 min |
| geocode | 24 hr |

Smart shortcuts call cached methods, so they get cache reuse for free. No persistent cache, no Redis.

## Location resolution

`location-resolver.ts` exposes `resolveLocation(input, defaults, geocodeFn) → Promise<{lat, lng, name, timezone}>`:

1. If `input.lat` and `input.lng` present, use them. Set `name = "${lat},${lng}"`, fetch timezone from forecast call.
2. Else if `input.location` present, geocode top match. Return `{lat, lng, name: "<n>, <admin1>, <country>", timezone}`.
3. Else if `defaults.location` set, geocode it.
4. Else throw.

The chosen `name` is included in every tool's slim output so the LLM can spot wrong-Springfield mismatches without re-prompting.

## Units handling

Per-tool optional `units: z.enum(["metric","imperial"]).optional()`. Resolution: `input.units ?? defaults.units ?? "imperial"`. Pass through to Open-Meteo as `temperature_unit`, `windspeed_unit`, `precipitation_unit` query params — no manual conversion. Output strings always include unit suffix (`"72F"`, `"15mph"`, `"0.3in"`) for LLM clarity.

## Error handling

- Open-Meteo 4xx → `Error("Open-Meteo: <message>")` (no auth class needed since no key).
- NWS 4xx → same.
- Network timeouts → bubble through `fetchJson`'s 3-attempt retry on 429/5xx.
- Missing location and no default → `Error("location required: ...")`.
- Geocode no match → `Error("no location match for '<query>'")`.
- Non-US lat/lng to NWS → short-circuit with `{ alerts: [], note: ... }` before HTTP call (NWS returns empty array anyway, but skipping the call is cleaner).

## Test target

~160 tests:

- `client.test.ts` — ~40 tests, msw 2.6, one describe per upstream method, body-mapping + error mapping + retry behavior.
- `cache.test.ts` — ~10 tests, fake timers, TTL eviction, key uniqueness, no eviction for infinite TTL.
- `location-resolver.test.ts` — ~10 tests, lat/lng passthrough, geocode fallback, defaults fallback, throw when nothing.
- `tools/__tests__/<topic>.test.ts` — ~95 tests, ~6-8 per tool, exact-key deep equality on slim outputs, error paths.
- `wire.test.ts` — 4 tests (length=14, unique names, snake_case, descriptions ≤15 tokens).

Test isolation: every test that asserts default-units fallback or default-location fallback MUST override `process.env.HOME` and unset `WEATHER_DEFAULT_UNITS`/`WEATHER_DEFAULT_LOCATION` in `beforeEach`. `loadCreds` falls through to the real `~/.config/smart-mcps/.env` otherwise.

## Conventions for the implementer subagent

- TypeScript 5.7 ESM, Node 22+. Relative imports end in `.js`.
- `inputSchema as unknown as z.ZodType<Input>` cast required when schema has `.optional().default(...)`.
- Conventional Commits: `feat(weather):`, `test(weather):`, `fix(weather):`, etc.
- No emojis, no AI/Claude/Anthropic mentions, no co-author lines.
- Tool descriptions ≤15 tokens.
- One client class. Constructor takes optional `creds` for tests; falls back to `loadCreds`.
- For Open-Meteo list responses that come back as bare arrays inside fields, normalize at client boundary.
- `null-helpers.ts` shared across mappers — don't duplicate inline.

## Task plan (12 tasks, mirrors phases 1-3.5)

1. **Scaffold** — workspace dir, package.json, tsconfig (composite, references core), vitest.config, base smoke target. Empty `src/server.ts` boots clean. Atomic commit.
2. **Client + cache + resolver + geocode method** — `WeatherClient` class with `geocode()` method, `cache.ts` with TTL Map, `location-resolver.ts`. Tests: client.test.ts (geocode body-mapping + error), cache.test.ts (TTL semantics), location-resolver.test.ts (3 input forms).
3. **`geocode` tool** — `tools/geocode.ts` + tests. Wire into `tools/index.ts` skeleton.
4. **Open-Meteo forecast methods** — `getCurrent()`, `getHourly()`, `getDaily()` on client. Tests for body-mapping, units passthrough, location resolution.
5. **`get_current`, `get_forecast`, `get_hourly` tools** — three tools. Tests for slim shape, units default fallback, location default fallback.
6. **`get_historical` + `get_air_quality`** — client methods + tools + tests. Historical uses ERA5 archive endpoint. Air quality uses separate base URL.
7. **NWS client method + `get_alerts` tool** — `nwsAlertsActive()` method with required `User-Agent`. Non-US short-circuit logic. Tests including non-US passthrough.
8. **`daily_brief` + `umbrella_check`** — composed shortcuts. Both call cached `getCurrent`/`getHourly`/`getDaily`. Brief returns prose summary. Umbrella returns recommendation + peak window. Tests for composition, edge cases (no rain at all, multi-peak).
9. **`frost_alert` + `heat_advisory`** — temperature-threshold scans. Configurable threshold per call. Default 32°F / 95°F. Tests for threshold edge cases, no-risk path, multi-day risk.
10. **`outdoor_window`** — `activity-presets.ts` with `ACTIVITY_PRESETS` const + scoring fn. Tool scans hourly forecast over `days?: 1-7`. Returns top 3 windows. Tests: each preset, scoring tie-breaks, no-acceptable-window path.
11. **`compare_locations` + `sunset_check`** — compare takes 2-5 locations array, runs forecast for each, computes `best_for`. Sunset uses daily for sunset time, hourly for conditions in surrounding hour. Viewing quality logic. Tests for each.
12. **Wire + README + smoke + tag** — finalize `tools/index.ts` (14 tools), write `README.md` (matches email-smart pattern: identity, install, tools list with examples, env vars, deferrals), run `npm run build && npm test` clean across monorepo, update root `scripts/install-clients.sh` (no change needed — auto-discovery), live smoke (geocode + get_current at minimum), tag `phase-4-weather-smart-mvp`.

Each task: TDD red → green → refactor → atomic commit. Subagent flow: implementer → spec reviewer → code quality reviewer → mark complete.

## Phase deferrals (weather-smart-full or later)

- Marine forecast (wave height, period, direction)
- Flood forecast
- Ensemble forecast (uncertainty bands)
- Seasonal forecast
- Climate projections (CMIP6)
- Per-model exposure tools (`gfs_forecast`, `ecmwf_forecast`)
- Batch multi-location tools (covered by `compare_locations` for typical use)
- Saved-locations CRUD (state, not data)
- Push alerts / webhooks
- Persistent cache
- Live integration tests
- Google Weather as a surgical supplement (only if real gap appears, e.g. nowcasting)

## Roadmap update

Insert `map-smart` at slot 5 of the suite roadmap. Updated order:

1. vercel-smart (shipped)
2. runpod-smart (shipped)
3. email-smart (shipped)
4. weather-smart (this phase)
5. **map-smart** — OSM Nominatim + Overpass, no key. POI search (`nearby_pois` by activity), forward + reverse geocoding, route distance. Integrates with weather-smart at LLM level (LLM calls `nearby_pois` then `weather-smart.daily_brief` on the chosen POI's lat/lng).
6. gsc-smart
7. ga-smart
8. hetzner-smart
9. coolify-smart

## Out of scope for Phase 4

- map-smart implementation (separate phase)
- Cross-MCP joining helpers (LLM does this)
- Weather alert subscriptions / push
- Tomorrow.io / OWM / AccuWeather supplements
