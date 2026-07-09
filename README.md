# smart-mcps

[![CI](https://github.com/oneKn8/smart-mcps/actions/workflows/ci.yml/badge.svg)](https://github.com/oneKn8/smart-mcps/actions/workflows/ci.yml)

Personal MCP server toolbelt. **14 servers**, **380 tools**, **3,599 tests** — all
built on the shared `smart-mcp-core` package (auth, http, errors, confirm, fuzzy,
server bootstrap).

## Shipped

| Server | Tools | Tests | Scope |
|--------|------:|------:|-------|
| `hetzner-smart` | 71 | 533 | Hetzner Cloud: servers, volumes, networks, firewalls, load balancers, floating + primary IPs, certificates, images, catalog + pricing, async action polling, deploy/cost/cleanup shortcuts |
| `calendar-smart` | 44 | 601 | Google Calendar API v3 |
| `email-smart` | 53 | 473 | Multi-account Gmail: send, inbox read, bulk modify, labels, drafts, unsubscribe, plus filters, settings (vacation/forwarding/imap/pop/signatures/delegates), and permanent delete |
| `slack-smart` | 46 | 310 | Slack messaging, search, channels, canvases |
| `runpod-smart` | 43 | 515 | Runpod full surface: pods, templates, endpoints, network volumes, registry auth, serverless inference, GPU pricing + balance (GraphQL) |
| `gdrive-smart` | 22 | 170 | Google Drive API v3: folders, move/copy/rename, trash lifecycle, upload/download/export, sharing |
| `docs-smart` | 18 | 157 | Google Docs API v1: read/create/edit, styles, tables, markdown renderer |
| `apps-script-smart` | 17 | 93 | Apps Script API: projects, versions, deployments, processes, gated `run_function` |
| `tasks-smart` | 16 | 105 | Google Tasks API v1 |
| `sheets-smart` | 16 | 103 | Google Sheets v4 + Drive v3 |
| `weather-smart` | 14 | 250 | Open-Meteo + NWS: forecasts, alerts, air quality, activity windows |
| `vercel-smart` | 7 | 135 | Vercel ops |
| `drive-smart` | 7 | 13 | Local-disk scanner (filesystem + OS-mounted Drive): largest, duplicates, stats, cleanup |
| `flow-smart` | 6 | 57 | Cross-app orchestrator: Gmail -> Tasks, Task -> Calendar, review/brief/digest Docs, inbox watcher |
| **Total** | **380** | **3,515** | 14 MCP servers |
| `smart-mcp-core` | — | 84 | Shared infra (auth, http, errors, confirm, server bootstrap) |
| **Monorepo** | **380** | **3,599** | 14 servers + core |

Each package's own `README.md` documents its individual tools and setup.

Note: `drive-smart` is a LOCAL-DISK scanner (no Google API); the Google Drive API
manager is the separate `gdrive-smart`.

## Planned

- `gsc-smart` — Google Search Console
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
