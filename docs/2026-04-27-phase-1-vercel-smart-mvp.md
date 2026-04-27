# vercel-smart MVP (Phase 1) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task in this session. Each task gets a fresh implementer subagent + spec reviewer + code quality reviewer.

**Goal:** Ship the "Killer 7" vercel-smart tools — `list_projects`, `list_domains`, `smart_project`, `canonical_audit`, `redirects_audit`, `daily_status`, `flip_canonical` — as a fully working stdio MCP server with all unit tests green.

**Architecture:** New workspace `packages/vercel-smart/`. Imports `smart-mcp-core` for auth/http/errors/confirm/fuzzy/server. One `client.ts` wrapping the Vercel REST API (`v9/projects`, `v9/projects/{id}/domains`, `v6/deployments`). Tools split into thin files (`projects.ts`, `domains.ts`, `canonical.ts`, `smart.ts`). Tests use `msw` to mock Vercel API responses.

**Tech Stack:** Same as Phase 0 — TypeScript 5.7 ESM, Node 22+, vitest 2.1, msw 2.6, zod 3.24, `@modelcontextprotocol/sdk` 1.12.

**Vercel API endpoints (locked in by research, 2026-04-27):**
- `GET https://api.vercel.com/v9/projects?limit=N&teamId=X` → `{ projects: [...], pagination: { count, next } }`
- `GET https://api.vercel.com/v9/projects/{idOrName}?teamId=X` → project object
- `GET https://api.vercel.com/v9/projects/{idOrName}/domains?teamId=X` → `{ domains: [...] }`
- `GET https://api.vercel.com/v9/projects/{idOrName}/domains/{domain}?teamId=X` → single domain (`{ name, apexName, projectId, redirect, redirectStatusCode, verified, ... }`)
- `PATCH https://api.vercel.com/v9/projects/{idOrName}/domains/{domain}?teamId=X` body `{ redirect: string|null, redirectStatusCode: 301|302|307|308|null, gitBranch?: string|null }` → updated domain
- `GET https://api.vercel.com/v6/deployments?projectId=P&limit=N&teamId=X` → `{ deployments: [...] }` (`state`, `createdAt`, `target`, `meta`, `url`)
- Auth: `Authorization: Bearer ${VERCEL_TOKEN}`. Optional `VERCEL_TEAM_ID` injected as `teamId` query param on every call.
- Full OpenAPI: https://openapi.vercel.sh/ (reference for Phase 2 expansion; not needed here)

**Notes baked into plan:**
- Vercel default redirect status is **308** (permanent). `flip_canonical` sets `redirectStatusCode: 308` unless caller overrides.
- A "canonical apex" means: apex domain (`example.com`) has `redirect: null`, www (`www.example.com`) has `redirect: "example.com"`. Reverse for "canonical www".
- `flip_canonical` is **destructive** — must use `guardDestructive`. Includes a verify step that does an unauthenticated `fetch()` to `https://<apex>` + `https://<www>` and confirms HTTP status + `location` header match the expected target. CDN propagation may lag — retry verify up to 3× with 5s backoff.

---

## Conventions for the implementer subagent

1. **Strict TDD.** Red → green → refactor → commit. Never write impl before the failing test.
2. **Commit after every task.** Conventional commits (`feat(vercel-smart): ...`, `test(vercel-smart): ...`).
3. **No fixtures referencing real customer projects.** Use `alpha-site`, `beta-site` etc. (matching the established convention from Phase 0).
4. **Network is forbidden in tests.** Use `msw` to mock every Vercel call. The test for `flip_canonical`'s verify step mocks `fetch` to fake the post-flip redirect responses.
5. **Tool descriptions are terse (≤ 15 tokens).** Token budget matters across MCP clients.
6. **Read-only tools (`list_*`, `*_audit`, `daily_status`, `smart_project`) do NOT take `confirm`.** Only `flip_canonical` does.
7. **All API errors flow through `smart-mcp-core`'s `fetchJson` and `toMcpResult`** — do not invent new error paths.

---

## Task list

### Task 1: Scaffold `packages/vercel-smart` workspace

