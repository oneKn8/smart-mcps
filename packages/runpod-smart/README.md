# runpod-smart

MCP server for Runpod GPU compute ops — the complete control surface. Part of the [smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

**43 tools** spanning three Runpod hosts, all authenticated with a single `RUNPOD_API_KEY`:

- **REST** (`rest.runpod.io/v1`) — pods, templates, serverless endpoints, network volumes, container-registry auth, billing.
- **Serverless inference** (`api.runpod.ai/v2/{endpointId}`) — submit/poll/cancel jobs, queue + worker health.
- **GraphQL** (`api.runpod.io/graphql`) — the only surface exposing GPU pricing and account balance.

Read-only tools take no `confirm`. Every write / destructive / cost-incurring tool requires `confirm: true` and returns a `preview` first.

## Tools

### Pods
| Name | Type | Summary | Sample input |
|---|---|---|---|
| `list_pods` | read | List pods, optionally filtered by status | `{ "status": "RUNNING" }` |
| `get_pod` | read | Get a single pod by ID | `{ "pod_id": "pod_abc" }` |
| `launch_pod` | DESTRUCTIVE | Create a pod from an image + GPU type | `{ "name": "train-1", "image": "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04", "gpu": "NVIDIA GeForce RTX 4090", "confirm": true }` |
| `update_pod` | DESTRUCTIVE | Update a pod's config (image, disk, env, ports) | `{ "pod_id": "pod_abc", "container_disk_gb": 80, "confirm": true }` |
| `start_pod` | DESTRUCTIVE | Resume a stopped pod (GPU billing resumes) | `{ "pod_id": "pod_abc", "confirm": true }` |
| `stop_pod` | DESTRUCTIVE | Stop a running pod (volume retained) | `{ "pod_id": "pod_abc", "confirm": true }` |
| `restart_pod` | DESTRUCTIVE | Restart a running pod | `{ "pod_id": "pod_abc", "confirm": true }` |
| `reset_pod` | DESTRUCTIVE | Reset a pod to a clean state | `{ "pod_id": "pod_abc", "confirm": true }` |
| `terminate_pod` | DESTRUCTIVE | Permanently delete a pod and its container disk | `{ "pod_id": "pod_abc", "confirm": true }` |

### Templates
| Name | Type | Summary | Sample input |
|---|---|---|---|
| `list_templates` | read | List account templates | `{}` |
| `get_template` | read | Get a template by ID | `{ "template_id": "tpl_1" }` |
| `create_template` | DESTRUCTIVE | Create a reusable pod/serverless template | `{ "name": "vllm", "image": "runpod/vllm:latest", "is_serverless": true, "confirm": true }` |
| `update_template` | DESTRUCTIVE | Update a template | `{ "template_id": "tpl_1", "container_disk_gb": 60, "confirm": true }` |
| `delete_template` | DESTRUCTIVE | Delete a template | `{ "template_id": "tpl_1", "confirm": true }` |

### Serverless endpoints (config)
| Name | Type | Summary | Sample input |
|---|---|---|---|
| `list_endpoints` | read | List serverless endpoints | `{}` |
| `get_endpoint` | read | Get an endpoint by ID | `{ "endpoint_id": "ep_1", "include_workers": true }` |
| `create_endpoint` | DESTRUCTIVE | Create a serverless endpoint from a template | `{ "template_id": "tpl_1", "name": "llama", "workers_max": 3, "confirm": true }` |
| `update_endpoint` | DESTRUCTIVE | Update endpoint scaling/config | `{ "endpoint_id": "ep_1", "workers_max": 5, "confirm": true }` |
| `delete_endpoint` | DESTRUCTIVE | Delete a serverless endpoint | `{ "endpoint_id": "ep_1", "confirm": true }` |

### Network volumes
| Name | Type | Summary | Sample input |
|---|---|---|---|
| `list_network_volumes` | read | List network volumes | `{}` |
| `get_network_volume` | read | Get a network volume by ID | `{ "volume_id": "nv_1" }` |
| `create_network_volume` | DESTRUCTIVE | Create a network volume | `{ "name": "data", "size_gb": 100, "data_center_id": "EU-RO-1", "confirm": true }` |
| `update_network_volume` | DESTRUCTIVE | Rename or grow a volume (size only increases) | `{ "volume_id": "nv_1", "size_gb": 200, "confirm": true }` |
| `delete_network_volume` | DESTRUCTIVE | Delete a network volume (data lost) | `{ "volume_id": "nv_1", "confirm": true }` |

### Container registry auth
Credentials for private image registries. `create_registry_auth` takes a `password`, which is **never** echoed in previews, output, or logs — the upstream response returns only `{ id, name }`.

| Name | Type | Summary | Sample input |
|---|---|---|---|
| `list_registry_auths` | read | List registry credentials | `{}` |
| `get_registry_auth` | read | Get a registry credential by ID | `{ "auth_id": "cra_1" }` |
| `create_registry_auth` | DESTRUCTIVE | Store private registry credentials | `{ "name": "dockerhub", "username": "me", "password": "***", "confirm": true }` |
| `delete_registry_auth` | DESTRUCTIVE | Delete a registry credential | `{ "auth_id": "cra_1", "confirm": true }` |

### Serverless inference (`api.runpod.ai/v2`)
| Name | Type | Summary | Sample input |
|---|---|---|---|
| `run_endpoint` | DESTRUCTIVE | Submit an async job (incurs compute cost) | `{ "endpoint_id": "ep_1", "input": { "prompt": "hi" }, "confirm": true }` |
| `run_sync` | DESTRUCTIVE | Run a job and wait for the result | `{ "endpoint_id": "ep_1", "input": { "prompt": "hi" }, "confirm": true }` |
| `get_job_status` | read | Check a job's status/output | `{ "endpoint_id": "ep_1", "job_id": "job_1" }` |
| `cancel_job` | DESTRUCTIVE | Cancel a queued/running job | `{ "endpoint_id": "ep_1", "job_id": "job_1", "confirm": true }` |
| `endpoint_health` | read | Queue + worker health | `{ "endpoint_id": "ep_1" }` |
| `purge_queue` | DESTRUCTIVE | Purge all queued jobs | `{ "endpoint_id": "ep_1", "confirm": true }` |

### GPU pricing + account (GraphQL)
| Name | Type | Summary | Sample input |
|---|---|---|---|
| `list_gpu_types` | read | List GPU types with availability + pricing | `{ "min_vram_gb": 80, "cloud": "SECURE" }` |
| `cheapest_gpu` | read | Cheapest GPU matching VRAM/cloud filters | `{ "min_vram_gb": 80, "name_contains": "H100" }` |
| `estimate_cost` | read | Estimate pod cost before launch | `{ "gpu": "NVIDIA H100 PCIe", "hours": 10 }` |
| `account_summary` | read | Balance, burn rate, and runway | `{}` |

### Analytics + smart shortcuts
| Name | Type | Summary | Sample input |
|---|---|---|---|
| `cost_audit` | read | Spend breakdown over the last N days | `{ "days": 7 }` |
| `daily_status` | read | Active pods + recent spend + flagged | `{ "hours": 24 }` |
| `spin_training_pod` | DESTRUCTIVE | Preset training-pod launcher (framework + cuda) | `{ "name": "ft-llama", "framework": "pytorch", "cuda": "12.4", "confirm": true }` |
| `kill_idle_pods` | DESTRUCTIVE | Stop pods idle > N hours (dry-run by default) | `{ "older_than_hours": 24, "dry_run": true }` |
| `deploy_serverless` | DESTRUCTIVE | Create a template + serverless endpoint together | `{ "name": "llama", "image": "runpod/vllm:latest", "workers_max": 3, "confirm": true }` |

`cheapest_gpu` subsumes the classic "cheapest H100" query: pass `name_contains: "H100"` or `min_vram_gb: 80`. `estimate_cost` never fabricates a price — if the GPU isn't in the live pricing table it returns `price_per_hr: null` with an honest note.

## Setup

Required env var:

```bash
export RUNPOD_API_KEY=<your_key>
```

Optional default GPU type used by `launch_pod` / `spin_training_pod` / `estimate_cost` when `gpu` is omitted:

```bash
export RUNPOD_DEFAULT_GPU="NVIDIA GeForce RTX 4090"
```

To create an API key: Runpod console -> Settings -> API Keys -> Create. https://www.runpod.io/console/user/settings

Where to put env vars:

- `~/.config/smart-mcps/.env` (loaded by the install workflow), or
- export in the shell that launches your MCP client.

## Install in MCP clients

```bash
npm install
npm run build
./scripts/install-clients.sh runpod-smart
```

The installer registers `runpod-smart` in Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), and prints a Codex config snippet for `~/.codex/config.toml`. It auto-discovers any `packages/*/dist/server.js`. It wires `command: "node"` + the absolute path to `dist/server.js` and does NOT inject env vars — export `RUNPOD_API_KEY` in the launching shell or add an `env` block to the registered entry.

