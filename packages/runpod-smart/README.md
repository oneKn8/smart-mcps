# runpod-smart

MCP server for Runpod ops. Part of the [smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

MVP scaffold — tools coming in subsequent tasks.

## Planned tools

- `list_pods`
- `pod_status`
- `start_pod`
- `stop_pod`
- `terminate_pod`
- `list_templates`
- `launch_from_template`
- `list_endpoints`
- `endpoint_status`
- `billing_summary`
- `daily_status`
- `smart_pod`

## Setup

Required env var (used in later tasks):

```bash
export RUNPOD_API_KEY=<your_key>
```

## Build & test

From repo root:

```bash
npm install
npm run build --workspace=runpod-smart
npm test --workspace=runpod-smart
```
