# Phase 11 — hetzner-smart (design + executable plan)

Date: 2026-07-08. Author: Santo. Status: contract for implementation.

Wraps the **Hetzner Cloud** REST API (`https://api.hetzner.cloud/v1`) as an MCP following the
`smart-mcps` conventions (see repo `CLAUDE.md`). Closest analog: `runpod-smart` (CRUD-heavy compute
provider). The one architectural novelty vs every prior smart-mcp: Hetzner mutations are **async
Actions** that must be polled to completion. This package introduces a reusable action layer.

Phase-number note: the memory's roadmap called hetzner "Phase 8", but docs already use phase 8
(gdrive), 9 (gmail-max), 10 (runpod-full). This is the next free number: **Phase 11**.

## Goal

Full curated Hetzner Cloud surface (71 tools): every resource with core CRUD + flagship actions +
four smart-shortcut families. Read-only pricing/type intelligence, one-shot `deploy_server`, cost
audit, and waste cleanup. Verified by unit tests now; a scripted live create→verify→destroy E2E runs
once a Read&Write token lands in `~/.config/smart-mcps/.env`.

## Auth / credentials

- Required: `HETZNER_API_TOKEN` — 64-char project-scoped bearer token. Header: `Authorization: Bearer <token>`.
- Optional: `HETZNER_PROJECT_ID` — informational only (the token already scopes to one project).
- Resolution via core `loadCreds` (env → shared `~/.config/smart-mcps/.env` → per-service JSON).
- Read vs Read&Write is chosen at token creation. A read token on a mutating verb → `401 token_readonly`.
- Eager-fail: construct the client in `buildContext()` so a missing token throws `AuthError` at startup.

## Verified API contract (source: official OpenAPI `docs.hetzner.cloud/cloud.spec.json`, v1.0.0, 151 paths)

Full spec saved at build time to scratchpad `hcloud.spec.json` + `paths.tsv` (189 ops). Essentials:

### Transport
- Base `https://api.hetzner.cloud/v1`, JSON, HTTPS only. `Content-Type: application/json` on POST/PUT.
- Rate limit: **3600 req/hr per project**; headers `RateLimit-Limit/Remaining/Reset`; `429 rate_limit_exceeded`.
  Core `fetchJson` already retries 429/5xx with backoff — reuse it. Action polling must back off (do not hammer).
- Pagination: `page` (1-based), `per_page` (default 25, **max 50**). Envelope `meta.pagination`:
  `{ page, per_page, previous_page, next_page, last_page, total_entries }` (nullable fields). Loop
  `page` until `next_page == null` for full enumeration.
- List filters (verified on `GET /servers`): `name` (exact), `status` (repeatable), `label_selector`,
  `sort=field:asc|desc` (repeatable), `page`, `per_page`.
- `label_selector` grammar: `k==v`, `k!=v`, `k` (present), `!k` (absent), `k in (a,b)`, comma = AND.
  Pass through `searchParams` (URL-encoded by core).

### Async Action model (the novel layer)
Action object (`GET /actions/{id}` → `{ action }`):
```
{ id, command, status: running|success|error, progress: 0..100,
  started, finished|null, resources:[{id,type}], error:{code,message}|null }
```
Mutation response envelopes (must all normalize to a primary action):
- `{ action }` — most `POST /{res}/{id}/actions/*` and single-action ops.
- `{ actions:[...] }` — `POST /firewalls`, firewall `set_rules`/`apply_to_resources`/`remove_from_resources` (one per resource).
- `{ <res>, action, next_actions:[...] }` — `POST /servers` (`server`,`action`,`next_actions`,`root_password`), `POST /volumes`.
- `{ <res>, action }` — `POST /load_balancers`, `/floating_ips`, `/primary_ips`, `/certificates`, `/placement_groups`.
- `{ action, image }` — server `create_image`. `{ action, root_password }` — `enable_rescue`. `{ action, wss_url, password }` — `request_console`.
- **No action (synchronous)**: `POST /networks`, `POST /ssh_keys` — return the resource only.
Poll paths: global `GET /actions/{id}`; per-type `GET /{res}/actions/{id}`; per-instance `GET /{res}/{id}/actions/{aid}`.

