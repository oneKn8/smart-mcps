# runpod-smart

MCP server for Runpod GPU compute ops. Part of the [smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

## Tools

| Name | Type | Summary | Sample input |
|---|---|---|---|
| `list_pods` | read | List Runpod pods, optionally filtered by status | `{ "status": "RUNNING" }` |
| `get_pod` | read | Get full details for a single pod | `{ "pod_id": "abc123" }` |
| `start_pod` | DESTRUCTIVE | Resume a stopped pod (incurs GPU billing) | `{ "pod_id": "abc123", "confirm": true }` |
| `stop_pod` | DESTRUCTIVE | Stop a running pod (volume retained, GPU billing stops) | `{ "pod_id": "abc123", "confirm": true }` |
| `terminate_pod` | DESTRUCTIVE | PERMANENTLY DELETE a pod and its container disk | `{ "pod_id": "abc123", "confirm": true }` |
| `launch_pod` | DESTRUCTIVE | Create a new pod from an image + GPU type | `{ "name": "train-1", "image_name": "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04", "gpu_type_id": "NVIDIA GeForce RTX 4090", "confirm": true }` |
| `list_templates` | read | List pod templates available on the account | `{}` |
| `list_endpoints` | read | List serverless endpoints | `{}` |
| `cost_audit` | read | Billing breakdown over the last N days | `{ "days": 7 }` |
| `daily_status` | read | 24h fleet snapshot — running pods, recent spend, idle candidates | `{ "hours": 24 }` |
| `spin_training_pod` | DESTRUCTIVE | One-shot launcher for a training pod (framework + cuda preset) | `{ "name": "ft-llama", "framework": "pytorch", "cuda": "12.4", "gpu_type_id": "NVIDIA GeForce RTX 4090", "confirm": true }` |
| `kill_idle_pods` | DESTRUCTIVE | Stop pods whose `lastStartedAt` is older than N hours | `{ "older_than_hours": 24, "dry_run": true }` |

All DESTRUCTIVE tools require `confirm: true`. `terminate_pod` is irreversible — the pod row, container disk, and any non-network-volume data are deleted.

`kill_idle_pods` defaults to `dry_run: true`. Pass `dry_run: false` to actually stop pods.

## Setup

Required env var:

```bash
export RUNPOD_API_KEY=<your_key>
```

Optional default GPU type used by `launch_pod` / `spin_training_pod` when `gpu_type_id` is omitted:

```bash
export RUNPOD_DEFAULT_GPU="NVIDIA GeForce RTX 4090"
```

To create an API key: Runpod console -> Settings -> API Keys -> Create. https://www.runpod.io/console/user/settings

Where to put env vars:

- `~/.config/smart-mcps/.env` (loaded by the install workflow), or
- export in the shell that launches your MCP client.

## Install in MCP clients

Build the workspace, then run the multi-client installer from the repo root:

```bash
npm install
npm run build
./scripts/install-clients.sh runpod-smart
```

The installer registers `runpod-smart` in Claude Code (`~/.claude.json`), Cursor (`~/.cursor/mcp.json`), and prints a Codex config snippet for `~/.codex/config.toml`. It auto-discovers any `packages/*/dist/server.js`, so newly built MCPs in this monorepo are picked up without script changes.

> Note: the installer wires `command: "node"` + the absolute path to `dist/server.js`. It does NOT inject env vars. You must export `RUNPOD_API_KEY` (and optionally `RUNPOD_DEFAULT_GPU`) in the shell that launches your MCP client, or hand-edit the registered server entry to add an `env` block.

## Build & test

From repo root:

```bash
npm install
npm run build --workspace=runpod-smart
npm test --workspace=runpod-smart
```

Or against the whole monorepo:

```bash
npm run build
npm test
```

Smoke test (requires real `RUNPOD_API_KEY`):

```bash
export RUNPOD_API_KEY=...
node packages/runpod-smart/dist/server.js < /dev/null
```

The server runs over stdio and waits for MCP protocol messages. With `</dev/null` it should boot, find no input, and exit cleanly.

## Notes

- Per-pod cost breakdown via `cost_audit` requires the Runpod billing API to return ungrouped records. The default response is grouped by GPU type, so the `top_pods` field may be empty until ungrouped data is available.
- `kill_idle_pods` uses `lastStartedAt` as a proxy for idleness — actual GPU utilization detection requires Runpod's Python SDK (out of scope for the MVP).
- `spin_training_pod` image tags are best-guess based on Runpod's published tag patterns. If a tag has drifted, fall back to `launch_pod` with an explicit `image_name`.