**Files:**
- Create `/home/oneknight/projects/tools/smart-mcps/packages/vercel-smart/package.json`
- Create `/home/oneknight/projects/tools/smart-mcps/packages/vercel-smart/tsconfig.json`
- Create `/home/oneknight/projects/tools/smart-mcps/packages/vercel-smart/vitest.config.ts`
- Create `/home/oneknight/projects/tools/smart-mcps/packages/vercel-smart/src/server.ts` (placeholder — `console.error("not yet")`)
- Create `/home/oneknight/projects/tools/smart-mcps/packages/vercel-smart/src/tools/index.ts` (`export const tools = []`)
- Create `/home/oneknight/projects/tools/smart-mcps/packages/vercel-smart/README.md` (one-paragraph summary + tool list placeholder)

**Step 1: Write package.json**
```json
{
  "name": "vercel-smart",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "bin": { "vercel-smart": "dist/server.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --ext .ts",
    "smoke": "node dist/server.js < /dev/null || true"
  },
  "dependencies": {
    "smart-mcp-core": "*",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0",
    "msw": "^2.6.0",
    "@types/node": "^22.0.0"
  }
}
```

**Step 2: Mirror tsconfig from `packages/core/tsconfig.json`** but `composite: true` and `references: [{ path: "../core" }]`.

**Step 3: Run `npm install` from repo root.** Expected: workspace symlink for `smart-mcp-core` resolves; install completes clean.

**Step 4: Run `npm run build --workspace=vercel-smart`.** Expected: passes (placeholder server compiles).

**Step 5: Commit**
```
chore(vercel-smart): scaffold workspace
```

---

### Task 2: Implement `VercelClient` class with `listProjects` (TDD)

**Files:**
- Create test: `/home/oneknight/projects/tools/smart-mcps/packages/vercel-smart/src/__tests__/client.test.ts`
- Create source: `/home/oneknight/projects/tools/smart-mcps/packages/vercel-smart/src/client.ts`

**Step 1: Write failing test (`client.test.ts`)** — covers:
- Constructor reads `VERCEL_TOKEN` + optional `VERCEL_TEAM_ID` via `loadCreds`.
- `listProjects({ limit: 20 })` calls `GET https://api.vercel.com/v9/projects?limit=20&teamId=...` with bearer header.
- Returns `{ projects: [...], pagination: {...} }` parsed.
- 401 from upstream → `AuthError` ("Vercel rejected the token. Check VERCEL_TOKEN.")
- 429 → retried, then `RateLimitError` after exhausted.
- Use `msw` `setupServer` in `beforeAll`/`afterAll`.

**Step 2: Run** `npm test --workspace=vercel-smart` — expect FAIL (no client.ts).

**Step 3: Write `client.ts`** — `class VercelClient { constructor(creds); listProjects(opts) }`. Builds URL with `teamId` query if cred present. Uses `fetchJson` from `smart-mcp-core` (it already maps 401/429/5xx to taxonomy).

**Step 4: Run tests** — expect PASS.

**Step 5: Commit** `feat(vercel-smart): VercelClient.listProjects with auth + retry`

---

### Task 3: Tool `list_projects` (TDD)

**Files:**
- Test: `/home/oneknight/projects/tools/smart-mcps/packages/vercel-smart/src/tools/__tests__/projects.test.ts`
- Source: `/home/oneknight/projects/tools/smart-mcps/packages/vercel-smart/src/tools/projects.ts`

**Tool spec:**
- name: `list_projects`
- desc: `"List Vercel projects."`
- input: `{ limit?: number (default 50, max 100) }` (zod)
- output: `{ projects: Array<{ id, name, framework, updatedAt, latestDeploymentUrl?: string }>, count: number }`
- read-only, no confirm

**Step 1: Write failing test** — calls tool with mocked client, asserts shape + that `latestDeployments[0].url` is mapped to `latestDeploymentUrl`.

**Step 2: Run** — FAIL.

**Step 3: Write `projects.ts`** — uses `defineTool` from `smart-mcp-core`. Receives `client: VercelClient` from context.

**Step 4: Run** — PASS.

**Step 5: Commit** `feat(vercel-smart): list_projects tool`

