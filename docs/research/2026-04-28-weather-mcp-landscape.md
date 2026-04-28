# Weather MCP Landscape (April 2026)

Research for `weather-smart` design. Goal: choose an API + tool surface for a personal-dev MCP optimized for zero-friction setup and LLM-useful outputs.

## 1. Existing Weather MCP Servers

The ecosystem is crowded but only a handful are well-built. The clear pattern: most servers picked Open-Meteo (no key, global) or stitched NOAA+Open-Meteo together; a smaller cluster uses paid/keyed APIs (AccuWeather, OpenWeatherMap).

| MCP | Repo | Source | Lang | Tools | Notes |
|-----|------|--------|------|-------|-------|
| weather-mcp/weather-mcp | https://github.com/weather-mcp/weather-mcp | NOAA + Open-Meteo + NWPS/USGS + NIFC + RainViewer + Blitzortung | TypeScript | 16 (12 weather + 4 saved-locations CRUD) | No keys. Auto-routes US to NOAA, intl to Open-Meteo. LRU cache. Tool presets (basic/standard/full). The reference implementation. |
| @dangahagan/weather-mcp | npm `@dangahagan/weather-mcp` | NOAA (US) + Open-Meteo (intl) | TypeScript | ~12 | No keys. Listed in official MCP registry. Same hybrid pattern as above, smaller surface. |
| cmer81/open-meteo-mcp | https://github.com/cmer81/open-meteo-mcp | Open-Meteo only | TypeScript (Node 22+) | 15+ | No keys. Exposes per-model tools (`gfs_forecast`, `ecmwf_forecast`, `dwd_icon_forecast`, `jma_forecast`, etc.) plus flood, seasonal, climate projections. Most "complete" Open-Meteo wrapper. Zod schemas. |
| TimLukaHorstmann/mcp-weather | https://github.com/TimLukaHorstmann/mcp-weather | AccuWeather | TypeScript | 2 (`weather-get_hourly`, `weather-get_daily`) | Free AccuWeather key required (50 calls/day on free dev tier — tight). Tiny surface. Deliberately minimal. |
| jezweb/weather-mcp-server | https://github.com/jezweb/weather-mcp-server | OpenWeatherMap | Python | 5 (`get_current_weather`, `get_forecast`, `search_location`, `get_weather_by_zip`, `get_air_quality`) | Key required. 10-min TTL cache. Sensible mid-size surface. |
| isdaniel/mcp_weather_server | https://github.com/isdaniel/mcp_weather_server | Open-Meteo | Python | ~3 (current, forecast, geocode) | No keys. Minimal. Very popular on awesome-mcp-servers list. |
| akaramanapp/weather-mcp-server | https://github.com/akaramanapp/weather-mcp-server | NWS only | TypeScript | 2 (`get-alerts`, `get-forecast`) | No keys. The canonical NWS quickstart from MCP docs — US-only. |
| rossshannon/Weekly-Weather-mcp | github.com/rossshannon/Weekly-Weather-mcp | OpenWeatherMap One Call | TypeScript | 1 (7-day forecast) | Key required. Single-purpose. |
| chuk-mcp-open-meteo | PyPI `chuk-mcp-open-meteo` | Open-Meteo | Python | 12 (6 single-loc + 6 batch variants) | No keys. Notable for batch tools (multi-location queries). |

**Takeaway:** the "right" answer for a no-friction personal MCP is already converged on — Open-Meteo (or hybrid NOAA+Open-Meteo). Only paid/keyed MCPs exist when the author specifically wanted AccuWeather/OWM features (hyperlocal, polished icons, push alerts).

## 2. Weather API Choice

| API | Free tier | Key required | Geocoding included | Hourly | Historical | Alerts | Verdict |
|-----|-----------|--------------|--------------------|--------|------------|--------|---------|
| **Open-Meteo** | <10k calls/day, 5k/hr, 600/min (non-commercial) | **No** | Yes (free, multilingual, separate endpoint) | Yes (15-day, 1-hr resolution) | Yes (ERA5, 1940-present) | No native global alerts (use NWS for US) | **Winner for personal MCP.** |
| NWS / weather.gov | Unlimited, fair-use | No | **No** (must geocode separately) | Yes (~7 day) | Limited | Yes (CAP v1.2, US only) | Best alerts + best US accuracy, but US-only and no geocoding. Pair with Open-Meteo. |
| OpenWeatherMap | 1k calls/day, 60/min | Yes | Yes (separate endpoint) | Yes (5-day, 3-hr in free) | Paid only | Yes (One Call paid tier) | Popular but the free tier nerfs hourly granularity to 3-hr blocks and historical is paid. |
| WeatherAPI.com | ~1M calls/month free | Yes | Yes | Yes (14-day) | Yes (back to 2010) | Yes | Generous free, but key required = friction. |
| Tomorrow.io | 500 calls/day | Yes | Yes | Yes | Limited | Yes | 80+ data layers, hyperlocal, but 500/day is too tight. |
| Visual Crossing | 1000 records/day | Yes | Yes | Yes | Best-in-class historical | Yes | Strong if historical-heavy, but key required. |
| AccuWeather | 50 calls/day (free dev) | Yes | Yes | Yes (12-hr) | Paid | Yes | Free tier is too tight for daily use. |

