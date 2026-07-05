# runpod-smart FULL (Phase 10) Implementation Plan

> **For Claude:** Executable contract. Every schema/signature here is verified against the live Runpod OpenAPI spec (`https://rest.runpod.io/v1/openapi.json`, pulled 2026-07-05), the live GraphQL API (`https://api.runpod.io/graphql`), and the serverless inference API (`https://api.runpod.ai/v2`). Implementer subagents quote this verbatim; deviations require justification in the commit body.

**Goal:** Take `runpod-smart` from the 12-tool MVP to the COMPLETE Runpod control surface — every REST operation, the full serverless inference lifecycle, GPU pricing + account balance via GraphQL, and composite smart shortcuts. **12 -> 43 tools.** Closes every Phase-3 deferral (cheapest_h100, network volume CRUD, registry auth, serverless deploy+invoke, per-pod cost).

**Non-negotiables (unchanged from prior phases):**
- Strict TDD: red -> green -> refactor. Tool tests stub the client with `vi.fn().mockResolvedValue(...)`; client tests use `msw`.
- Read-only tools take NO `confirm`. Every write/destructive/cost-incurring tool takes `confirm: z.boolean().optional().default(false)`, builds a `preview`, and calls `guardDestructive` BEFORE any side effect.
- The `inputSchema as unknown as z.ZodType<Input>` cast comment is REQUIRED on any schema with `.optional().default(...)` fields.
- Slim, explicit output types. camelCase output keys (match existing SlimPod/SlimTemplate/SlimEndpoint). Strip upstream extras; assert via `Object.keys(x).sort()`.
- Tool descriptions <= 15 tokens. snake_case tool names. NO emojis, NO AI/Claude/Anthropic/former-employer mentions.
- Fixtures use `alpha-*`, `pod_abc`, `ep_abc`, `tpl_*`, `nv_*`, `cra_*` — never real names. NEVER a real API key or password in a fixture.
- **Secret discipline:** `create_registry_auth` takes a `password`. It must NEVER appear in `preview`, output, logs, or test fixtures beyond a dummy literal. The upstream response returns only `{id, name}`.

---

## Base URLs / auth

```
REST_BASE      = "https://rest.runpod.io/v1"
INFERENCE_BASE = "https://api.runpod.ai/v2"
GRAPHQL_URL    = "https://api.runpod.io/graphql"
```
All three authenticate with `Authorization: Bearer ${RUNPOD_API_KEY}` (one key, `opts.token` in `fetchJson`).

**GraphQL gotcha:** the endpoint returns HTTP 200 even on query errors, with body `{ data, errors: [...] }`. `fetchJson` will NOT throw. The `graphql()` helper MUST inspect `body.errors` and throw: `AuthError` if any message matches `/unauthor|not authenticated|invalid.*key/i`, else `UpstreamError`.

---

## MODULE 1 — Client foundation (client.ts + client.test.ts)  [owner: main]

### 1a. Refactor (do first, keep green)
Extract the three base-URL constants at top of `client.ts`. Replace every existing hardcoded `"https://rest.runpod.io/v1..."` with `` `${REST_BASE}...` ``. Existing tests must stay green (URLs unchanged).

Generalize `mapPodError` -> `mapResourceError(err, kind: string, id: string)` returning `NotFoundError(`${kind} not found: ${id}`)` on 404 and the AuthError wrap on 401/403. Keep a `mapPodError` shim delegating to it (`kind="Pod"`) so existing call sites/tests are untouched.

### 1b. New REST methods (each wraps AuthError with "Check RUNPOD_API_KEY"; get/patch/delete-by-id wrap 404 via `mapResourceError`)

Pods:
- `updatePod(podId: string, body: Record<string, unknown>): Promise<Pod>` — `PATCH /pods/{id}`
- `restartPod(podId: string): Promise<void>` — `POST /pods/{id}/restart` (204)
- `resetPod(podId: string): Promise<void>` — `POST /pods/{id}/reset` (204)

Templates:
- `createTemplate(body): Promise<Template>` — `POST /templates`
- `getTemplate(templateId, opts?: { includePublic?, includeRunpod?, includeEndpointBound?: boolean }): Promise<Template>` — `GET /templates/{id}` (opts -> `includePublicTemplates`/`includeRunpodTemplates`/`includeEndpointBoundTemplates` query params)
- `updateTemplate(templateId, body): Promise<Template>` — `PATCH /templates/{id}`
- `deleteTemplate(templateId): Promise<void>` — `DELETE /templates/{id}` (204)