---

### Task 4: `VercelClient.listProjectDomains` + tool `list_domains` (TDD)

**Files:**
- Extend `client.test.ts` and `client.ts`
- Test: `.../tools/__tests__/domains.test.ts`
- Source: `.../tools/domains.ts`

**Client method:** `listProjectDomains(idOrName: string)` → `{ domains: [...] }`. 404 → `NotFoundError("Project not found: <name>")`.

**Tool spec:**
- name: `list_domains`
- desc: `"List domains attached to a Vercel project."`
- input: `{ project: string }` (no fuzzy here — exact id/name as Vercel accepts both)
- output: `{ domains: Array<{ name, apexName, redirect: string|null, redirectStatusCode: number|null, verified: boolean }> }`

**Step 1-5:** Standard TDD cycle, same pattern as Task 3.

**Commit:** `feat(vercel-smart): list_domains tool + client.listProjectDomains`

---

### Task 5: Tool `smart_project` (TDD — fuzzy resolver)

**Files:**
- Test: `.../tools/__tests__/smart.test.ts`
- Source: `.../tools/smart.ts`

**Tool spec:**
- name: `smart_project`
- desc: `"Resolve a partial project name to a single Vercel project."`
- input: `{ query: string }`
- behaviour:
  1. Calls `client.listProjects({ limit: 100 })` (paginate if needed — Phase 2)
  2. Calls `resolveOne(query, projects, p => p.name, { threshold: 0.9 })` from core
  3. On match → returns `{ id, name, framework }`
  4. On ambiguous → propagates `AmbiguousMatchError` (core formats it)
  5. On empty → propagates `NotFoundError`

**Step 1-5:** Standard TDD. Test the three branches: exact match, fuzzy match, ambiguous, not-found.

**Commit:** `feat(vercel-smart): smart_project fuzzy resolver`

---

### Task 6: Tool `canonical_audit` (TDD — pure read)

**Files:**
- Test: `.../tools/__tests__/canonical.test.ts`
- Source: `.../tools/canonical.ts`

**Tool spec:**
- name: `canonical_audit`
- desc: `"Audit which apex/www variant is canonical for a Vercel project."`
- input: `{ project: string }`
- output:
  ```ts
  {
    project: string;
    apex: { name; redirect; redirectStatusCode; verified } | null;
    www: { name; redirect; redirectStatusCode; verified } | null;
    canonical: "apex" | "www" | "split" | "none" | "broken";
    notes: string[];
  }
  ```
- Logic:
  - `apex` is the domain whose `name === apexName`.
  - `www` is the domain whose `name === "www." + apexName` (apexName from any domain).
  - `canonical = "apex"` iff apex.redirect is null AND www.redirect === apex.name.
  - `canonical = "www"` iff www.redirect is null AND apex.redirect === www.name.
  - `canonical = "split"` if both redirect somewhere unrelated.
  - `canonical = "broken"` if a redirect target is invalid or both apex+www redirect to each other (loop).
  - `canonical = "none"` if either side missing.
  - `notes` list any anomaly: unverified domain, non-308 status code, redirect target outside the project, etc.

**Step 1-5:** TDD with 6+ test cases (one per branch).

**Commit:** `feat(vercel-smart): canonical_audit tool`

---

### Task 7: Tool `redirects_audit` (TDD — pure read)

**Files:**
- Extend `canonical.test.ts` and `canonical.ts` (same module — both are domain-redirect tools).

**Tool spec:**
- name: `redirects_audit`
- desc: `"Show every domain on a project that has a configured redirect."`
- input: `{ project: string }`
- output:
  ```ts
  { redirects: Array<{ from: string; to: string; statusCode: number }>; count: number }
  ```
- Just filters `domains` where `redirect != null`.

**Step 1-5:** Standard TDD.

**Commit:** `feat(vercel-smart): redirects_audit tool`

---

### Task 8: `VercelClient.listDeployments` + tool `daily_status` (TDD)

**Files:**
- Extend `client.test.ts` and `client.ts`
- Test: `.../tools/__tests__/smart.test.ts` (extend)
- Source: `.../tools/smart.ts` (extend)

