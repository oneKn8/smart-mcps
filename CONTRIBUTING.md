# Contributing

Thanks for considering a contribution. This is a personal toolbelt maintained by one person and hardened by daily use; PRs are welcome as long as they keep that bar.

## Dev setup

Node 22+ is required.

```bash
git clone https://github.com/oneKn8/smart-mcps.git
cd smart-mcps
npm install
npm run build        # tsc + chmod for every workspace
npm test             # vitest across all workspaces
npm run typecheck    # tsc --noEmit per workspace
npm test --workspace weather-smart   # a single workspace
```

Smoke check for any server:

```bash
timeout 3 node packages/<name>-smart/dist/server.js < /dev/null
```

Exit 0 means the server boots cleanly under MCP stdio. Servers that need credentials fail fast at startup with an `AuthError` naming the missing variable.

## Layout

One workspace per MCP server under `packages/`, all built on the shared `packages/core` (`smart-mcp-core`: auth resolution, HTTP with retry and error mapping, destructive-action gate, server bootstrap).

```
packages/<name>-smart/src/
  client.ts            # API client: auth, retry, error mapping
  context.ts           # context shape + buildContext()
  server.ts            # createMcpServer entrypoint
  tools/               # tool definitions + per-topic tests
  __tests__/           # client and wire tests
```

## Conventions

- TypeScript 5.7 ESM with NodeNext resolution: relative imports end in `.js`. Strict settings are inherited from `tsconfig.base.json`.
- Tool inputs are zod schemas; outputs are explicit types and tools strip upstream extras.
- Destructive tools take `confirm: boolean` (default false) and call `guardDestructive` with a preview before any side effect. Batch destructive tools prefer `dry_run: true` as the default. This is non-negotiable: these servers run against real accounts.
- Credentials resolve from process env, then `~/.config/smart-mcps/.env`, then per-service config. Never hardcode credentials or personal defaults; never add env values to client configs.
- Tests are required for every tool. Client tests mock HTTP with msw; tool tests stub the client with `vi.fn()`. Fixtures use neutral names (`alpha-*`, `beta-*`, `tpl_minimal`), never real accounts, teams, or companies.
- Conventional Commits with the package as scope: `feat(weather-smart): ...`, `fix(core): ...`.
- No emojis in code, docs, or commits.

## Pull requests

- One server or one concern per PR.
- `npm test` and `npm run typecheck` must pass across the monorepo; CI runs both on Node 22 and 24.
- New tools: update the package README tool table and add tests in the same PR.
- New servers: open an issue first so the scope can be agreed before you build.

## Reporting bugs

Use the issue template. The smoke-boot output and your Node version make most reports actionable on the first message.
