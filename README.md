# smart-mcps

Personal MCP server toolbelt. Six servers in priority order:

1. `vercel-smart` — Vercel ops (MVP shipped, 7 tools, 135 tests — see [packages/vercel-smart/README.md](packages/vercel-smart/README.md))
2. `runpod-smart` — Runpod GPU compute (MVP shipped, 12 tools, 191 tests — see [packages/runpod-smart/README.md](packages/runpod-smart/README.md))
3. `email-smart` — Multi-account Gmail: send + inbox read + reversible bulk modify + drafts + bulk-unsubscribe (full shipped, 27 tools, 351 tests — see [packages/email-smart/README.md](packages/email-smart/README.md))
4. `gsc-smart` — Google Search Console (planned)
5. `ga-smart` — Google Analytics 4 (planned)
6. `hetzner-smart` — Hetzner Cloud (planned)
7. `coolify-smart` — self-hosted Coolify (planned)

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