**Opinionated pick: Open-Meteo as the primary, optionally pair with NWS for US alerts.** The "no API key" property is non-negotiable for a personal smart-mcps install — it preserves the zero-friction pattern (`~/.config/smart-mcps/.env` stays untouched for this MCP). Open-Meteo also has an official TypeScript SDK (`open-meteo/typescript`), 16-day hourly forecasts, ECMWF IFS at 9km resolution (since Oct 2025), built-in geocoding, free historical back to 1940, and free air quality + marine + flood endpoints. The single weakness is no global weather alerts, which is solved by adding an `alerts` tool that hits NWS (also no key) and short-circuits with `{ alerts: [], note: "alerts only available for US locations" }` for non-US lat/lng.

## 3. Tool Surface Patterns

What actually shows up across the field, ranked by frequency:

1. **`get_current` / `get_current_weather`** — universal
2. **`get_forecast`** (daily, 7-16 days) — universal
3. **`get_hourly` / hourly forecast** — common, sometimes folded into `get_forecast`
4. **`geocode` / `search_location`** — present in every MCP that needs lat/lng (i.e. most of them)
5. **`get_alerts`** — common; US-only when source is NWS
6. **`get_air_quality`** — frequent (Open-Meteo and OWM both expose it free)
7. **`get_historical`** — present in Open-Meteo-based MCPs; paid in OWM
8. **`get_marine`** — niche but present in cmer81/open-meteo-mcp and weather-mcp/weather-mcp
9. **Saved-locations CRUD** — only weather-mcp/weather-mcp does this; debatable whether worth the surface area
10. **Per-model tools** (`gfs_forecast`, `ecmwf_forecast`, etc.) — only cmer81/open-meteo-mcp; arguably overkill for an LLM consumer

**Sweet spot for a personal MCP: 6-8 tools.** `get_current`, `get_forecast`, `get_hourly`, `geocode`, `get_alerts`, `get_air_quality`, plus 1-2 smart shortcuts. Skip per-model exposure, marine, lightning, river, wildfire unless you have a specific use case — they balloon context for LLM tool selection without proportional value.

## 4. Geocoding / Location Resolution

Three patterns observed:

1. **Push burden to caller** (NWS-only MCPs like akaramanapp): the tool input is `lat`, `lng`. The LLM has to resolve locations itself. Bad UX — the LLM often hallucinates coordinates.
2. **Separate `geocode` tool** (most Open-Meteo MCPs): explicit two-step; LLM calls `geocode("Brooklyn")` then feeds the lat/lng into `get_forecast`. Clean and inspectable.
3. **Inline location resolution** (weather-mcp/weather-mcp): forecast tools accept either `{ lat, lng }` OR `{ location: "Brooklyn, NY" }` and resolve internally. Best UX for the LLM but doubles the slim shape.

**Recommendation:** option 3 for primary tools (`get_forecast`, `get_current`, `get_hourly`) plus a standalone `geocode` for explicit resolution and disambiguation. Open-Meteo's geocoding API is free, multilingual, and returns rich metadata (timezone, elevation, population, admin1/admin2 — which is critical for disambiguating "Springfield"). Use it as a first-class fallback inside the forecast handlers.

## 5. Smart Shortcuts Worth Borrowing

Most existing MCPs just dump raw forecast JSON. The few that do digest tools point at the real opportunity:

- WeatherChatAI (not an MCP, but referenced) shows the canonical pattern: "30% chance in afternoon rising to 60% at night → recommend umbrella later in day." That's a **digest tool**, not raw data.
- Home Assistant LLM blueprints expose `weather_brief` style prompts that pre-format forecasts into "today: 72F, light rain after 5pm, bring jacket."
- weather-mcp/weather-mcp adds a `check_service_status` tool — utility, not digest.
- No widely-shipped MCP has a true "should I bring an umbrella" tool. **Gap in the market.**

**Recommended smart shortcuts for `weather-smart`** (mirrors `vercel-smart`'s `daily_status` and `runpod-smart`'s `cost_audit` pattern):

- `daily_brief` — current + today's hourly digest + tomorrow summary in one call. LLM-formatted prose strings, not raw fields. The default "what's the weather like" tool.
- `umbrella_check` — looks at next 12-24h precipitation probability + intensity, returns `{ recommend_umbrella: bool, reason, peak_hour, peak_pop }`.
- `outdoor_window` — given an activity (drone, run, picnic), scans next 7 days hourly and returns the best 2-3 windows by wind/precip/temp constraints. Configurable thresholds.
- `frost_alert` — checks next 72h for `min_temp < 2C` (or user-configurable), returns nights at risk. Useful for plant/pipe protection.

These are the LLM-differentiated tools — anyone can call a forecast endpoint, but framing the answer ("yes umbrella, peaks 4-6pm at 70%") is what a smart MCP adds.

## 6. Units / Formatting

Three approaches:

