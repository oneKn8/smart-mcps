# hetzner-smart

Smart MCP server for [Hetzner Cloud](https://docs.hetzner.cloud/). 71 tools across servers, volumes,
networks, firewalls, load balancers, floating + primary IPs, certificates, placement groups, images,
SSH keys, the read-only catalog (server types, locations, datacenters, ISOs, pricing), the async action
layer, and six composed ops shortcuts.

Part of the `smart-mcps` monorepo. Personal toolbelt, not affiliated with any vendor.

## Credentials

One shared file: `~/.config/smart-mcps/.env` (chmod 600). Append:

```
HETZNER_API_TOKEN=<your 64-char project API token>   # required
HETZNER_PROJECT_ID=<project id>                        # optional, informational only
```

Create the token in the Hetzner Cloud Console: pick the Project, then `Security` -> `API Tokens` ->
generate with **Read & Write** permission (a Read-only token can list but not mutate; mutating calls
return a clear "token is read-only" error). A token is bound to one Project.

The token is resolved by `smart-mcp-core`'s `loadCreds` (env -> shared `.env` -> per-service JSON) and is
never stored in MCP client config. The server fails fast at startup if the token is missing.

## The async Action model

Most Hetzner mutations (create server, power on/off, attach volume, resize, rebuild, assign IP) are
**asynchronous**: the API returns an Action object that you poll to `success`/`error`. Every mutating
tool here is **wait-aware**:

- `wait: true` (default) — the tool polls the action to completion (bounded, with backoff) and returns
  the settled result (e.g. `create_server` re-fetches the server so you get its live IP).
- `wait: false` — the tool returns immediately with `{ action_id, status: "running" }` for long ops.

Standalone `get_action` and `wait_for_action` let you poll manually.

## Safety

Destructive tools (`delete_*`, `reset`, `rebuild_server`, `change_server_type`, and the delete path of
`cleanup_waste`) require `confirm: true`; without it they return a preview of exactly what would happen
and make no change. `cleanup_waste` defaults to `dry_run: true`. Hetzner resource protection is honored:
a protected delete/rebuild returns a "disable protection first" message.

## Tools (71)

**Servers** — `list_servers`, `get_server`, `create_server`, `update_server`, `delete_server`,
`get_server_metrics`, `power_on`, `power_off`, `reboot`, `reset`, `rebuild_server`, `change_server_type`,
`create_snapshot`, `change_server_protection`

**SSH keys** — `list_ssh_keys`, `get_ssh_key`, `create_ssh_key`, `delete_ssh_key`

**Volumes** — `list_volumes`, `get_volume`, `create_volume`, `delete_volume`, `attach_volume`,
`detach_volume`, `resize_volume`

**Firewalls** — `list_firewalls`, `get_firewall`, `create_firewall`, `delete_firewall`,
`set_firewall_rules`, `apply_firewall`

**Networks** — `list_networks`, `get_network`, `create_network`, `delete_network`

**Load balancers** — `list_load_balancers`, `get_load_balancer`, `create_load_balancer`,
`delete_load_balancer`

**Floating IPs** — `list_floating_ips`, `create_floating_ip`, `delete_floating_ip`, `assign_floating_ip`,
`unassign_floating_ip`

**Primary IPs** — `list_primary_ips`, `create_primary_ip`, `delete_primary_ip`, `assign_primary_ip`,
`unassign_primary_ip`

**Certificates** — `list_certificates`, `create_certificate`, `delete_certificate`

**Placement groups** — `list_placement_groups`, `create_placement_group`, `delete_placement_group`

**Images** — `list_images`, `get_image`, `delete_image`

**Catalog (read-only)** — `list_server_types`, `list_locations`, `list_datacenters`, `list_isos`,
`get_pricing`

**Actions** — `get_action`, `wait_for_action`

**Smart shortcuts** — `deploy_server` (one-shot: resolve type/cheapest, optional quick-firewall +
cloud-init, create, wait, return IP), `cheapest_server_type` (rank types by live EUR price),
`estimate_cost` (project monthly cost of a spec), `cost_audit` (running servers x price -> monthly
projection), `daily_status` (account snapshot), `cleanup_waste` (find billable waste: stopped servers,
unattached volumes, unassigned IPs; `dry_run` first)

## Live end-to-end check

With a Read & Write token in place and the package built, run the real create -> verify -> destroy cycle
(provisions the cheapest x86 shared server, confirms it reaches `running` with an IPv4, then deletes it;
self-cleans in a `finally` block so nothing is leaked):

```bash
npm run build --workspace hetzner-smart
node scripts/live-e2e-hetzner.mjs
```

Costs a few cents of runtime. Exit 0 means the full cycle is verified.

## Build & test

```bash
npm run build --workspace hetzner-smart
npm test --workspace hetzner-smart
npm run typecheck --workspace hetzner-smart
HETZNER_API_TOKEN=test_value timeout 3 node packages/hetzner-smart/dist/server.js < /dev/null   # smoke
```
