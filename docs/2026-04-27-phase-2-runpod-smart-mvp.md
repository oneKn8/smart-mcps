# runpod-smart MVP (Phase 2) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task in this session. Each task gets a fresh implementer subagent + spec reviewer + code quality reviewer.

**Goal:** Ship `runpod-smart` MCP — pod lifecycle (list/get/launch/start/stop/terminate), templates, serverless endpoints, billing snapshot, and a small set of smart shortcuts (`spin_training_pod`, `kill_idle_pods`, `cost_audit`, `daily_status`). Single user. ~12 tools total. All unit tests green.

**Architecture:** New workspace `packages/runpod-smart/`. Imports `smart-mcp-core` for auth/http/errors/confirm/fuzzy/server. One `client.ts` wrapping the Runpod REST API at `https://rest.runpod.io/v1`. Tools split into thin files (`pods.ts`, `templates.ts`, `endpoints.ts`, `billing.ts`, `smart.ts`). Tests use `msw` to mock Runpod API responses. **NO GraphQL** — Runpod's modern REST API covers everything we need; the original design-doc note about adding a `graphqlQuery` helper to core is obsolete.

**Tech Stack:** Same as Phase 1 — TypeScript 5.7 ESM, Node 22+, vitest 2.1, msw 2.6, zod 3.24, `@modelcontextprotocol/sdk` 1.12. No new core changes required (auth, http, errors, confirm, fuzzy, server bootstrap, .env loader, multi-tenant patterns all reusable).

**Runpod REST API endpoints (locked in by research, 2026-04-27):**
- `https://rest.runpod.io/v1` base
- Auth: `Authorization: Bearer ${RUNPOD_API_KEY}`
- Pods:
  - `GET /pods` (list, with filters)
  - `GET /pods/{podId}` (get one)
  - `POST /pods` (create)
  - `PATCH /pods/{podId}` (update)
  - `DELETE /pods/{podId}` (terminate)
  - `POST /pods/{podId}/start` (start)
  - `POST /pods/{podId}/stop` (stop)
  - `POST /pods/{podId}/reset` (hard reset)
  - `POST /pods/{podId}/restart` (restart)
- Endpoints (serverless):
  - `GET /endpoints`, `GET /endpoints/{id}`, `POST /endpoints`, `PATCH /endpoints/{id}`, `DELETE /endpoints/{id}`
- Templates:
  - `GET /templates`, `GET /templates/{id}`, `POST /templates`, `PATCH /templates/{id}`, `DELETE /templates/{id}`
- Network volumes: same CRUD pattern
- Billing:
  - `GET /billing/pods`
  - `GET /billing/endpoints`
  - `GET /billing/networkvolumes`
- Full OpenAPI: `https://rest.runpod.io/v1/openapi.json`

**Pod create body shape (from openapi.json, all fields optional with defaults):**
```ts
{
  name?: string;
  imageName?: string;
  computeType?: "GPU" | "CPU";       // default "GPU"
  cloudType?: "SECURE" | "COMMUNITY"; // default "SECURE"
  gpuCount?: number;                  // default 1
  gpuTypeIds?: string[];              // e.g. ["NVIDIA GeForce RTX 4090"]
  containerDiskInGb?: number;
  volumeInGb?: number;
  volumeMountPath?: string;
  ports?: string[];                   // e.g. ["8888/http", "22/tcp"]
  env?: Record<string, string>;
  templateId?: string;
  networkVolumeId?: string;
  interruptible?: boolean;
  // ... many more (see openapi.json)
}
```

**Pod response shape:** `{ id, name, image, desiredStatus, costPerHr, adjustedCostPerHr, gpu: { displayName }, lastStartedAt, ... }`. Response includes computed `costPerHr` — that's the unblocker for the cost-audit tool (no separate price-list call needed).

