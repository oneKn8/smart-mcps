# docs-smart

Personal Google Docs MCP — read + create + edit documents on a single account. Reuses the `~/.santo-agent/oauth/` token jar pattern with a dedicated `<account>.docs.json` token slot. Scopes: `https://www.googleapis.com/auth/documents` + `https://www.googleapis.com/auth/drive.file`. Part of the [smart-mcps](../../README.md) monorepo; built on `smart-mcp-core`.

Tools: TBD (skeleton).

> Note: the Docs API rate ceiling is 60 writes/min/user; `fetchJson`'s built-in 429 backoff covers it.

## Setup

Follows the same OAuth bootstrap as [`calendar-smart`](../calendar-smart/README.md): drop a Google OAuth Desktop client at `~/.santo-agent/oauth/client.json`, enable the Google Docs API on the project, build, then mint a token:

```bash
npm run build --workspace=docs-smart
node packages/docs-smart/dist/bin/docs-smart-auth.js your-account
```

The token is written to `~/.santo-agent/oauth/your-account.docs.json` (mode 600). Default account `your-account`; override with `DOCS_DEFAULT_IDENTITY` in `~/.config/smart-mcps/.env`.