## Build & test

```bash
npm run build --workspace=runpod-smart
npm test --workspace=runpod-smart
```

Smoke test (boots under stdio, exits cleanly with no input):

```bash
RUNPOD_API_KEY=test_value node packages/runpod-smart/dist/server.js < /dev/null
```

## Notes

- **Pricing + balance are GraphQL-only.** Runpod's REST API exposes no pricing table, so `list_gpu_types`, `cheapest_gpu`, `estimate_cost`, and `account_summary` query `api.runpod.io/graphql`. That endpoint returns HTTP 200 even on query errors (failures live under `body.errors`); the client detects this and raises `AuthError` / `UpstreamError`.
- **Registry passwords are write-only.** `create_registry_auth` forwards the password to Runpod but never surfaces it in any preview, output, error, or log.
- Per-pod cost breakdown via `cost_audit` requires ungrouped billing records; Runpod's default response is grouped by GPU type, so `top_pods` may be empty until ungrouped data is available.
- `kill_idle_pods` uses `lastStartedAt` as an idleness proxy — REST exposes no live GPU utilization.
- `spin_training_pod` image tags follow Runpod's published tag patterns. If a tag has drifted, fall back to `launch_pod` with an explicit `image`.
- Network volume size can only **increase** — `update_network_volume` cannot shrink a volume.