- **Per-call param** (TimLukaHorstmann, jezweb): `units: "metric" | "imperial"` on every tool. Most flexible, most verbose.
- **Env var default** (some Python MCPs): `WEATHER_UNITS=metric` env, no per-call override.
- **Hardcoded** (some minimal MCPs): always metric or always imperial. Bad.

**Recommendation:** per-call optional param `units: z.enum(["metric", "imperial"]).optional()` plus an optional `WEATHER_DEFAULT_UNITS` env var (parallel to `RUNPOD_DEFAULT_GPU` in runpod-smart). When neither is set, default to **imperial** since the user is US-based. Open-Meteo natively supports `temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch` query params, so no manual conversion needed. Always include the unit suffix in formatted strings ("72F", "15mph", "0.3in") for LLM clarity.

## 7. Common Pitfalls

- **Rate limits:** Open-Meteo's <10k/day non-commercial is generous but multi-variable or multi-day calls weight more than 1. Smart shortcuts that bundle current+hourly+daily can eat 3-5x. Mitigate with simple in-memory TTL cache (15 min for current, 1 hr for forecast) — every reference MCP does this.
- **Timezone:** always pass `timezone=auto` to Open-Meteo. Never rely on UTC math for "today" — the LLM's "today" is the user's local day. Surface IANA timezone in every forecast response so the LLM can format relative times correctly.
- **Hourly vs daily confusion:** if a tool returns both, label clearly (`hourly: [...]`, `daily: [...]`). Don't merge into one timeline.
- **Alerts inconsistency:** NWS CAP is rich (severity, urgency, certainty, areas). OpenWeatherMap alerts are flat. Keep the slim shape minimal and consistent: `{ event, severity, headline, expires, areas }`. Drop NWS's nested `properties` blob.
- **Geocoding ambiguity:** "Springfield" returns 30+ matches. Always return top 5 with admin1/admin2/country populated so the LLM can disambiguate without re-prompting the user.
- **Caching invalidation:** weather data ages fast. Current conditions: 5-10 min TTL. Hourly forecast: 30-60 min. Daily forecast: 1-3 hr. Historical: cache forever (immutable). Alerts: never cache (safety-critical).
- **Key vs no-key trade-off:** OWM's 5-day-only and 3-hr-block free tier is genuinely insufficient for a useful MCP. Don't compromise — Open-Meteo's 16-day hourly is strictly better for free.

## Recommendation for smart-mcps

**API:** Open-Meteo as primary, NWS as a free supplement for US alerts only. **No API keys, no `.env` entry needed.** Optional `WEATHER_DEFAULT_UNITS` and `WEATHER_DEFAULT_LOCATION` env vars in the shared `~/.config/smart-mcps/.env`.

**SDK:** use the official `open-meteo/typescript` client OR raw `fetchJson` from `smart-mcp-core` (consistent with existing pattern; vercel-smart and runpod-smart both hand-roll, no SDK dependency). Recommend hand-roll — the SDK uses FlatBuffers and adds binary deserialization complexity that's overkill for the slim-shape pattern.

**Tool surface (8 tools, ≤15-token descriptions):**

1. `get_current` — current conditions for a location
2. `get_forecast` — daily forecast, 1-16 days
3. `get_hourly` — hourly forecast, 1-48 hours
4. `geocode` — resolve location name to candidates
5. `get_alerts` — NWS alerts (US only); empty + note for non-US
6. `get_air_quality` — AQI, PM2.5, PM10, ozone, pollen
7. `daily_brief` — formatted current + today + tomorrow digest
8. `umbrella_check` — precipitation digest with recommendation

**Phase 4 deferrals:** `outdoor_window`, `frost_alert`, historical data, marine, ensemble/seasonal/climate models, saved-locations CRUD, per-model exposure, batch multi-location tools. Ship the 8 above as the MVP; the smart shortcuts are what justify the "smart" suffix.

**Test count target (mirrors vercel-smart 135 / runpod-smart 191):** ~120 tests. Lower than runpod-smart because no destructive ops and no confirm-required guards — just read-only forecast/digest tools.

**Sources:**
- https://github.com/weather-mcp/weather-mcp
- https://github.com/cmer81/open-meteo-mcp
- https://github.com/TimLukaHorstmann/mcp-weather
- https://github.com/jezweb/weather-mcp-server
- https://github.com/akaramanapp/weather-mcp-server
- https://github.com/isdaniel/mcp_weather_server
- https://www.npmjs.com/package/@dangahagan/weather-mcp
- https://github.com/punkpeye/awesome-mcp-servers
- https://open-meteo.com/en/terms
- https://open-meteo.com/en/features
- https://open-meteo.com/en/docs/geocoding-api
- https://open-meteo.com/en/docs/air-quality-api
- https://github.com/open-meteo/typescript
- https://www.weather.gov/documentation
- https://weather-gov.github.io/api/general-faqs
- https://www.weather.gov/documentation/services-web-alerts
- https://openweathermap.org/api
- https://www.tomorrow.io/weather-api/
- https://www.visualcrossing.com/resources/blog/best-weather-api-for-2025/
- https://www.meteomatics.com/en/weather-api/best-weather-apis/
- https://github.com/mattflo/WeatherChatAI
