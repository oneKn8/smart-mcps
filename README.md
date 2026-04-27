# Smart-MCPs Monorepo

Personal smart-MCP toolbelt for Shifat. Six MCP servers in priority order:

1. `vercel-smart` — Vercel ops
2. `runpod-smart` — Runpod GPU compute
3. `gsc-smart` — Google Search Console
4. `ga-smart` — Google Analytics 4
5. `hetzner-smart` — Hetzner Cloud
6. `coolify-smart` — self-hosted Coolify

See `docs/plans/2026-04-27-shifat-smart-mcps-design.md` (in the acme backend repo at /home/oneknight/projects/acme/remic_product/aeo-geo/acme) for the full design.

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
