# smart-mcps

Personal MCP server toolbelt. Six servers shipped, all built on the shared
`smart-mcp-core` package (auth, http, errors, confirm, fuzzy, server bootstrap).

## Shipped

| Server | Tools | Scope |
|--------|-------|-------|
| `calendar-smart` | 44 | Google Calendar API v3 |
| `slack-smart` | 40 | Slack messaging, search, channels |
| `email-smart` | 30 | Multi-account Gmail: send, inbox read, reversible bulk modify, labels, drafts, bulk-unsubscribe |
| `weather-smart` | 14 | Open-Meteo + NWS: forecasts, alerts, air quality, activity windows |
| `runpod-smart` | 12 | Runpod GPU compute |
| `vercel-smart` | 7 | Vercel ops |

Each package's own `README.md` documents its tools and tests.

## In progress

- `drive-smart` — Google Drive (in development, not yet released)

## Planned

- `gsc-smart` — Google Search Console
- `ga-smart` — Google Analytics 4
- `hetzner-smart` — Hetzner Cloud
- `coolify-smart` — self-hosted Coolify

## Build all
```
npm install
npm run build
npm test
```

## Install in MCP clients
```
./scripts/install-clients.sh
```