### Resources + key endpoints (curated to the tool surface below)
- Servers: `GET/POST /servers`, `GET/PUT/DELETE /servers/{id}`, `POST /servers/{id}/actions/{poweron|poweroff|reboot|reset|rebuild|change_type|create_image|change_protection}`, `GET /servers/{id}/metrics`.
- Server types (read, embedded `prices`): `GET /server_types`. Images: `GET /images`, `GET/DELETE /images/{id}`.
- SSH keys: `GET/POST /ssh_keys`, `GET/DELETE /ssh_keys/{id}`.
- Volumes: `GET/POST /volumes`, `GET/DELETE /volumes/{id}`, actions `attach|detach|resize`.
- Firewalls: `GET/POST /firewalls`, `GET/DELETE /firewalls/{id}`, actions `set_rules|apply_to_resources|remove_from_resources`.
- Networks: `GET/POST /networks`, `GET/DELETE /networks/{id}`, action `add_subnet`.
- Load balancers: `GET/POST /load_balancers`, `GET/DELETE /load_balancers/{id}`, `GET /load_balancers/{id}/metrics`.
- Floating IPs: `GET/POST /floating_ips`, `GET/DELETE /floating_ips/{id}`, actions `assign|unassign`.
- Primary IPs: `GET/POST /primary_ips`, `GET/DELETE /primary_ips/{id}`, actions `assign|unassign`.
- Certificates: `GET/POST /certificates`, `GET/DELETE /certificates/{id}`.
- Placement groups: `GET/POST /placement_groups`, `GET/DELETE /placement_groups/{id}`.
- Catalog: `GET /server_types`, `GET /locations`, `GET /datacenters`, `GET /isos`, `GET /pricing`.
- Actions: `GET /actions`, `GET /actions/{id}`.

### Key create bodies (verified — schema sketches, not impl)
- create server: `{ name, server_type, image, location?, start_after_create?=true, ssh_keys?:[names|ids], volumes?:[id], networks?:[id], firewalls?:[{firewall:id}], placement_group?:id, user_data?, labels?, public_net?:{enable_ipv4,enable_ipv6,ipv4,ipv6} }`. **No `datacenter` field** (removed; use `location`).
- create volume: `{ size, name, location?, server?, automount?, format?, labels? }`.
- create ssh_key: `{ name, public_key, labels? }`.
- create firewall: `{ name, rules:[{ direction:in|out, protocol:tcp|udp|icmp|esp|gre, port?, source_ips?, destination_ips?, description? }], apply_to?:[{type:server|label_selector, server?:{id}, label_selector?:{selector}}], labels? }`.
- create network: `{ name, ip_range, subnets?:[{type:cloud|server|vswitch, ip_range, network_zone, vswitch_id?}], routes?, labels? }`.
- create load_balancer: `{ name, load_balancer_type, algorithm?:{type:round_robin|least_connections}, location?|network_zone?, network?, public_interface?, services?, targets?, labels? }`.
- create floating_ip: `{ type:ipv4|ipv6, home_location?, server?, name?, description?, labels? }`.
- create primary_ip: `{ type:ipv4|ipv6, name, datacenter, assignee_type:server, assignee_id?, auto_delete?, labels? }`.
- create certificate: `{ name, type:uploaded|managed, certificate?, private_key?, domain_names?, labels? }`.
- create placement_group: `{ name, type:spread, labels? }`.

