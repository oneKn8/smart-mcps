# smart-mcps

Personal MCP server toolbelt. **13 servers**, **278 tools**, **2,742 tests** — all
built on the shared `smart-mcp-core` package (auth, http, errors, confirm, fuzzy,
server bootstrap).

## Shipped

| Server | Tools | Tests | Scope |
|--------|------:|------:|-------|
| `calendar-smart` | 44 | 601 | Google Calendar API v3 |
| `email-smart` | 53 | 473 | Multi-account Gmail: send, inbox read, bulk modify, labels, drafts, unsubscribe, plus filters, settings (vacation/forwarding/imap/pop/signatures/delegates), and permanent delete |
| `slack-smart` | 46 | 310 | Slack messaging, search, channels, canvases |
| `gdrive-smart` | 22 | 170 | Google Drive API v3: folders, move/copy/rename, trash lifecycle, upload/download/export, sharing |
| `docs-smart` | 18 | 157 | Google Docs API v1: read/create/edit, styles, tables, markdown renderer |
| `apps-script-smart` | 17 | 93 | Apps Script API: projects, versions, deployments, processes, gated `run_function` |
| `tasks-smart` | 16 | 105 | Google Tasks API v1 |
| `sheets-smart` | 16 | 103 | Google Sheets v4 + Drive v3 |
| `weather-smart` | 14 | 250 | Open-Meteo + NWS: forecasts, alerts, air quality, activity windows |
| `runpod-smart` | 12 | 191 | Runpod GPU compute |
| `vercel-smart` | 7 | 135 | Vercel ops |
| `drive-smart` | 7 | 13 | Local-disk scanner (filesystem + OS-mounted Drive): largest, duplicates, stats, cleanup |
| `flow-smart` | 6 | 57 | Cross-app orchestrator: Gmail -> Tasks, Task -> Calendar, review/brief/digest Docs, inbox watcher |
| **Total** | **278** | **2,658** | 13 MCP servers |
| `smart-mcp-core` | — | 84 | Shared infra (auth, http, errors, confirm, server bootstrap) |
| **Monorepo** | **278** | **2,742** | 13 servers + core |

Each package's own `README.md` documents its individual tools and setup.

Note: `drive-smart` is a LOCAL-DISK scanner (no Google API); the Google Drive API
manager is the separate `gdrive-smart`.

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

Google servers authenticate via the `~/.santo-agent/oauth/` token jar (one
scoped token file per server). See each server's README for its scope + auth CLI.
