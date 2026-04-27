# smart-mcps

Personal MCP server toolbelt. Six servers in priority order:

1. `vercel-smart` — Vercel ops
2. `runpod-smart` — Runpod GPU compute
3. `gsc-smart` — Google Search Console
4. `ga-smart` — Google Analytics 4
5. `hetzner-smart` — Hetzner Cloud
6. `coolify-smart` — self-hosted Coolify

All built on top of the shared `smart-mcp-core` package (auth, http, errors, confirm, fuzzy, server bootstrap).

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