**Notes baked into plan:**
- Auto multi-team is NOT applicable — Runpod is single-account per token (no team-id required on calls). Simpler than vercel-smart. Just `RUNPOD_API_KEY` from .env.
- Default GPU resolution: `RUNPOD_DEFAULT_GPU` env (optional) — used by `spin_training_pod` if no explicit `gpu` arg. If unset, default to `"NVIDIA GeForce RTX 4090"` (cheap, common).
- `cheapest_h100` smart shortcut requires GPU pricing data. Runpod's REST API does NOT expose a `/gpuTypes` endpoint with pricing — that's GraphQL only. For Phase 2 MVP, **defer this tool**. Add to Phase 3 polish.
- "Idle" definition for `kill_idle_pods`: pod is `RUNNING` (desiredStatus) AND has no GPU utilization OR has been started > N hours ago AND user requested cleanup. For MVP, "idle" = `desiredStatus === "RUNNING"` AND `lastStartedAt < now - input.hours`. Real GPU-utilization-based detection requires the Runpod Python SDK's `getPodUsage` or scraping — out of scope.

---

## Conventions for the implementer subagent

Same as Phase 1:
1. Strict TDD. Red → green → refactor → commit.
2. Commit after every task. Conventional commits (`feat(runpod-smart): ...`).
3. NO fixtures referencing real customer projects. Use `alpha-pod`, `beta-pod`, `training-bert-base`, etc.
4. Network forbidden in tests. Use `msw` for every Runpod call.
5. Tool descriptions terse (≤ 15 tokens).
6. Read-only tools never take `confirm`. All write/destructive tools take `confirm: boolean` and use `guardDestructive`.
7. All API errors flow through `smart-mcp-core`'s `fetchJson` and `toMcpResult` — do not invent new error paths.
8. NO emojis. NO unicode in note strings. NO mentions of AI/Claude/Anthropic/former-employer.
9. .env credential is `RUNPOD_API_KEY` (and optional `RUNPOD_DEFAULT_GPU`). Add to `~/.config/smart-mcps/.env` template only — actual key value goes in user's local file.

---

## Task list

### Task 1: Scaffold `packages/runpod-smart` workspace

Mirror the Phase 1 vercel-smart scaffold task exactly. Files: `package.json` (name `runpod-smart`, deps `smart-mcp-core *`, MCP SDK, zod), `tsconfig.json` (composite, references `../core`), `vitest.config.ts`, `src/server.ts` (placeholder), `src/tools/index.ts` (placeholder), `README.md` (placeholder).

Commit: `chore(runpod-smart): scaffold workspace`

### Task 2: `RunpodClient` + `listPods` (TDD)

Tests (in `src/__tests__/client.test.ts`):
1. Constructor reads `RUNPOD_API_KEY` via `loadCreds`. With env, no throw.
2. Constructor throws `AuthError` when key missing.
3. `listPods()` calls `GET https://rest.runpod.io/v1/pods` with bearer.
4. `listPods({ desiredStatus: "RUNNING" })` passes filter as query param.
5. Returns parsed body unchanged.
6. 401 → `AuthError` mentioning `RUNPOD_API_KEY`.
7. 429 retried then `RateLimitError`.

Client method: `listPods(opts?: { desiredStatus?: string })` → `Promise<{ pods: Pod[] }>`.

Commit: `feat(runpod-smart): RunpodClient.listPods with auth + retry`

### Task 3: Tool `list_pods` (TDD)

- name: `"list_pods"`
- desc: `"List all Runpod pods."`
- input: `z.object({ status: z.enum(["RUNNING","STOPPED","ALL"]).optional().default("ALL") })`
- output: `{ pods: Array<{ id, name, status, image, gpu: { displayName, count }, costPerHr, adjustedCostPerHr, lastStartedAt: string|null }>, count }`
- Strips upstream extras. ≥9 tests including status filter mapping (`ALL` → no query, others → `desiredStatus=<X>`), field stripping, null-safe access on optional fields.

Commit: `feat(runpod-smart): list_pods tool`

### Task 4: Client methods + tools `get_pod`, `start_pod`, `stop_pod`, `terminate_pod` (TDD)

Add to client:
- `getPod(podId): Promise<Pod>` — `GET /pods/{podId}`
- `startPod(podId): Promise<Pod>` — `POST /pods/{podId}/start`
- `stopPod(podId): Promise<Pod>` — `POST /pods/{podId}/stop`
- `terminatePod(podId): Promise<void>` — `DELETE /pods/{podId}`

