# apps-script-smart

Personal Google Apps Script MCP. Manage script projects, content, versions, deployments, and processes, plus a hard-gated `run_function` (`scripts.run`). Multi-account: every tool takes an optional `account` param and resolves per-account OAuth from `~/.santo-agent/oauth/<account>.script.json`; omit it to use the default identity. Reuses the `~/.santo-agent/oauth/` token jar pattern with a dedicated `<account>.script.json` token slot per account. Scopes: `script.projects`, `script.deployments`, `script.processes`, `script.metrics` (plus the runtime scopes a deployed script declares for `scripts.run`). Part of the [smart-mcps](../../README.md) monorepo; built on `smart-mcp-core`.

> No service accounts. The Apps Script API does not work with service-account tokens; every call needs a 3-legged user OAuth token. There is no domain-wide-delegation shortcut.

## Tools (17)

| Tool | What it does |
| --- | --- |
| `create_project` | Create a new script project (standalone, or bound via `parent_id`). |
| `get_project` | Get a project's metadata. |
| `get_content` | Get a project's files + manifest (HEAD or a pinned `version_number`). |
| `update_content` | **Full overwrite** of every file. Confirm-gated. Prefer `push_file`. |
| `push_file` | Safe add/replace of ONE file (read-modify-write; preserves the rest). |
| `get_metrics` | Project execution metrics (`DAILY`/`WEEKLY`). |
| `create_version` | Snapshot HEAD into an immutable version. |
| `list_versions` / `get_version` | Read versions. |
| `create_deployment` | Create a deployment (omit `version_number` to deploy HEAD). |
| `list_deployments` / `get_deployment` | Read deployments. |
| `update_deployment` | Replace a deployment's config. |
| `delete_deployment` | Delete a deployment. Confirm-gated. |
| `list_processes` | List execution processes (all scripts, or one via `script_id`). |
| `deploy_script` | Convenience: `create_version` then `create_deployment` in one call. |
| `run_function` | Gated `scripts.run` — see the warnings below. |

### `update_content` clobbers — use `push_file`

`update_content` is a **full replacement** of the project's `files[]`, not a patch. Any file you omit is **deleted**, and exactly one file must be the `appsscript` JSON manifest. `push_file` is the safe path: it `get_content`s the project, re-includes the manifest and every other file, splices in your one file, then `update_content`s. Use `update_content` directly only when you genuinely intend to rewrite the whole project; it is confirm-gated for that reason.

### `run_function` is arbitrary remote code execution

`run_function` runs a function inside a deployed script **as you**, with whatever Google scopes the script declares (Gmail, Drive, Sheets, etc.). It is:

- **`confirm`-gated.** The preview shows the exact `{deploymentId/scriptId, function, parameters, devMode}` you are about to execute. It must **never** be placed on an auto-approve allowlist.
- **HTTP-200-honest.** `scripts.run` returns HTTP 200 *even when the script throws*; the failure rides in `body.error` (an `ExecutionError` with `errorType`, `errorMessage`, `scriptStackTraceElements`). The client inspects `body.error` **before** `body.response.result` and surfaces the script's stack trace as an error — a 200 is never treated as success on its own.
- Parameters and return values must be **JSON primitives** (string/number/boolean/array/object). Apps Script objects (Document, Blob, Drive File, etc.) cannot cross the boundary.
- Bounded by Apps Script runtime quotas: a **6-minute** max execution time and per-user daily caps.

### Triggers cannot be created via the API

The Apps Script REST API has **no trigger resource** and the manifest cannot declare time-driven triggers. The only programmatic path is to write a function that calls `ScriptApp.newTrigger(...)` (requires the `script.scriptapp` scope) and run it once to install the trigger; it then self-perpetuates. `apps-script-smart` never claims to create triggers.

## `scripts.run` one-time setup (the painful part)

`run_function` needs a heavy, mostly-manual, one-time setup that the API **cannot** do for you. When it is missing you get a real 401/403, which this MCP surfaces as a precise, actionable error pointing back here (not a generic auth failure). Three console surfaces are involved:

**1. Google Cloud Console** (`console.cloud.google.com`)
   - Create or choose a **standard** Google Cloud project. The auto-created "default" project behind every Apps Script project is **insufficient** and will 403.
   - Enable the **Apps Script API** on that project.
   - Create the **OAuth client** (the one minting your token) **in that same project**. The script and the calling app's OAuth client must share **one** standard Cloud project.

**2. The script's Project Settings page** (`https://script.google.com/home/projects/<scriptId>/settings`)
   - Under **Google Cloud Platform (GCP) Project → Change project**, paste the **project number** of the standard project from step 1.
   - Deploy the script as an **API Executable** (Deploy → New deployment → type **API Executable**), or do it via `create_deployment` with an `executionApi` block in the manifest. `scripts.run` requires an API Executable entry point.

**3. The script's Overview page** (Project OAuth Scopes)
   - Read the **complete** list of scopes the script uses. Your calling token must cover **every** one of them — *all* the scopes the script uses, not just the ones the called function touches. Missing any → authorization error.

Then mint a token that requests that full scope union (extend the `apps-script-smart-auth` flow's scope list accordingly), and confirm the caller is authorized on the script (owner or shared with run rights).

> **scriptId vs deploymentId.** In the new Apps Script IDE, the `scripts.run` path segment must be the **API Executable DeploymentID**, not the bare script ID (the classic editor accepts the script ID for a single-API deployment). `run_function` prefers `deployment_id` and falls back to `script_id`.

> **Ownership move kills API Executables.** API Executables stop responding to `scripts.run` if the script project changes ownership to a shared drive or an outside-domain account.

## Per-user API toggle (management methods)

Separately from `scripts.run`, the project-**management** methods (create/get/content/versions/deployments) require each user to turn **ON** the Apps Script API at `https://script.google.com/home/usersettings`. If it is off, those calls 403; this MCP detects that shape and tells you to flip the toggle. (`scripts.run` does **not** need this toggle.)

## Setup

Follows the same OAuth bootstrap as [`calendar-smart`](../calendar-smart/README.md): drop a Google OAuth Desktop client at `~/.santo-agent/oauth/client.json`, enable the Apps Script API on the project, build, then mint a token:

```bash
npm run build --workspace=apps-script-smart
node packages/apps-script-smart/dist/bin/apps-script-smart-auth.js your-account
```

The token is written to `~/.santo-agent/oauth/your-account.script.json` (mode 600).

Multi-account: enroll additional accounts by minting a token for each basename, e.g.

```bash
node packages/apps-script-smart/dist/bin/apps-script-smart-auth.js work-acct
```

writes `~/.santo-agent/oauth/work-acct.script.json`. Any tool then targets it by passing `account: "work-acct"`. Account resolution when `account` is omitted: explicit arg, else the required `APPS_SCRIPT_DEFAULT_IDENTITY` env var. Set it in `~/.config/smart-mcps/.env`.

The auth CLI requests the four management scopes (`script.projects`, `script.deployments`, `script.processes`, `script.metrics`). For `run_function`, re-mint with the additional runtime scopes the target script declares (see the setup section above).