Endpoints:
- `createEndpoint(body): Promise<Endpoint>` — `POST /endpoints`
- `getEndpoint(endpointId, opts?: { includeTemplate?, includeWorkers?: boolean }): Promise<Endpoint>` — `GET /endpoints/{id}`
- `updateEndpoint(endpointId, body): Promise<Endpoint>` — `PATCH /endpoints/{id}`
- `deleteEndpoint(endpointId): Promise<void>` — `DELETE /endpoints/{id}` (204)

Network volumes (new types):
```ts
export type NetworkVolume = Record<string, unknown> & { id: string; name?: string; size?: number; dataCenterId?: string };
export interface ListNetworkVolumesResponse { networkVolumes: NetworkVolume[] }
```
- `listNetworkVolumes(): Promise<ListNetworkVolumesResponse>` — `GET /networkvolumes` (bare array -> wrap `{networkVolumes}`)
- `createNetworkVolume(body: { name; size; dataCenterId }): Promise<NetworkVolume>` — `POST /networkvolumes`
- `getNetworkVolume(id): Promise<NetworkVolume>` — `GET /networkvolumes/{id}`
- `updateNetworkVolume(id, body: { name?; size? }): Promise<NetworkVolume>` — `PATCH /networkvolumes/{id}`
- `deleteNetworkVolume(id): Promise<void>` — `DELETE /networkvolumes/{id}` (204)

Registry auth (new types):
```ts
export type RegistryAuth = Record<string, unknown> & { id: string; name?: string };
export interface ListRegistryAuthsResponse { registryAuths: RegistryAuth[] }
```
- `listRegistryAuths(): Promise<ListRegistryAuthsResponse>` — `GET /containerregistryauth` (bare array -> wrap)
- `createRegistryAuth(body: { name; username; password }): Promise<RegistryAuth>` — `POST /containerregistryauth`
- `getRegistryAuth(id): Promise<RegistryAuth>` — `GET /containerregistryauth/{id}`
- `deleteRegistryAuth(id): Promise<void>` — `DELETE /containerregistryauth/{id}` (204)

### 1c. Serverless inference (INFERENCE_BASE)
```ts
export type JobStatus = Record<string, unknown> & { id?: string; status?: string; output?: unknown; delayTime?: number; executionTime?: number };
export type EndpointHealth = Record<string, unknown> & { jobs?: Record<string, number>; workers?: Record<string, number> };
```
- `runEndpoint(endpointId, input: unknown, extra?: { webhook?: string }): Promise<JobStatus>` — `POST /v2/{id}/run` body `{ input, ...extra }`
- `runEndpointSync(endpointId, input, extra?): Promise<JobStatus>` — `POST /v2/{id}/runsync` (use `timeoutMs: 120_000`)
- `getJobStatus(endpointId, jobId): Promise<JobStatus>` — `GET /v2/{id}/status/{jobId}`
- `cancelJob(endpointId, jobId): Promise<JobStatus>` — `POST /v2/{id}/cancel/{jobId}`
- `endpointHealth(endpointId): Promise<EndpointHealth>` — `GET /v2/{id}/health`
- `purgeQueue(endpointId): Promise<{ removed?: number; status?: string }>` — `POST /v2/{id}/purge-queue`

404 on these -> `mapResourceError(err, "Endpoint", endpointId)`.

### 1d. GraphQL
```ts
export type GpuType = { id: string; displayName?: string; memoryInGb?: number; secureCloud?: boolean; communityCloud?: boolean; securePrice?: number|null; communityPrice?: number|null; lowestPrice?: { minimumBidPrice?: number|null; uninterruptablePrice?: number|null } };
export type Balance = { id?: string; clientBalance?: number; currentSpendPerHr?: number; spendLimit?: number; minBalance?: number };
```
- private `graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>` — `POST GRAPHQL_URL` body `{query, variables}`, token. After `fetchJson<{data,errors}>`, if `errors?.length` throw per the gotcha above; else return `data`.
- `listGpuTypes(): Promise<{ gpuTypes: GpuType[] }>` — query `{ gpuTypes { id displayName memoryInGb secureCloud communityCloud securePrice communityPrice lowestPrice(input:{gpuCount:1}) { minimumBidPrice uninterruptablePrice } } }`
- `getBalance(): Promise<Balance>` — query `{ myself { id clientBalance currentSpendPerHr spendLimit minBalance } }` -> return `data.myself`