### Server object (slim-map source), pricing, protection, metrics
- Server key fields: `id, name, status(running|initializing|starting|stopping|off|deleting|migrating|rebuilding|unknown), public_net.ipv4.ip, public_net.ipv6.ip, private_net[], server_type{name,cores,memory,disk,cpu_type,architecture,prices[]}, datacenter, location{name,city,country,network_zone}, image, protection{delete,rebuild}, labels, created, ingoing/outgoing/included_traffic (bytes), volumes[], primary_disk_size, placement_group`.
- `GET /pricing`: `{ currency:"EUR", vat_rate, server_types:[{id,name,prices:[{location,price_hourly:{net,gross},price_monthly:{net,gross},included_traffic,price_per_tb_traffic}]}], load_balancer_types[], volume:{price_per_gb_month}, image:{price_per_gb_month}, server_backup:{percentage}, primary_ips[], floating_ips[] }`. Use `net`. **Never hardcode prices/types** — read at runtime.
- Protection: `change_protection` sets `{delete, rebuild}` (server) or `{delete}` (others). Protected op → `423 protected`. Action in flight → `423 locked`.
- Metrics: `GET /servers/{id}/metrics?type=cpu|disk|network&start&end&step` (type required, repeatable, RFC3339). LB metrics type ∈ `open_connections|connections_per_second|requests_per_second|bandwidth`. Response `{ metrics:{ start,end,step, time_series:{ <name>:{ values:[[ts_float,"val_str"],...] } } } }`.
- Error codes to map: `401 unauthorized`, `401 token_readonly`, `403 forbidden`, `404 not_found`, `409 conflict|uniqueness_error`, `423 locked|protected`, `429 rate_limit_exceeded`. Body `{ error:{ code, message, details } }`.

## Architecture

### Package layout (mirror runpod-smart)
```
packages/hetzner-smart/
  package.json  tsconfig.json  vitest.config.ts  README.md
  src/
    client.ts            # HetznerClient: creds, http helpers, extractAction, waitForAction, error mapping
    context.ts           # HetznerContext + buildContext()
    server.ts            # createMcpServer<HetznerContext>({ name:"hetzner-smart", version:"0.1.0", tools, context })
    tools/
      index.ts           # aggregates `tools`, t<T>() cast helper (Context = HetznerContext)
      null-helpers.ts    # nullableString/Number/Boolean (verbatim copy)
      server-mapper.ts   # SlimServer + mapServer (used by >=3 tools: list/get/deploy/daily/cost)
      wait-schema.ts     # shared `wait` + `confirm` zod fragments + waitResult<T>() helper shape
      servers.ts server-power.ts server-actions.ts ssh-keys.ts volumes.ts firewalls.ts
      networks.ts load-balancers.ts floating-ips.ts primary-ips.ts certificates.ts
      placement-groups.ts images.ts catalog.ts actions.ts
      deploy.ts pricing.ts ops.ts cleanup.ts
      __tests__/<topic>.test.ts
    __tests__/
      client.test.ts     # msw HTTP + HOME-override isolation + action-waiter tests
      wire.test.ts       # tools[] length, unique snake_case names, all have handler/description
scripts/live-e2e.mjs     # (repo scripts/) create->verify->destroy runbook, gated on real token
```

### Client design (`client.ts`)
- Const `HETZNER_API_BASE = "https://api.hetzner.cloud/v1"`.
- `type HetznerCreds = { HETZNER_API_TOKEN: string; HETZNER_PROJECT_ID?: string }` (+ `Record` alias for loadCreds generic).
- `class HetznerClient` with `private readonly creds`; constructor `loadCreds` fallback (required `HETZNER_API_TOKEN`, optional `HETZNER_PROJECT_ID`); `private get token()`. Never expose the token.
- Private HTTP helpers over core `fetchJson`: `get<T>(path, searchParams?)`, `post<T>(path, body?)`, `put<T>(path, body?)`, `del(path)`. Each wraps errors.
- Error mapping: `wrapAuth(err)` (relabel `AuthError` with `HETZNER_API_TOKEN`; detect `token_readonly` → "token is read-only, needs Read & Write"); `mapResourceError(err, kind, id)` (`NotFoundError` → `"<Kind> not found: <id>"`; `423 protected` → "disable delete/rebuild protection first"; `423 locked` → "resource has an action in progress, retry shortly"; else `wrapAuth`).
- **Action layer**:
  - `extractAction(body): HetznerAction | undefined` — returns `body.action ?? body.actions?.[0]`.
  - `async waitForAction(actionId, { timeoutMs=120000 }): HetznerAction` — poll `GET /actions/{id}` with backoff (e.g. 1s,2s,3s,5s… capped ~5s; overall cap `timeoutMs`); resolve on `status==="success"`; throw `UpstreamError` on `status==="error"` (message from `action.error`); throw on timeout.
  - `async waitForActions(ids, opts)` — for firewall multi-action envelopes.