**Client method:** `listDeployments({ projectId?, limit, teamId? })` → hits `GET /v6/deployments`.

**Tool spec:**
- name: `daily_status`
- desc: `"24h deploy + project health snapshot across all Vercel projects."`
- input: `{ hours?: number (default 24) }`
- output:
  ```ts
  {
    window_hours: number;
    project_count: number;
    deployments: {
      total: number;
      ready: number;
      error: number;
      building: number;
      canceled: number;
    };
    by_project: Array<{
      project: string;
      ready: number;
      error: number;
      latest: { state; createdAt; url; target } | null;
    }>;
    flagged: Array<{ project: string; reason: string }>;
  }
  ```
- Logic:
  1. `client.listProjects({ limit: 100 })` for inventory.
  2. For each project, `client.listDeployments({ projectId, limit: 20 })`.
  3. Bucket by state, identify flagged projects (any error in window, or no deploys in 7 days).
- N+1 calls is acceptable for MVP — Phase 2 can parallelize.

**Step 1-5:** TDD. Mock 2 projects with mixed deploy states. ≥4 assertions.

**Commit:** `feat(vercel-smart): daily_status snapshot tool`

---

### Task 9: `VercelClient.updateProjectDomain` + tool `flip_canonical` (TDD — destructive, the headline tool)

**Files:**
- Extend `client.test.ts` and `client.ts`
- Extend `canonical.test.ts` and `canonical.ts`

**Client method:**
```ts
updateProjectDomain(idOrName: string, domain: string, body: {
  redirect?: string | null;
  redirectStatusCode?: 301|302|307|308|null;
  gitBranch?: string | null;
}): Promise<UpdatedDomain>
```
Hits `PATCH /v9/projects/{id}/domains/{domain}?teamId=X`.

**Tool spec:**
- name: `flip_canonical`
- desc: `"Switch apex<->www canonical redirect for a project. Destructive."`
- input:
  ```ts
  {
    project: string;
    target: "apex" | "www";          // desired canonical side
    statusCode?: 301 | 308;          // default 308 (Vercel default)
    confirm: boolean;                // must be true
    skip_verify?: boolean;           // default false
  }
  ```
- output:
  ```ts
  {
    ok: boolean;
    before: { apex_redirect; www_redirect; status_codes };
    after:  { apex_redirect; www_redirect; status_codes };
    changes: Array<{ domain; field; before; after }>;
    verified: { apex: { url; status; location? }; www: { url; status; location? } } | null;
    verified_at: string | null;
  }
  ```
- Flow:
  1. Run `canonical_audit` internally to compute `before` state.
  2. Compute target end-state and `changes[]`.
  3. If `changes.length === 0` → return early `{ ok: true, before, after: before, changes: [], verified: null }` (idempotent no-op).
  4. `guardDestructive({ confirm, preview: <human-readable diff> })`.
  5. Issue PATCH calls in order: first set the side that should redirect, then null out the other side's redirect. (Order matters to avoid a brief redirect loop.)
  6. If a PATCH fails partway, attempt rollback of any successful patches; surface combined error.
  7. Re-fetch domains for `after` state.
  8. If `!skip_verify`: do plain `fetch(url, { redirect: "manual" })` against `https://<apex>` and `https://<www>`. Retry up to 3× with 5s backoff if status doesn't match expectation. Populate `verified`.
  9. Return.

**Step 1: Write failing tests** — at minimum:
- `confirm: false` → `ConfirmRequiredError` with preview containing both domain names.
- Idempotent no-op (already canonical) → `ok: true, changes: []`.
- Apex→www flip: 2 PATCH calls in correct order + verify success path.
- Verify retry: first verify returns wrong status, second succeeds.
- Verify failure after 3 retries → `ok: true, verified: { ... last attempt ... }` but `notes` flag mismatch (no rollback — propagation lag is expected; user reviews).
- Rollback path: simulate second PATCH failing → first PATCH gets reverted.

Use `msw` for both Vercel API mocks AND for intercepting the verify `fetch` calls (msw can mock arbitrary URLs).

**Step 2: Run** — FAIL.

