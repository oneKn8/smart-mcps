# apps-script-smart

Personal Google Apps Script MCP — manage script projects, content, versions, deployments, and processes, plus a hard-gated `run_function` (`scripts.run`) on a single account. Reuses the `~/.santo-agent/oauth/` token jar pattern with a dedicated `<account>.script.json` token slot. Scopes: `script.projects`, `script.deployments`, `script.processes`, `script.metrics` (plus the runtime scopes a deployed script declares for `scripts.run`). Part of the [smart-mcps](../../README.md) monorepo; built on `smart-mcp-core`.

Tools: TBD (skeleton).

> Warnings (baked into the tools as they land): `update_content` is a full overwrite of every file (use the safe `push_file` read-modify-write path); `run_function` is arbitrary remote code execution, is `confirm`-gated, and never belongs on an auto-approve list; triggers cannot be installed via the API.

## Setup

Follows the same OAuth bootstrap as [`calendar-smart`](../calendar-smart/README.md): drop a Google OAuth Desktop client at `~/.santo-agent/oauth/client.json`, enable the Apps Script API on the project, build, then mint a token:

```bash
npm run build --workspace=apps-script-smart
node packages/apps-script-smart/dist/bin/apps-script-smart-auth.js your-account
```

The token is written to `~/.santo-agent/oauth/your-account.script.json` (mode 600). Default account `your-account`; override with `APPS_SCRIPT_DEFAULT_IDENTITY` in `~/.config/smart-mcps/.env`.