- Resource methods: one per endpoint. Lists return `{ <res>: [...], meta }` as-is (already wrapped). `getAllPages<T>(path, key, searchParams?)` private helper for shortcuts (cost_audit/daily_status/cleanup) that need every page — cap total pages (e.g. 20) and `log`/note if capped.
- `encodeURIComponent` every path id. DELETE with 204 → discard.

### Context / server
- `HetznerContext { client: HetznerClient }`; `buildContext()` returns `{ client: new HetznerClient() }`.
- `server.ts`: `#!/usr/bin/env node`, `createMcpServer<HetznerContext>({ name:"hetzner-smart", version:"0.1.0", tools, context: buildContext() })`.

### Wait-aware mutation pattern (shared)
Every mutating tool input includes `wait: z.boolean().optional().default(true)` (plus `confirm` on destructive).
Handler flow: call client mutation → `extractAction(body)`; if `wait` → `waitForAction(action.id)` then return
`{ <resource_slim?>, action: { id, command, status } }`; if `!wait` → return `{ action_id, status: "running" }`.
For `create_server`/`deploy_server`, on `wait` re-fetch the server to return the settled IP. Output types are
explicit and stable across both branches (action fields present; resource fields nullable when `!wait`).

## Conventions (from repo map — non-negotiable)
- TS 5.7 ESM, NodeNext (`.js` relative imports). Strict, `noUncheckedIndexedAccess`, `noImplicitOverride`.
- `inputSchema as unknown as z.ZodType<Input>` cast + the standard comment REQUIRED on any schema with
  `.optional().default(...)`. Schemas with no defaults pass directly (no cast).
- Explicit `type Output`; handler returns exactly that shape (strip upstream extras).
- Destructive contract: `confirm: z.boolean().optional().default(false)`; build honest `preview` (real
  name/IP, no fabricated numbers); `guardDestructive` BEFORE any side effect. `cleanup_waste`: `dry_run:
  z.boolean().default(true)`, dry_run wins over confirm.
- Tool `name` snake_case; description ≤15 tokens; NO emojis; NO AI/Claude/Anthropic/former-employer anywhere.
- `null-helpers.ts` for optional-field extraction; extract `server-mapper.ts` (used by ≥3 tools), inline single-use mappers.
- Tests: strict TDD (red→green→refactor→atomic commit). msw `setupServer` at client layer (`onUnhandledRequest:"error"`);
  stubbed client (`vi.fn().mockResolvedValue`) at tool layer. `beforeEach` saves/restores `HETZNER_API_TOKEN` +
  `HETZNER_PROJECT_ID` + **overrides `HOME` to a non-existent dir** (else loadCreds falls back to the real
  `.env`). Body tests `expect(body).toEqual({exact})`; field-strip `expect(Object.keys(result).sort()).toEqual([...])`.
  Fake timers for the action-waiter tests. Fixtures: `alpha-*`, `srv_1`, `vol_2`, `fw_3` — never real names.
- Conventional Commits: `feat(hetzner-smart):`, `test(hetzner-smart):`, etc. Atomic per task.

## Tool inventory (71)