### 1e. client.test.ts additions (msw)
Cover, at minimum: each new method hits the right URL+method+bearer; PATCH/POST bodies forwarded verbatim; 204 methods resolve undefined; get-by-id 404 -> `NotFoundError` with resource-named message; `listNetworkVolumes`/`listRegistryAuths` wrap bare arrays; GraphQL success returns `data.*`; GraphQL `{errors}` -> throws (AuthError for auth-shaped message, else UpstreamError); inference methods hit INFERENCE_BASE paths. Target ~55-70 new client assertions.

Commit: `feat(runpod-smart): client — full REST CRUD + serverless inference + GraphQL`

---

## MODULES 2-9 — Tool layer (one file each, TDD, stub client). Descriptions <= 15 tokens.

Conventions recap for every write tool: get-or-reference the resource, build `preview`, `guardDestructive`, then act. Only send fields the caller provided (omit undefined). Reuse the file-local slim mapper for output.

### MODULE 2 — pods.ts (extend)  [owner: agent-P]
- `update_pod` — "Update a pod's config (image, disk, env, ports)." DESTRUCTIVE. Input: `{ pod_id, name?, image?, container_disk_gb?, volume_gb?, volume_mount_path?, ports?: string[], env?: Record<string,string>, container_registry_auth_id?, locked?: boolean, confirm }`. Map snake->camel (`image`->`imageName`, `container_disk_gb`->`containerDiskInGb`, `volume_gb`->`volumeInGb`, etc.), omit undefined. Preview: `Will update pod <id> (<comma-list of changed fields>)`. Output: `SlimPod` (via `mapPod`).
- `restart_pod` — "Restart a running pod." DESTRUCTIVE. Input `{ pod_id, confirm }`. Preview `Will restart pod <id> (<cost>)` (getPod for cost, like start/stop). Output `{ pod_id, restarted: true }`.
- `reset_pod` — "Reset a pod to a clean state." DESTRUCTIVE. Same shape. Output `{ pod_id, reset: true }`.

### MODULE 3 — templates.ts (extend)  [owner: agent-T]
Reuse local `mapTemplate`.
- `create_template` — "Create a reusable pod/serverless template." DESTRUCTIVE (creates a resource). Input `{ name, image, container_disk_gb?, volume_gb?, volume_mount_path?, ports?, env?, is_serverless?, is_public?, category?: "NVIDIA"|"AMD"|"CPU", readme?, docker_start_cmd?: string[], container_registry_auth_id?, confirm }`. Required: `name`, `image`. Body maps `image`->`imageName`, etc. Preview `Will create template <name> from <image>`. Output `SlimTemplate & { id }`.
- `get_template` — "Get a template by ID." READ. Input `{ template_id, include_public?, include_runpod?, include_endpoint_bound? }`. Output `SlimTemplate`.
- `update_template` — "Update a template." DESTRUCTIVE. Input `{ template_id, name?, image?, ...same optional set, confirm }`. Preview lists changed fields. Output `SlimTemplate`.
- `delete_template` — "Delete a template." DESTRUCTIVE. Input `{ template_id, confirm }`. Preview `Will PERMANENTLY DELETE template <id>`. Output `{ template_id, deleted: true }`.

### MODULE 4 — endpoints.ts (extend)  [owner: agent-E]
Reuse local `mapEndpoint`.
- `create_endpoint` — "Create a serverless endpoint from a template." DESTRUCTIVE. Input `{ template_id (req), name?, compute_type?: "GPU"|"CPU", gpu_type_ids?: string[], gpu_count?, workers_min?, workers_max?, idle_timeout?, scaler_type?: "QUEUE_DELAY"|"REQUEST_COUNT", scaler_value?, execution_timeout_ms?, flashboot?, network_volume_id?, data_center_ids?: string[], confirm }`. Body snake->camel. Preview `Will create endpoint <name|from template <id>>`. Output `SlimEndpoint & { id }`.
- `get_endpoint` — "Get a serverless endpoint by ID." READ. Input `{ endpoint_id, include_template?, include_workers? }`. Output `SlimEndpoint`.
- `update_endpoint` — "Update endpoint scaling/config." DESTRUCTIVE. Input `{ endpoint_id, ...scaling fields, confirm }`. Output `SlimEndpoint`.
- `delete_endpoint` — "Delete a serverless endpoint." DESTRUCTIVE. Input `{ endpoint_id, confirm }`. Preview `Will PERMANENTLY DELETE endpoint <id>`. Output `{ endpoint_id, deleted: true }`.

