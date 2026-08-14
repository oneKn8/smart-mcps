# smart-mcps

[![CI](https://github.com/oneKn8/smart-mcps/actions/workflows/ci.yml/badge.svg)](https://github.com/oneKn8/smart-mcps/actions/workflows/ci.yml)

Personal MCP server toolbelt: **14 servers**, **416 tools**, **4,039 tests**, all
built on the shared `smart-mcp-core` package (credential loading, HTTP retry,
error taxonomy, destructive-action confirm guard, fuzzy resolvers, stdio server
bootstrap).

This is the toolbelt its author runs daily in Claude Code and Cursor, published
as-is. The tools are workflow-level (`daily_brief`, `cost_audit`,
`inbox_zero_dry_run`, `deploy_server`) rather than thin one-endpoint API
wrappers. Issues and PRs are welcome.

## Requirements

- **Node.js 22 or newer** (`engines` requires `>=22.0.0`; CI runs 22.x and 24.x)
- npm 9+ (npm workspaces)
- Linux or macOS; the helper scripts assume a POSIX shell

## Five-minute quickstart (zero credentials)

`weather-smart` needs no API key, no account, no config file. Start there so
your first run cannot fail on credentials.

```bash
git clone https://github.com/oneKn8/smart-mcps.git
cd smart-mcps
npm install
npm run build
```

Smoke-boot the server:

```bash
timeout 3 node packages/weather-smart/dist/server.js < /dev/null; echo $?
```

Exit code `0` with no output means the server boots cleanly over MCP stdio.
(The same pattern works for any server here; servers that need credentials
exit immediately with an `AuthError` naming the missing variable instead.)

Register it in your MCP client ([see below](#registering-in-mcp-clients)),
restart the client, and ask for a weather brief or a forecast. `drive-smart`
(local-disk scanner) also runs with zero credentials.

## Servers

| Server | Tools | Tests | Scope |
|--------|------:|------:|-------|
| `hetzner-smart` | 71 | 549 | Hetzner Cloud: servers, volumes, networks, firewalls, load balancers, floating + primary IPs, certificates, images, catalog + pricing, async action polling, deploy/cost/cleanup shortcuts |
| `slack-smart` | 62 | 457 | Slack: messaging, threads, search, channels, canvases, files, bookmarks, pins, reactions, scheduled sends, presence/DND/status |
| `email-smart` | 53 | 473 | Multi-account Gmail: send, inbox read, bulk modify, labels, drafts, unsubscribe, plus filters, settings (vacation/forwarding/imap/pop/signatures/delegates), and permanent delete |
| `calendar-smart` | 44 | 601 | Google Calendar API v3 |
| `runpod-smart` | 43 | 516 | Runpod full surface: pods, templates, endpoints, network volumes, registry auth, serverless inference, GPU pricing + balance (GraphQL) |
| `vercel-smart` | 27 | 284 | Vercel: projects, deployments, env vars, domains, redirect + canonical audits, daily status |
| `gdrive-smart` | 22 | 171 | Google Drive API v3: folders, move/copy/rename, trash lifecycle, upload/download/export, sharing |
| `docs-smart` | 18 | 157 | Google Docs API v1: read/create/edit, styles, tables, markdown renderer |
| `apps-script-smart` | 17 | 97 | Apps Script API: projects, versions, deployments, processes, gated `run_function` |
| `tasks-smart` | 16 | 105 | Google Tasks API v1 |
| `sheets-smart` | 16 | 103 | Google Sheets v4 + Drive v3 |
| `weather-smart` | 14 | 250 | Open-Meteo + NWS: forecasts, alerts, air quality, activity windows. No API key |
| `drive-smart` | 7 | 135 | Local-disk scanner (filesystem + OS-mounted Drive), network-mount-safe: scan, roots, search, largest, duplicates, stats, plan_cleanup. No API key |
| `flow-smart` | 6 | 57 | Cross-app orchestrator: Gmail -> Tasks, Task -> Calendar, review/brief/digest Docs, inbox watcher |
| **Total** | **416** | **3,955** | 14 MCP servers |
| `smart-mcp-core` | — | 84 | Shared infra (auth, http, errors, confirm, server bootstrap) |
| **Monorepo** | **416** | **4,039** | 14 servers + core |

Each package's own `README.md` documents its individual tools and setup.

Note: `drive-smart` is a LOCAL-DISK scanner (no Google API); the Google Drive
API manager is the separate `gdrive-smart`.

## Credentials

Credentials never live in MCP client config. Every server resolves them
through `smart-mcp-core`'s `loadCreds`, in this order:

1. `process.env`
2. the shared env file `~/.config/smart-mcps/.env`
3. a per-service JSON file (`~/.config/<server>.json`, `~/.config/codex/<server>.json`, or `~/.<server>.json`)

If a required variable is missing after all three, the server exits at startup
with `AuthError: Missing required credentials for <server>: <VAR>`. Seeing
that line in your MCP client's log always means the same thing: add the named
variable to one of the three locations above.

### Tier 0 — no credentials

`weather-smart` and `drive-smart`. Build and register, done.

### Tier 1 — one API key

Create the shared env file once:

```bash
mkdir -p ~/.config/smart-mcps && chmod 700 ~/.config/smart-mcps
touch ~/.config/smart-mcps/.env && chmod 600 ~/.config/smart-mcps/.env
```

Then append a line for each server you want:

```bash
HETZNER_API_TOKEN=...      # hetzner-smart: Hetzner Cloud project API token
VERCEL_TOKEN=...           # vercel-smart: account token (optional: VERCEL_TEAM_ID)
RUNPOD_API_KEY=...         # runpod-smart (optional: RUNPOD_DEFAULT_GPU)
SLACK_USER_TOKEN=xoxp-...  # slack-smart: user token (optional: SLACK_BOT_TOKEN)
```

Verify with the smoke-boot pattern, e.g.
`timeout 3 node packages/hetzner-smart/dist/server.js < /dev/null; echo $?`
prints `0` once the token resolves.

### Tier 2 — Google OAuth

`calendar-smart`, `tasks-smart`, `gdrive-smart`, `docs-smart`, `sheets-smart`,
`apps-script-smart`, `email-smart`, and `flow-smart` authenticate against a
Google Cloud OAuth client you create once, then mint per-server token files
with the bundled auth CLIs.

Full walkthrough, including the consent-screen test-user step most first-time
setups miss: [docs/setup-google-oauth.md](docs/setup-google-oauth.md).

## Registering in MCP clients

### The install script

```bash
./scripts/install-clients.sh                # register every built server
./scripts/install-clients.sh weather-smart  # register one server
```

What it actually does:

- discovers every `packages/*/dist/server.js` (run `npm run build` first)
- backs up each config it touches to `~/.config/smart-mcps-backups/<timestamp>/`
- writes `{"command": "node", "args": ["<absolute path to dist/server.js>"]}`
  entries into `~/.claude.json` (Claude Code) and `~/.cursor/mcp.json` (Cursor),
  skipping either file if it does not exist
- prints a TOML snippet for you to paste into `~/.codex/config.toml` (Codex is
  never modified automatically)
- injects no env vars and stores no secrets; it is idempotent and safe to re-run

Requires `python3` on PATH (used for the JSON edits).

### Manual registration

If you would rather not run a shell script, add the entry yourself. Claude
Code (`~/.claude.json`) and Cursor (`~/.cursor/mcp.json`) use the same shape:

```json
{
  "mcpServers": {
    "weather-smart": {
      "command": "node",
      "args": ["/absolute/path/to/smart-mcps/packages/weather-smart/dist/server.js"]
    }
  }
}
```

Restart the client afterwards; the new tools appear in its MCP tool list.

## Build and test

```bash
npm install
npm run build      # tsc for every workspace, core first
npm test           # vitest across all workspaces (~4k tests, a few minutes)
npm run typecheck
```

`npm audit` currently reports advisories in dev-only tooling (vitest 2.x's
esbuild, eslint's brace-expansion) and in transitive deps of the MCP SDK's
optional HTTP transports (hono, express). None are reachable from the stdio
servers this repo ships; dependency bumps are on the maintenance list.

## Planned

- `gsc-smart` — Google Search Console
- `coolify-smart` — self-hosted Coolify

## Contributing

Bug reports with the smoke-boot output are the fastest to act on (the issue
template asks for it). PRs welcome; the conventions are: TypeScript strict
ESM, one workspace per server, tools defined via `smart-mcp-core`'s
`defineTool`, destructive tools gated behind `confirm: true`, vitest with msw
for HTTP mocking, and Conventional Commits.