| File | Tools (snake_case) | Notes |
|---|---|---|
| servers (6) | list_servers, get_server, create_server, update_server, delete_server*, get_server_metrics | list filters: status, name, label_selector, page/per_page |
| server-power (4) | power_on, power_off, reboot, reset* | wait-aware; reset* guarded (hard) |
| server-actions (4) | rebuild_server*, change_server_type*, create_snapshot, change_server_protection | rebuild/change_type guarded |
| ssh-keys (4) | list_ssh_keys, get_ssh_key, create_ssh_key, delete_ssh_key* | create synchronous (no action) |
| volumes (7) | list_volumes, get_volume, create_volume, delete_volume*, attach_volume, detach_volume, resize_volume | wait-aware mutations |
| firewalls (6) | list_firewalls, get_firewall, create_firewall, delete_firewall*, set_firewall_rules, apply_firewall | multi-action envelopes |
| networks (4) | list_networks, get_network, create_network, delete_network* | create synchronous |
| load-balancers (4) | list_load_balancers, get_load_balancer, create_load_balancer, delete_load_balancer* | |
| floating-ips (5) | list_floating_ips, create_floating_ip, delete_floating_ip*, assign_floating_ip, unassign_floating_ip | |
| primary-ips (5) | list_primary_ips, create_primary_ip, delete_primary_ip*, assign_primary_ip, unassign_primary_ip | mandatory/billable resource |
| certificates (3) | list_certificates, create_certificate, delete_certificate* | uploaded + managed |
| placement-groups (3) | list_placement_groups, create_placement_group, delete_placement_group* | |
| images (3) | list_images, get_image, delete_image* | no create (from snapshots) |
| catalog (5) | list_server_types, list_locations, list_datacenters, list_isos, get_pricing | read-only reference |
| actions (2) | get_action, wait_for_action | manual polling |
| shortcuts (6) | deploy_server, cheapest_server_type, estimate_cost, cost_audit, daily_status, cleanup_waste* | value-add |

`*` = `guardDestructive` gated. Total = 71 (6+4+4+4+7+6+4+4+5+5+3+3+3+5+2+6).

### Smart shortcut specs
- **deploy_server** `{ name, server_type?|min_cores?/min_memory?/arch?, location?, image="ubuntu-24.04", ssh_key?, quick_firewall?:bool (allow 22/80/443), user_data?, wait=true, confirm? }` → resolve type (explicit, else `cheapest_server_type` logic), optionally create+apply a quick firewall, create server, wait for `running`, return `{ server_id, name, ipv4, ipv6, status, type, monthly_cost_eur }`. Creative op (not destructive) but confirm-gate optional since it spends money.
- **cheapest_server_type** `{ min_cores?, min_memory?, arch?=x86, cpu_type?, location? }` → read `/server_types` + `/pricing`, filter, rank by monthly net EUR, return top matches `{ name, cores, memory, disk, arch, price_monthly_eur, location }`. Excludes deprecated types.
- **estimate_cost** `{ server_type, location?, volumes_gb?, primary_ipv4?=true, months?=1 }` → sum server + volume + primary-IP monthly net from `/pricing`. Return breakdown.
- **cost_audit** → auto-paginate all servers, join to `/pricing`, sum monthly net per running server. Return `{ total_monthly_eur, per_server:[...], stopped_but_charged:[...] }`.
- **daily_status** → snapshot: servers by status, volume/network/LB counts, unassigned floating/primary IPs, spend estimate.
- **cleanup_waste** `{ dry_run=true, confirm? }` → find stopped servers, unattached volumes, unassigned primary/floating IPs (all billable). dry_run returns candidates; non-dry_run + confirm deletes.