### MODULE 5 — volumes.ts (NEW)  [owner: agent-V]
`type SlimVolume = { id: string; name: string|null; size: number|null; dataCenterId: string|null }`; `mapVolume` via null-helpers.
- `list_network_volumes` — "List network volumes." READ. `{}` -> `{ volumes: SlimVolume[], count }`.
- `create_network_volume` — "Create a network volume." DESTRUCTIVE. Input `{ name, size_gb (1..4000), data_center_id, confirm }`. Body `{ name, size: size_gb, dataCenterId: data_center_id }`. Preview `Will create <size_gb>GB volume <name> in <dc>`. Output `SlimVolume`.
- `get_network_volume` — "Get a network volume by ID." READ. `{ volume_id }` -> `SlimVolume`.
- `update_network_volume` — "Rename or grow a network volume." DESTRUCTIVE. Input `{ volume_id, name?, size_gb?, confirm }`. NOTE: Runpod volumes can only GROW; preview must say `size can only increase`. Output `SlimVolume`.
- `delete_network_volume` — "Delete a network volume." DESTRUCTIVE. `{ volume_id, confirm }`. Preview `Will PERMANENTLY DELETE volume <id> (data lost)`. Output `{ volume_id, deleted: true }`.

### MODULE 6 — registry.ts (NEW)  [owner: agent-R]  ** SECRET DISCIPLINE **
`type SlimRegistryAuth = { id: string; name: string|null }`.
- `list_registry_auths` — "List container registry credentials." READ. `{}` -> `{ registryAuths: SlimRegistryAuth[], count }`.
- `create_registry_auth` — "Store private container registry credentials." DESTRUCTIVE. Input `{ name, username, password, confirm }`. Preview `Will store registry credentials <name> for user <username>` — **password MUST NOT appear**. Output `SlimRegistryAuth` (id, name only). Add an explicit test asserting the preview/output contain neither the password value nor the substring.
- `get_registry_auth` — "Get a registry credential by ID." READ. `{ auth_id }` -> `SlimRegistryAuth`.
- `delete_registry_auth` — "Delete a registry credential." DESTRUCTIVE. `{ auth_id, confirm }`. Output `{ auth_id, deleted: true }`.

### MODULE 7 — serverless.ts (NEW)  [owner: agent-S]
Inference shapes are from Runpod serverless docs (NOT the REST openapi): `run`->`{id,status}`; `runsync`/`status`->`{id,status,output?,delayTime?,executionTime?}`; `health`->`{jobs:{completed,failed,inProgress,inQueue,retried}, workers:{idle,initializing,ready,running,throttled,unhealthy}}`; `purge-queue`->`{removed,status}`. Statuses: IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED|CANCELLED|TIMED_OUT.
- `run_endpoint` — "Submit an async job to a serverless endpoint." DESTRUCTIVE (incurs compute cost). Input `{ endpoint_id, input: z.record(z.string(), z.unknown()) | z.unknown(), webhook?, confirm }`. Preview `Will submit async job to endpoint <id>`. Output `{ job_id: string|null, status: string|null }`.
- `run_sync` — "Run a serverless job and wait for the result." DESTRUCTIVE. Input `{ endpoint_id, input, confirm }`. Output `{ job_id, status, output, delay_ms, execution_ms }` (null-safe).
- `get_job_status` — "Check a serverless job's status/output." READ. `{ endpoint_id, job_id }` -> same slim job shape as run_sync.
- `cancel_job` — "Cancel a queued or running serverless job." DESTRUCTIVE. `{ endpoint_id, job_id, confirm }`. Output `{ job_id, status }`.
- `endpoint_health` — "Serverless endpoint queue + worker health." READ. `{ endpoint_id }` -> `{ jobs: {...}, workers: {...} }` (pass through numeric fields null-safe).
- `purge_queue` — "Purge all queued jobs for an endpoint." DESTRUCTIVE. `{ endpoint_id, confirm }`. Output `{ removed: number|null, status: string|null }`.