All four must wrap 404 → `NotFoundError("Pod not found: <podId>")`.

Tools (in `src/tools/pods.ts`):
- `get_pod` — read; input `{ pod_id }`; output the slim Pod shape.
- `start_pod` — DESTRUCTIVE; input `{ pod_id, confirm }`; preview `"Will start pod <id> (~$<costPerHr>/hr)"`. Get pod first to compute preview.
- `stop_pod` — DESTRUCTIVE; same pattern.
- `terminate_pod` — DESTRUCTIVE; same pattern. Preview must say "PERMANENTLY DELETE".

Each tool: ~6-9 tests including confirm gate, NotFoundError propagation, output shape stripping. ~32 tests total for this task.

Commit: `feat(runpod-smart): get_pod + start/stop/terminate (destructive)`

### Task 5: Client `createPod` + tool `launch_pod` (TDD — destructive headline)

Client:
```ts
createPod(body: PodCreateBody): Promise<Pod>  // POST /pods
```

Tool spec:
- name: `"launch_pod"`
- desc: `"Launch a new GPU pod with image, GPU type, and resource config."`
- inputSchema:
  ```ts
  z.object({
    name: z.string().min(1),
    image: z.string().min(1),                      // e.g. "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04"
    gpu: z.string().min(1).optional(),              // defaults to RUNPOD_DEFAULT_GPU env or "NVIDIA GeForce RTX 4090"
    gpu_count: z.number().int().min(1).max(8).optional().default(1),
    cloud_type: z.enum(["SECURE","COMMUNITY"]).optional().default("SECURE"),
    container_disk_gb: z.number().int().min(5).max(2000).optional().default(50),
    volume_gb: z.number().int().min(0).max(10000).optional().default(0),
    volume_mount_path: z.string().optional().default("/workspace"),
    ports: z.array(z.string()).optional().default(["8888/http","22/tcp"]),
    env: z.record(z.string(), z.string()).optional(),
    template_id: z.string().optional(),
    interruptible: z.boolean().optional().default(false),
    confirm: z.boolean().optional().default(false),
  })
  ```
- output: slim Pod shape PLUS `costPerHr` and `adjustedCostPerHr` highlighted, plus a `connect_hint: string` (e.g., `"runpodctl exec --pod <id> bash"` or SSH info if port 22 is mapped).

Behavior:
1. Resolve `gpu` from input → cred → fallback default.
2. `guardDestructive({ confirm, preview: "Will launch <name> on <gpu>x<count> in <cloud_type> cloud (~$<estimatedCostPerHr>/hr)" })`. (Note: actual cost not known until creation; the preview is best-effort. Could query a hardcoded GPU price table for common GPUs, OR just say "cost shown after creation" — pick the simpler path for MVP.)
3. POST to `/pods` with mapped body.
4. Return slim shape with `connect_hint`.

≥10 tests including confirm gate, default GPU resolution from env, schema bounds, cred fallback chain, output mapping.

Commit: `feat(runpod-smart): launch_pod with confirm gate + default-GPU resolution`

### Task 6: Client + tools `list_templates`, `list_endpoints` (TDD — read)

- `listTemplates()` → `GET /templates`
- `listEndpoints()` → `GET /endpoints`

Tools mirror `list_pods` shape — slim per-record output (`id, name, imageName, ...`). ≥6 tests each. One file `src/tools/templates.ts` for templates; one `src/tools/endpoints.ts` for serverless.

Commit: `feat(runpod-smart): list_templates + list_endpoints`

### Task 7: Client + tool `cost_audit` + `daily_status` (TDD)

Client methods:
- `getBillingPods({ from?, to? })` → `GET /billing/pods?from=...&to=...`
- `getBillingEndpoints({ from?, to? })` → `GET /billing/endpoints?...`
- `getBillingNetworkVolumes(...)` → same