## Deferred (explicitly out of scope — additive later)
Trimmed from the first pass to hold the count near the chosen band (all cheap to add back): `remove_firewall`
(apply covers the common case), network `add_subnet`, `get_lb_metrics`, redundant `get_*` on floating-ips /
primary-ips / certificates / placement-groups (their `list_*` returns the full set), `list_actions`.
Also deferred: LB service/target CRUD, change_algorithm/type/attach-network; network routes + delete_subnet +
change_ip_range; server rescue/backup/iso-attach/dns-ptr/console/reset-password; floating/primary DNS-PTR +
protection; volume/image/network/LB/cert/floating/primary `change_protection` (only server protection shipped);
cert `retry`; DNS zones (~40 paths, separate concern); update_* on non-server resources; full auto-pagination
beyond the shortcut cap.

## Task breakdown (executable — TDD, atomic commit per task)

1. **Scaffold** — package.json / tsconfig.json / vitest.config.ts (verbatim from runpod, renamed), dirs, empty `tools/index.ts` exporting `[]`, `server.ts`, `context.ts`. `npm install` resolves workspace. Build + typecheck green. wire.test asserts `tools.length===0` placeholder. Commit.
2. **Client core + action layer** — `client.ts`: creds/constructor, http helpers, `extractAction`, `waitForAction`, error mapping. `client.test.ts`: msw for one list + one get (404) + one mutation returning `{action}` polled to success + a `status:error` throw + a timeout + HOME-override AuthError test + token_readonly + 423 mapping. Target ~30-40 tests. Commit.
3. **Catalog (read-only)** — `catalog.ts` (5 tools) + client methods (`listServerTypes/Locations/Datacenters/Isos`, `getPricing`). Tests: metadata, schema, mapping/field-strip. ~25 tests. Commit.
4. **null-helpers + server-mapper + servers CRUD** — `null-helpers.ts`, `server-mapper.ts` (SlimServer/mapServer), `servers.ts` (6). Wait-aware create/delete; delete guarded. ~45 tests. Commit.
5. **server-power + server-actions** — 8 tools, wait-aware, guards on reset/rebuild/change_type. ~40 tests. Commit.
6. **ssh-keys + volumes** — 11 tools (ssh synchronous; volume mutations wait-aware + guarded delete). ~45 tests. Commit.
7. **firewalls + networks** — 10 tools (firewall multi-action envelope handling; network synchronous create). ~42 tests. Commit.
8. **load-balancers + floating-ips + primary-ips** — 14 tools (assign/unassign wait-aware, guarded deletes). ~50 tests. Commit.
9. **certificates + placement-groups + images** — 9 tools. ~32 tests. Commit.
10. **actions tools** — get_action, wait_for_action. ~10 tests. Commit.
11. **shortcuts** — deploy.ts, pricing.ts, ops.ts, cleanup.ts (6 tools). Heaviest logic: type resolution, pricing joins, auto-paginate, dry_run. ~50 tests. Commit.
12. **wire + README + smoke + registration + live-e2e script** — finalize `tools/index.ts` (71 tools, wire.test: length/unique/snake_case/handler), README (required/optional vars, tool list, examples), `smoke` boots under stdio with a fake token, `scripts/live-e2e.mjs` (create cheapest → poll running → assert IP → delete, gated on real `HETZNER_API_TOKEN`). `npm test` green monorepo-wide. Register via `install-clients.sh hetzner-smart`. Commit + tag `phase-11-hetzner-smart`.

Estimated total: 71 tools, ~410-460 tests.

## Verification / done gates
- Unit: `npm test --workspace hetzner-smart` green; monorepo `npm test` green (no regressions).
- Build/typecheck clean; `chmod +x dist/server.js`.
- Smoke: `HETZNER_API_TOKEN=test_value timeout 3 node packages/hetzner-smart/dist/server.js < /dev/null` exits 0.
- Registration: `install-clients.sh` auto-discovers `packages/hetzner-smart/dist/server.js`.
- Live E2E (deferred to token availability): `node scripts/live-e2e.mjs` runs the real create→verify→destroy
  cycle on a cheapest server and self-cleans. This is the true E2E proof; documented in README.
- `.env`: user appends `HETZNER_API_TOKEN=...` (+ optional `HETZNER_PROJECT_ID=...`).