### MODULE 8 — gpu.ts (NEW)  [owner: agent-G]
`type SlimGpuType = { id; displayName; memoryInGb; secureCloud; communityCloud; securePrice; communityPrice }` (drop nested lowestPrice after flattening: `securePrice ?? lowestPrice.uninterruptablePrice`). Provide `mapGpuType`.
- `list_gpu_types` — "List GPU types with availability and pricing." READ (GraphQL). Input `{ min_vram_gb?, cloud?: "SECURE"|"COMMUNITY"|"ANY" (default ANY), name_contains? }`. Filter accordingly. Output `{ gpuTypes: SlimGpuType[], count }` sorted by cheapest available price asc.
- `cheapest_gpu` — "Find the cheapest GPU matching VRAM/cloud filters." READ (GraphQL). Input `{ min_vram_gb?, cloud?, name_contains?, gpu_count? (default 1) }`. Returns the single cheapest match plus up to 4 `alternatives`. Output `{ id, displayName, price_per_hr, cloud, memoryInGb, gpu_count, estimated_per_hr_total, alternatives: SlimGpuType[], note }`. (Subsumes cheapest_h100: `name_contains:"H100"` or `min_vram_gb:80`.)
- `estimate_cost` — "Estimate pod cost before launch." READ (GraphQL). Input `{ gpu?, gpu_count? (1), hours? (1), cloud? }`. Resolve gpu via input -> client.defaultGpu -> "NVIDIA GeForce RTX 4090"; look its price up in gpuTypes. Output `{ gpu, gpu_count, price_per_hr, hours, estimated_total_usd, cloud, note }`. If the GPU id isn't found in the pricing table, return `price_per_hr: null` with an honest note (never fabricate).

### MODULE 9 — account.ts + deploy.ts (NEW)  [owner: agent-A]
account.ts:
- `account_summary` — "Account balance, burn rate, and runway." READ (GraphQL myself + listPods). Compute `runway_hours = currentSpendPerHr>0 ? clientBalance/currentSpendPerHr : null`. Output `{ balance_usd, spend_per_hr, spend_limit, min_balance, active_pod_count, runway_hours, notes: string[] }`. Note when balance < 24h runway, or spend_limit near.

deploy.ts:
- `deploy_serverless` — "Create a template and serverless endpoint in one step." DESTRUCTIVE. Input `{ name, image, gpu_type_ids?: string[], gpu_count?, workers_min?, workers_max?, idle_timeout?, container_disk_gb?, volume_gb?, env?, container_registry_auth_id?, confirm }`. Steps: `createTemplate({...,isServerless:true})` then `createEndpoint({ templateId: <new>, name, ... })`. Single `guardDestructive` up front. Preview `Will create serverless template + endpoint <name> from <image>`. Output `{ template_id, endpoint_id, name, run_url: `${INFERENCE_BASE}/<endpointId>/run` }`. If endpoint creation fails after template creation, surface the created `template_id` in the error so nothing is orphaned silently.

Per-module commit: `feat(runpod-smart): <area> tools (<tool list>)`.

---

## MODULE 10 — Wire + docs  [owner: main]
- `tools/index.ts`: import + append all 31 new tools (keep grouping/comments). Final array length 43.
- `wire.test.ts`: bump expected count to 43; keep unique-name + snake_case assertions.
- Bump `package.json` version `0.1.0` -> `0.2.0`.
- Rewrite `README.md` documenting all 43 tools grouped by area, the GraphQL + inference surfaces, and the secret note for registry auth.
- Root `README.md`: update runpod-smart line to "(full, 43 tools, N tests)".
- Confirm `install-clients.sh` auto-discovers (no change expected).

Commit: `feat(runpod-smart): wire 43 tools + README (full surface)`

---

## MODULE 11 — Verify + tag  [owner: main]
1. `npm run typecheck --workspace runpod-smart` clean.
2. `npm run build` clean (whole monorepo).
3. `npm test --workspace runpod-smart` green; then `npm test` (whole monorepo) green.
4. Smoke: `RUNPOD_API_KEY=test timeout 3 node packages/runpod-smart/dist/server.js < /dev/null; echo exit=$?` -> exit 0.
5. Adversarial review workflow (correctness / security-secret-leak / spec-compliance-vs-openapi / test-coverage), verify findings, fix.
6. Live READ-ONLY smoke against the real key (list_pods, list_gpu_types, account_summary) — no writes.
7. Tag `phase-10-runpod-smart-full`, push.

**Deferred to user (live, cost-incurring):** actually creating pods/endpoints/volumes/templates, running inference jobs. Unit tests (msw) fully cover these write paths; do not exercise them against the real account without explicit go-ahead.