Tool `cost_audit`:
- name: `"cost_audit"`
- desc: `"Spend snapshot for pods, serverless, and storage in window."`
- inputSchema: `z.object({ days: z.number().int().min(1).max(365).optional().default(7) })`
- output:
  ```ts
  {
    window_days: number;
    total_usd: number;
    by_resource: { pods: number; endpoints: number; networkvolumes: number };
    top_pods: Array<{ pod_id, name, cost_usd }>;
    notes: string[];           // anomalies
  }
  ```

Tool `daily_status` (mirror vercel-smart's pattern):
- name: `"daily_status"`
- desc: `"Active pods + last 24h cost + flagged resources."`
- input: `{ hours?: number, default 24 }`
- output: `{ window_hours, active_pods: Array<{...slim...}>, total_cost_usd_window, flagged: Array<{ pod_id, reason }> }`
- Flagged rules: pod RUNNING > N hours with low/no GPU utilization (we can't actually detect util in REST — proxy with "running > 24h without restart" as a Phase 2 simplification).

≥12 tests across both tools. Use `vi.useFakeTimers()` for deterministic "now" in window math.

Commit: `feat(runpod-smart): cost_audit + daily_status`

### Task 8: Smart shortcut `spin_training_pod` (TDD — destructive)

Tool spec:
- name: `"spin_training_pod"`
- desc: `"Launch a pre-configured GPU pod for ML training."`
- inputSchema:
  ```ts
  z.object({
    name: z.string().min(1),
    framework: z.enum(["pytorch","tensorflow","jax"]).optional().default("pytorch"),
    cuda: z.enum(["11.8","12.1","12.4"]).optional().default("12.1"),
    gpu: z.string().optional(),          // defaults via cred
    gpu_count: z.number().int().min(1).max(8).optional().default(1),
    volume_gb: z.number().int().min(0).max(2000).optional().default(100),
    confirm: z.boolean().optional().default(false),
  })
  ```
- Behavior: Map (framework, cuda) → image name (lookup table — PyTorch latest with matching CUDA, etc.). Then internally call `launch_pod` with sensible training defaults (volume mount `/workspace`, ports `8888/http,22/tcp`, env `JUPYTER_PASSWORD` placeholder).

≥6 tests. Image lookup table covers ≥6 framework+CUDA combinations.

Commit: `feat(runpod-smart): spin_training_pod smart shortcut`

### Task 9: Smart shortcut `kill_idle_pods` (TDD — destructive)

Tool spec:
- name: `"kill_idle_pods"`
- desc: `"Stop pods running > N hours without recent activity."`
- inputSchema:
  ```ts
  z.object({
    older_than_hours: z.number().int().min(1).max(720).optional().default(24),
    dry_run: z.boolean().optional().default(true),
    confirm: z.boolean().optional().default(false),
  })
  ```
- Behavior:
  1. List pods with `desiredStatus: "RUNNING"`.
  2. Filter: `lastStartedAt < now - older_than_hours * 3600 * 1000`.
  3. If `dry_run`: return preview list, no changes.
  4. If not dry_run AND confirm: call `stopPod(id)` for each. Sequential await.
  5. Output: `{ scanned, candidates: Array<{ id, name, started_at, hours_running, costPerHr }>, stopped: Array<{ id, ok }>, total_savings_estimate_per_hr }`.

≥10 tests including dry_run path, confirm gate, fake timers for `lastStartedAt` math, partial-failure handling.

Commit: `feat(runpod-smart): kill_idle_pods smart shortcut with dry-run`

### Task 10: Wire `tools/index.ts` + `server.ts` + `context.ts`

Aggregate all tools (~12 total: `list_pods`, `get_pod`, `start_pod`, `stop_pod`, `terminate_pod`, `launch_pod`, `list_templates`, `list_endpoints`, `cost_audit`, `daily_status`, `spin_training_pod`, `kill_idle_pods`). Wire stdio MCP entry at `src/server.ts`. `context.ts` builds `{ client: new RunpodClient() }`.

Add `chmod +x dist/server.js` postbuild.

Smoke check: `env -i HOME="$HOME" PATH="$PATH" timeout 3 node packages/runpod-smart/dist/server.js < /dev/null; echo "exit=$?"` — expect exit 0.

Commit: `feat(runpod-smart): wire 12 tools into stdio MCP server entry`

### Task 11: install-clients.sh registration + READMEs

`scripts/install-clients.sh` already auto-discovers any built MCP — no script changes needed. But verify the auto-discovery picks up runpod-smart.

Update:
- `packages/runpod-smart/README.md` — full doc with all 12 tools (mirror vercel-smart README structure)
- Root `README.md` — flip `runpod-smart` line from "(planned)" to "(MVP shipped, X tools, Y tests)"
- `~/.config/smart-mcps/.env` template (new file added during setup, NOT committed) — uncomment `RUNPOD_API_KEY=` and `RUNPOD_DEFAULT_GPU=` lines as a hint for the user

Commit: `docs(runpod-smart): README + status update for shipped MVP`

### Task 12: Final verify + tag

```
npm run build
npm test
```
Expected: 57 core + 135 vercel-smart + ~80-100 runpod-smart tests pass. Both workspaces build clean.

Tag:
```
git tag -a phase-2-runpod-smart-mvp -m "Phase 2 MVP: 12 runpod-smart tools (list/get/start/stop/terminate/launch_pod, list_templates, list_endpoints, cost_audit, daily_status, spin_training_pod, kill_idle_pods). Builds on smart-mcp-core. All unit tests green."
git push origin main --tags
```

Hand off live smoke to user:
1. Get Runpod API key from https://www.runpod.io/console/user/settings → API Keys → Create
2. Add to `~/.config/smart-mcps/.env`: `RUNPOD_API_KEY=...`
3. Optional: `RUNPOD_DEFAULT_GPU=NVIDIA GeForce RTX 4090`
4. Register in `~/.claude.json`:
   ```json
   "runpod-smart": {
     "type": "stdio",
     "command": "node",
     "args": ["/home/oneknight/projects/tools/smart-mcps/packages/runpod-smart/dist/server.js"]
   }
   ```
5. Restart Claude Code, `/mcp` should list `runpod-smart` connected with 12 tools.
6. First test: `Use list_pods` and `Use cost_audit with days: 7` (read-only, validates auth + connectivity).
7. Then: `Use spin_training_pod with name: "test-bert", framework: "pytorch", confirm: true` — but ONLY when ready to spend ~$0.30-2/hr depending on GPU.

---

## What's NOT in this plan (deferred to Phase 3 / runpod-smart-full)

- `cheapest_h100` smart shortcut (needs GraphQL `gpuTypes` query — REST doesn't expose pricing tables).
- Real GPU utilization detection for `kill_idle_pods` (would need Runpod Python SDK or scraping).
- Network volume CRUD tools (use cases not yet identified).
- Container registry auth tools (rare).
- Pod templates create/update/delete (mostly want to read existing).
- Serverless endpoint deploy + invoke (separate workflow; defer until Phase 3 if needed).
- Pagination beyond default page size for `list_pods` etc.
- Live integration tests against real Runpod.
- Parallel `Promise.all` for kill_idle_pods (sequential MVP is fine for typical 5-20 pod counts).

These are explicitly out of scope. Add to a Phase 3 plan if they become needed.

---

## Resume context for next session

If a fresh Claude Code session picks this up cold, it needs to know:
- All Phase 0 + Phase 1 are SHIPPED. Check `git log --oneline` and the tags `phase-0-bootstrap`, `phase-1-vercel-smart-mvp`.
- vercel-smart is INSTALLED in `~/.claude.json` and working in production against alpha-team-com.
- `~/.config/smart-mcps/.env` already exists with `VERCEL_TOKEN` set; just append `RUNPOD_API_KEY` after Task 11.
- Multi-team auto-discovery pattern from vercel-smart is NOT applicable to runpod-smart (single account per token).
- Established patterns (loadCreds → fetchJson → defineTool → guardDestructive) are unchanged.
- The polish backlog (Task 18) has accumulated 16+ items spanning core and vercel-smart — visit before Phase 3.
