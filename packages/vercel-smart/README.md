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
| `list_env` | read | List env vars (slim, no values; `decrypt=true` gated by `VERCEL_SMART_ALLOW_REVEAL`) | `{ "project": "alpha-site" }` |
| `reveal_env` | read (sensitive) | Reveal one env var's plaintext value; gated by `VERCEL_SMART_ALLOW_REVEAL` | `{ "project": "alpha-site", "id": "env_x" }` |
| `set_env` | DESTRUCTIVE | Create/upsert an env var (preview redacts value) | `{ "project": "alpha-site", "key": "API_KEY", "value": "...", "target": ["production"], "confirm": true }` |
| `edit_env` | DESTRUCTIVE | Edit an existing env var by id | `{ "project": "alpha-site", "id": "env_x", "value": "...", "confirm": true }` |
| `delete_env` | DESTRUCTIVE | Delete an env var by id | `{ "project": "alpha-site", "id": "env_x", "confirm": true }` |
| `list_deployments` | read | List recent deployments | `{ "project": "alpha-site", "limit": 20 }` |
| `get_deployment` | read | Get one deployment (requires `project` to scope) | `{ "project": "alpha-site", "id": "dpl_x" }` |
| `deployment_logs` | read | Fetch deployment build/runtime events (log text is untrusted) | `{ "project": "alpha-site", "id": "dpl_x" }` |
| `redeploy` | DESTRUCTIVE | Redeploy a deployment; `target` defaults to `preview` | `{ "project": "alpha-site", "id": "dpl_x", "confirm": true }` |
| `promote_deployment` | DESTRUCTIVE (prod) | Promote a deployment to production; `VERCEL_SMART_ALLOW_PROD` required | `{ "project": "alpha-site", "id": "dpl_x", "confirm": true }` |
| `cancel_deployment` | DESTRUCTIVE | Cancel an in-progress deployment | `{ "project": "alpha-site", "id": "dpl_x", "confirm": true }` |
| `delete_deployment` | DESTRUCTIVE | Delete a deployment (irreversible) | `{ "project": "alpha-site", "id": "dpl_x", "confirm": true }` |
| `add_domain` | DESTRUCTIVE | Attach a domain to a project (optional redirect) | `{ "project": "alpha-site", "name": "alpha.com", "confirm": true }` |
| `verify_domain` | write (idempotent) | Re-check a domain's DNS verification | `{ "project": "alpha-site", "domain": "alpha.com" }` |
| `remove_domain` | DESTRUCTIVE | Unlink a domain from a project (irreversible) | `{ "project": "alpha-site", "domain": "alpha.com", "confirm": true }` |
| `list_teams` | read | List teams the token can access | `{}` |
| `update_project_settings` | DESTRUCTIVE | Update build/framework settings (no secrets) | `{ "project": "alpha-site", "buildCommand": "npm run build", "confirm": true }` |
| `pause_project` | DESTRUCTIVE (prod) | Pause a project; `VERCEL_SMART_ALLOW_PROD` required | `{ "project": "alpha-site", "confirm": true }` |
| `unpause_project` | DESTRUCTIVE (prod) | Unpause a project; `VERCEL_SMART_ALLOW_PROD` required | `{ "project": "alpha-site" }` |
| `delete_project` | DESTRUCTIVE (prod) | Delete a project (irreversible); `VERCEL_SMART_ALLOW_PROD` required | `{ "project": "alpha-site", "confirm": true }` |

`flip_canonical` requires `confirm: true`. It performs the apex/www switch as ordered PATCHes, attempts rollback on partial failure, and verifies via HTTP probe with up to 3 retries (CDN propagation lag).

### Confirm gate

Every DESTRUCTIVE tool requires `confirm: true`. Called without it, the tool returns a redacted preview (secret values are never shown) and performs no write. `confirm: true` is a speed-bump, not the primary guard for production-affecting actions — those additionally require the env flags below, which the model cannot set.

### Safety env flags

These gate the highest-risk operations. They are read from the server process environment, so only the human running the MCP server can set them; the model cannot.

| Flag | Value to enable | Gates |
|---|---|---|
| `VERCEL_SMART_ALLOW_PROD` | `1` | Production-affecting writes: `redeploy` with `target: "production"`, `promote_deployment`, `pause_project`, `unpause_project`, `delete_project`. Without it these throw before any network call, even with `confirm: true`. |
| `VERCEL_SMART_ALLOWED_PROJECTS` | comma-separated project names/ids | Optional allowlist. When set, prod-gated actions are permitted only for the named projects; any other project is refused even if `VERCEL_SMART_ALLOW_PROD=1`. |
| `VERCEL_SMART_ALLOW_REVEAL` | `1` | Reading plaintext secret values: `reveal_env` and `list_env` with `decrypt: true`. Without it, `list_env` returns a slim projection (key/target/type/id, never the value) and reveal is refused before any network call. |

Writes resolve the project strictly: a bare project name that matches projects in more than one team throws an ambiguity error listing the candidates, so a mutation never silently hits the wrong team. Deployment-scoped ops (`get_deployment`, `deployment_logs`, `cancel_deployment`, `delete_deployment`) require a `project` param to derive the correct team scope.

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
