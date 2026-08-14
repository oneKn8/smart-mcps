# tasks-smart

Personal Google Tasks MCP — read + write task lists and tasks on a single account. Reuses the `~/.santo-agent/oauth/` token jar pattern with a dedicated `<account>.tasks.json` token slot. Scope: `https://www.googleapis.com/auth/tasks`. Part of the [smart-mcps](../../README.md) monorepo; built on `smart-mcp-core`.

Tools: TBD (skeleton).

## Setup

Follows the same OAuth bootstrap as [`calendar-smart`](../calendar-smart/README.md): drop a Google OAuth Desktop client at `~/.santo-agent/oauth/client.json`, enable the Google Tasks API on the project, build, then mint a token:

```bash
npm run build --workspace=tasks-smart
node packages/tasks-smart/dist/bin/tasks-smart-auth.js your-account
```

The token is written to `~/.santo-agent/oauth/your-account.tasks.json` (mode 600). Requires `TASKS_DEFAULT_IDENTITY` in `~/.config/smart-mcps/.env`.
