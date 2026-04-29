# weather-smart

MCP server for weather forecasts, alerts, and quick decision shortcuts. Wraps [Open-Meteo](https://open-meteo.com/) for forecasts/history/air-quality and the [NWS API](https://www.weather.gov/documentation/services-web-api) for US alerts. No API key required. Part of the [smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

## Tools (14)

### Raw data (6, read-only)

| Name | Summary |
|---|---|
| `get_current` | Current weather conditions for a location. |
| `get_forecast` | Daily forecast for 1-16 days. |
| `get_hourly` | Hourly forecast for 1-48 hours. |
| `get_historical` | Past daily weather observations (ERA5). |
| `get_air_quality` | Air quality index, PM, and pollutants. |
| `get_alerts` | Active weather alerts (US lower-48 only). |

### Resolution (1, read-only)

| Name | Summary |
|---|---|
| `geocode` | Resolve location name to candidates. |

### Smart shortcuts (7, read-only)

| Name | Summary |
|---|---|
| `daily_brief` | Quick brief: now, today, tomorrow. |
| `umbrella_check` | Should I bring an umbrella? Next 6-48h. |
| `frost_alert` | Alert for sub-freezing temps in next 24-168h. |
| `heat_advisory` | Alert for high-heat windows next 1-7d. |
| `outdoor_window` | Best outdoor windows in next 1-7 days. |
| `compare_locations` | Compare weather across 2-5 locations. |
| `sunset_check` | Sunset time and viewing conditions. |

All tools are read-only. No `confirm`/`dry_run` flags — Open-Meteo and NWS are public read APIs.

## Setup

No required env vars. Optional defaults can live in `~/.config/smart-mcps/.env`:

```bash
WEATHER_DEFAULT_UNITS=imperial   # or "metric" — default: imperial
WEATHER_DEFAULT_LOCATION="Dallas, TX"   # default: none (must pass location per call)
```

When `WEATHER_DEFAULT_LOCATION` is set, tools that accept a location argument will use it as the fallback when caller omits both `lat`/`lng` and `location`.

## Install in MCP clients

Build the workspace, then run the multi-client installer from the repo root:

```bash
npm install
npm run build
./scripts/install-clients.sh weather-smart
```

The installer registers `weather-smart` in Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), and prints a Codex config snippet for `~/.codex/config.toml`. It auto-discovers any `packages/*/dist/server.js`.

## Build & test

From repo root:

```bash
npm install
npm run build --workspace=weather-smart
npm test --workspace=weather-smart
```

Smoke test (no creds needed):

```bash
node packages/weather-smart/dist/server.js < /dev/null
```

The server runs over stdio and waits for MCP protocol messages. With `</dev/null` it should boot, find no input, and exit cleanly.

## Examples

`daily_brief({ location: "Dallas, TX" })`:

```json
{
  "location": "Dallas, TX, United States",
  "brief": "72F, partly cloudy. High 81F / low 64F today. Tomorrow: 78F / 60F, light rain.",
  "now": { "temp_f": 72, "condition": "partly cloudy", "wind_mph": 8 },
  "today": { "high_f": 81, "low_f": 64, "precip_chance": 10 },
  "tomorrow": { "high_f": 78, "low_f": 60, "precip_chance": 55 }
}
```

`umbrella_check({ location: "Seattle, WA", hours: 24 })`:

```json
{
  "recommend": true,
  "reason": "0.18 in expected over next 24h; peak chance 78% at 4pm.",
  "peak_hour": "2026-04-29T16:00",
  "total_precip_in": 0.18
}
```

`outdoor_window({ location: "Austin, TX", activity: "hike", days: 3 })`:

```json
{
  "windows": [
    { "start": "2026-04-30T08:00", "end": "2026-04-30T11:00", "score": 0.92, "summary": "65-72F, clear, light wind" },
    { "start": "2026-05-01T07:00", "end": "2026-05-01T10:00", "score": 0.88, "summary": "62-70F, sunny" }
  ]
}
```

`get_alerts({ location: "London" })`:

```json
{
  "alerts": [],
  "note": "NWS alerts cover US lower-48 only. Non-US locations return an empty list."
}
```

## Architecture

- **Open-Meteo** for current, forecast, hourly, historical, air quality, geocoding. Free, no key, no rate limit auth.
- **NWS** for US alerts (lat/lng → `/alerts/active`). Non-US locations return an empty list with a note.
- **In-memory TTL cache** (default 10 min) on raw API responses to absorb repeated calls within a session.
- **Single shared** `~/.config/smart-mcps/.env` for the two optional vars; no per-MCP config jar.
- **Imperial default** to match US user expectation; `WEATHER_DEFAULT_UNITS=metric` flips every output.

## Deferrals

Out of MVP scope, reconsider when needed:

- Marine / surf forecasts (Open-Meteo Marine API)
- Hurricane / tropical cyclone tracking (NHC integration)
- Severe storm probability heatmaps
- Historical trends > 1 day (yearly aggregates, climate normals)
- Push notifications for alert triggering (would need a daemon, not stateless MCP)
- Cache invalidation by city — currently TTL only
- Per-user unit preferences (single global default for now)
- Non-US alert sources (Met Office UK, ECMWF, etc.)

## Live verification

After `./scripts/install-clients.sh weather-smart` and a Claude Code restart, call:

```
geocode({ name: "Dallas" })
```

Expected: a `candidates` array with at least one match and `lat`/`lng` numbers. Confirms the upstream Open-Meteo geocoding endpoint is reachable and the MCP is wired correctly.

## Notes

- **No auth, but rate limits exist.** Open-Meteo's free tier allows ~10k requests/day. The TTL cache smooths bursty session usage; production-heavy callers should add an HTTP-level cache.
- **NWS alerts US-only.** `get_alerts` returns an empty list with a `note` field for non-US locations rather than erroring.
- **Imperial vs metric.** All numeric fields in tool outputs respect the resolved units (per-call `units` argument wins; falls back to `WEATHER_DEFAULT_UNITS`; ultimately `"imperial"`).
- **Coordinate precision.** Geocode returns lat/lng to 4 decimals (~11m). Tools accept either `{ lat, lng }` directly or `{ location: "Dallas, TX" }` for upstream resolution.
