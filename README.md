# smart-mcps

Personal MCP server toolbelt. Six servers in priority order:

1. `vercel-smart` — Vercel ops (MVP shipped, 7 tools, 112 tests — see [packages/vercel-smart/README.md](packages/vercel-smart/README.md))
2. `runpod-smart` — Runpod GPU compute (planned)
3. `gsc-smart` — Google Search Console (planned)
4. `ga-smart` — Google Analytics 4 (planned)
5. `hetzner-smart` — Hetzner Cloud (planned)
6. `coolify-smart` — self-hosted Coolify (planned)

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
