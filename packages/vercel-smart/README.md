# vercel-smart

MCP server for Vercel ops. Part of the [smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

## Tools

| Name | Type | Summary | Sample input |
|---|---|---|---|
| `list_projects` | read | List Vercel projects | `{ "limit": 50 }` |
| `list_domains` | read | List domains attached to a project | `{ "project": "alpha-site" }` |
| `smart_project` | read | Resolve a partial project name | `{ "query": "alph" }` |
| `canonical_audit` | read | Classify apex/www canonical state | `{ "project": "alpha-site" }` |
| `redirects_audit` | read | List every domain with a configured redirect | `{ "project": "alpha-site" }` |
| `daily_status` | read | 24h deploy + project health snapshot | `{ "hours": 24 }` |
| `flip_canonical` | DESTRUCTIVE | Switch apex<->www canonical redirect | `{ "project": "alpha-site", "target": "www", "confirm": true }` |

`flip_canonical` requires `confirm: true`. It performs the apex/www switch as ordered PATCHes, attempts rollback on partial failure, and verifies via HTTP probe with up to 3 retries (CDN propagation lag).

## Setup

Required env var:

```bash
export VERCEL_TOKEN=<your_token>
```

Optional (only if you operate inside a Vercel team rather than your personal account):

```bash
export VERCEL_TEAM_ID=<your_team_id>
```

To create a token: Vercel dashboard -> Settings -> Tokens -> Create. Scope it to "Full Account", or narrower with at least Projects + Domains + Deployments read+write.

To find your team id:

```bash
curl -H "Authorization: Bearer $VERCEL_TOKEN" https://api.vercel.com/v2/teams
```

## Install in MCP clients

Build the workspace, then run the multi-client installer from the repo root:

```bash
npm install
npm run build
./scripts/install-clients.sh vercel-smart
```

The installer registers `vercel-smart` in Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), and prints a Codex config snippet for `~/.codex/config.toml`. It auto-discovers any `packages/*/dist/server.js`, so newly built MCPs in this monorepo are picked up without script changes.

> Note: the installer wires `command: "node"` + the absolute path to `dist/server.js`. It does NOT inject env vars. You must export `VERCEL_TOKEN` (and optionally `VERCEL_TEAM_ID`) in the shell that launches your MCP client, or hand-edit the registered server entry to add an `env` block.

## Build & test

From repo root:

```bash
npm install
npm run build --workspace=vercel-smart
npm test --workspace=vercel-smart
```

Or against the whole monorepo:

```bash
npm run build
npm test
```

Smoke test (requires real `VERCEL_TOKEN`):

```bash
export VERCEL_TOKEN=...
node packages/vercel-smart/dist/server.js
```

The server runs over stdio and waits for MCP protocol messages.