**Step 3: Implement** — keep the function under ~120 lines; helper `computeFlipPlan(currentDomains, target)` → `{ patches: [...], previewLines: [...] }` keeps logic testable.

**Step 4: Run** — PASS.

**Step 5: Commit** `feat(vercel-smart): flip_canonical with confirm gate, ordered PATCH, verify-with-retry, rollback`

---

### Task 10: Wire `tools/index.ts` + `server.ts` entry + creds bootstrap

**Files:**
- Replace `.../src/tools/index.ts`
- Replace `.../src/server.ts`
- Create `.../src/context.ts` (creds + client factory)

**Step 1: `tools/index.ts`** — exports a single `tools` array with all 7 tool definitions.

**Step 2: `context.ts`**
```ts
import { loadCreds } from "smart-mcp-core";
import { VercelClient } from "./client.js";

export function buildContext() {
  const creds = loadCreds<{ VERCEL_TOKEN: string; VERCEL_TEAM_ID?: string }>({
    serviceName: "vercel-smart",
    required: ["VERCEL_TOKEN"],
    optional: ["VERCEL_TEAM_ID"],
  });
  return { client: new VercelClient(creds) };
}
```

**Step 3: `server.ts`**
```ts
#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { tools } from "./tools/index.js";
import { buildContext } from "./context.js";

await createMcpServer({
  name: "vercel-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
```
Add `chmod +x dist/server.js` in a postbuild script in `package.json`.

**Step 4: Run `npm run build --workspace=vercel-smart`** — expect clean.

**Step 5: Commit** `feat(vercel-smart): wire 7 tools into stdio MCP server entry`

---

### Task 11: Update `scripts/install-clients.sh` + README

**Files:**
- Edit `scripts/install-clients.sh`
- Edit `packages/vercel-smart/README.md`
- Edit root `README.md`

**Step 1: install-clients.sh** — add registration of `vercel-smart` for Claude Code, Codex, and Cursor configs (mirror the existing core pattern). Read `VERCEL_TOKEN` from existing env if present, otherwise prompt.

**Step 2: vercel-smart/README.md** — list the 7 MVP tools with their input/output one-liners. Include "Setup" with `export VERCEL_TOKEN=...` instruction and how to discover team id.

**Step 3: root README.md** — flip the `vercel-smart` line from "planned" to "shipped (MVP)".

**Step 4:** No tests change. Just `npm run build && npm test` from root — all green.

**Step 5: Commit** `docs(vercel-smart): README + install-clients registration`

---

### Task 12: Final verify + tag

**Files:** None changed.

**Step 1: From repo root, run:**
```
npm run build
npm test
```
Expected: both workspaces build clean, all tests pass (Phase 0's 42 + new vercel-smart suite).

**Step 2: Manually inspect tool count** with `grep -c "name:" packages/vercel-smart/src/tools/*.ts` — expect ≥ 7.

**Step 3: Tag**
```
git tag -a phase-1-vercel-smart-mvp -m "Phase 1 MVP: 7 vercel-smart tools (list_projects, list_domains, smart_project, canonical_audit, redirects_audit, daily_status, flip_canonical). All unit tests green."
git push origin main --tags
```

**Step 4: Defer to user — live smoke test.** I (Claude) cannot run the live MCP because I don't have stdio access to a long-running process from the tool harness. Surface this to the user with a one-liner: `node packages/vercel-smart/dist/server.js` then test via Claude Code's `/mcp` registration. Do NOT mark the phase complete until user confirms the live smoke pass.

---

## What's NOT in this plan (deferred to Phase 2)

- Pagination beyond `limit: 100` for projects/deployments lists.
- Tools: `add_domain`, `remove_domain`, `list_deployments`, `get_deployment_logs`, `redeploy`, `cancel_deployment`, `list_env`, `set_env`, `delete_env`, `analytics_summary`, `toolbar_*`, `edge_config_*`, `function_*`, full domain CRUD.
- Live integration tests against real Vercel.
- Smoke harness (`npm run smoke` is a placeholder in this MVP).
- Migrating `clickup-smart-mcp` into the monorepo.

These are explicitly out of scope. Add to Phase 2 plan when MVP ships.
