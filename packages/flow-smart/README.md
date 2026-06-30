# flow-smart

Thin cross-app orchestrator MCP. Owns no API code of its own; each tool is glue over the sibling client classes (`TasksClient`, `DocsClient`, `AppsScriptClient`, `CalendarClient`, `EmailClient`), imported in-process via their `./client` subpath exports. Reuses the sibling token jars (`<account>.tasks.json`, `.docs.json`, `.script.json`, `.calendar.json`, and email-smart's `<account>.json`) — it has no auth CLI of its own. Part of the [smart-mcps](../../README.md) monorepo; built on `smart-mcp-core`.

Tools: TBD (skeleton). Planned: `email_to_task`, `task_to_calendar_block`, `weekly_review_doc`, `inbox_digest_doc`, `daily_brief_doc`, `deploy_inbox_watcher`.

## Setup

flow-smart needs the sibling MCPs built and their tokens minted (run each sibling's `*-auth` CLI). No separate consent step is required for flow-smart itself. Build:

```bash
npm run build --workspace=flow-smart
```

Default account `your-account`; override with `FLOW_DEFAULT_IDENTITY` in `~/.config/smart-mcps/.env`.
