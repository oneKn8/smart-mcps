# Phase 7 design: tasks-smart, docs-smart, apps-script-smart, flow-smart

Date: 2026-06-30
Status: approved (design), build in progress (autonomous, subagent-driven)

Adds three Google-API MCP wrappers plus a thin cross-app orchestrator to the
`smart-mcps` toolbelt. Decisions locked with the user:

- **Ambition: most-ambitious, B-staged.** Ship three clean wrappers first
  (a strict subset and a clean checkpoint), then layer `flow-smart` on top.
- **Apps Script: 2a (full), including `scripts.run`** — but hard-gated
  (`confirm` + exact function/args preview), never on an auto-approve list.
- **Docs coverage: curated-plus-escape-hatch** — full read/create + the
  high-value `batchUpdate` edits + a markdown renderer + a raw `batch_update`
  passthrough. Not a 1:1 mirror of all 40 request kinds.

Verified API references (read these before implementing a package):

- `docs/research/2026-06-30-tasks-api-reference.md`
- `docs/research/2026-06-30-docs-api-reference.md`
- `docs/research/2026-06-30-apps-script-api-reference.md`

All conventions are inherited from the monorepo `CLAUDE.md` and the
`calendar-smart` package (the canonical Google-API template). This doc only
records what is *new* or *non-obvious*; it does not restate conventions.

---

## 1. Architecture

Four new workspaces. Three are standard `*-smart` Google-API wrappers built to
the `calendar-smart` bar; the fourth is a thin orchestrator.

```
packages/
  tasks-smart/        # Google Tasks v1   (tasks.googleapis.com/tasks/v1)
  docs-smart/         # Google Docs v1    (docs.googleapis.com/v1)
  apps-script-smart/  # Apps Script v1    (script.googleapis.com/v1)
  flow-smart/         # orchestrator: imports sibling client classes
```

Each wrapper reuses `smart-mcp-core` verbatim: `GoogleOAuthClient` (token jar
at `~/.santo-agent/oauth/<account><suffix>.json`), `fetchJson`, `defineTool`,
`createMcpServer`, `guardDestructive`, the error hierarchy. No new auth code.
Raw REST via `fetchJson` — no `googleapis` npm package (repo convention).

Per-MCP token file suffix (so tokens never collide):

| Package | fileSuffix | Required scope(s) |
| --- | --- | --- |
| tasks-smart | `.tasks.json` | `https://www.googleapis.com/auth/tasks` |
| docs-smart | `.docs.json` | `https://www.googleapis.com/auth/documents` + `https://www.googleapis.com/auth/drive.file` |
| apps-script-smart | `.script.json` | `script.projects` + `script.deployments` + `script.processes` + `script.metrics` (+ runtime scopes for `scripts.run`) |
| flow-smart | reuses siblings | union of the above + calendar + gmail.modify |

### flow-smart import boundary (the one structural decision)

`flow-smart` runs as its own MCP server but imports the **client classes** of
the sibling packages directly (in-process), not their MCP servers. To expose a
client without exposing the server entry, every wrapper adds a subpath export:

```jsonc
// package.json of each wrapper
"exports": {
  ".":        { "types": "./dist/server.d.ts",  "import": "./dist/server.js" },
  "./client": { "types": "./dist/client.d.ts",  "import": "./dist/client.js" }
}
```

`flow-smart` then does `import { TasksClient } from "tasks-smart/client"`, etc.

**Required additive change to two existing packages:** add the same `./client`
subpath export to `calendar-smart` and `email-smart` so `flow-smart` can import
`CalendarClient` and `EmailClient`. This is additive only (no behavior change,
no break to the `.` server entry) and must not touch their internals otherwise.

---

## 2. Package: tasks-smart (~16 tools)

Tasks API is small; we take 100% coverage plus three local-bucketing shortcuts.

Tools: `list_task_lists`, `get_task_list`, `create_task_list`,
`update_task_list`, `delete_task_list`, `list_tasks`, `get_task`,
`create_task`, `update_task`, `complete_task`, `delete_task`, `move_task`,
`clear_completed`, `today_tasks`, `overdue_tasks`, `quick_add`.

Slim shapes: `SlimTaskList`, `SlimTask` (mappers + `null-helpers`).

Critical correctness notes (from the reference):

- **`due` is date-only.** The API discards the time portion and stores UTC
  midnight. `today_tasks` / `overdue_tasks` must bucket **client-side**: compute
  the user's local date, map to the UTC-midnight the API stores, and compare
  against `due` + `status`. Use `dueMin`/`dueMax` only to trim payload, never as
  the source of truth, and never surface a time-of-day for a due date.
- **`move_task`** uses query params `parent` (omit = top level), `previous`
  (omit = first sibling), `destinationTasklist` (cross-list). `position` is
  server-managed and not writable — reorder via `move`, not by setting position.
  Reject the documented impossible moves (recurring across lists; assigned tasks
  as parent/child) with a clear message rather than passing them through.
- **`clear_completed`** hides (not deletes) completed tasks; they reappear only
  with `showHidden=true`. The tool description must say "hide", not "delete".
- Destructive tools (`delete_task_list`, `delete_task`, `clear_completed`) use
  `guardDestructive` with a preview naming the list/task.

---

## 3. Package: docs-smart (~18 tools)

docs.googleapis.com/v1. One resource (`documents`), three raw methods
(`get`, `create`, `batchUpdate`). We expose ergonomic tools over `batchUpdate`
plus a markdown renderer and a raw passthrough.

Tools: `get_document`, `read_text`, `create_document`, `insert_text`,
`delete_range`, `replace_all_text`, `set_text_style`, `set_paragraph_style`,
`set_heading`, `make_bullets`, `remove_bullets`, `insert_table`, `fill_table`,
`insert_image`, `insert_page_break`, `append_text`, `create_doc_from_markdown`
(flagship), `batch_update` (raw escape hatch — accepts any of the 40 request
kinds verbatim and forwards them).

### THE gotcha: index shifting (this is where a careless build corrupts output)

Indexes are zero-based UTF-16 offsets and **renumber after every insert/delete
within a batch** (requests apply sequentially). A `get` snapshot's indexes are
stale the moment the first mutating request lands. Every multi-edit path MUST
either:

1. insert all text first, then apply styles by **ranges recorded against the
   final layout**, or
2. emit mutations in **descending index order** ("write backwards" — Google's
   own recommendation).

`create_doc_from_markdown` builds bottom-up / records ranges as it appends; it
is the most error-prone tool and gets the most test coverage (headings, bold,
italic, bullets, nested lists, a table, and a mixed document round-tripped back
through `read_text` to assert the rendered structure).

Other hard rules baked into the client:

- `create` is **title-only** — all other fields are ignored. Always
  create-then-`batchUpdate`.
- Every `update*Style` request **requires a `fields` mask** (comma-separated
  camelCase paths). Omitting it is a silent no-op or a reset. Each style tool
  builds the mask from exactly the fields the caller set.
- Never insert at a table's start index; never delete a segment's final
  newline. Validate and reject with a clear error.
- `read_text` walks `body.content -> paragraph -> elements -> textRun.content`.
- Rate ceiling is **60 writes/min/user** — `fetchJson`'s 429 backoff covers it;
  don't add client-side throttling, but note it in the README.

---

## 4. Package: apps-script-smart (~17 tools)

script.googleapis.com/v1. Full project/version/deployment/process management
plus the gated `run_function`.

Tools: `create_project`, `get_project`, `get_content`, `update_content`,
`push_file` (safe read-modify-write wrapper, see below), `get_metrics`,
`create_version`, `list_versions`, `get_version`, `create_deployment`,
`list_deployments`, `get_deployment`, `update_deployment`, `delete_deployment`,
`list_processes`, `deploy_script` (convenience: create_version + create_deployment
in one call), `run_function` (gated `scripts.run`).

Critical correctness + safety notes:

- **`update_content` is a full overwrite** of the entire `files[]` array,
  including the mandatory `appsscript` JSON manifest. Naively calling it drops
  every file you didn't re-send. `push_file` is the safe path: `get_content` →
  splice/replace one file by name (re-including the manifest) → `update_content`.
  The README warns that raw `update_content` clobbers.
- **`run_function` (`scripts.run`) is the loaded gun:**
  - It is arbitrary remote code execution as the user with broad Google scopes.
    `guardDestructive` is mandatory: `confirm` required, and the preview shows
    the exact `{deploymentId/scriptId, function, parameters, devMode}`. It is
    documented as never belonging on an auto-approve allowlist.
  - **HTTP 200 lies.** A script-side exception returns 200 with the failure in
    `body.error` (`errorType`, `errorMessage`, `scriptStackTraceElements`). The
    client MUST parse `body.error` BEFORE treating the response as success, and
    surface the script stack trace as an `UpstreamError`.
  - Requires the painful one-time setup (standard GCP project, API-Executable
    deployment, calling token carrying every scope the script uses). The tool
    returns a precise, actionable error when the setup is missing (401/403),
    pointing at the README setup section — it does not swallow it as a generic
    auth failure.
- **Triggers cannot be created via the API.** Only `ScriptApp.newTrigger(...)`
  inside the script can, and it must run once to install. `apps-script-smart`
  never claims to create triggers; `flow-smart`'s watcher works around this (see
  below).
- No service accounts — standard 3-legged OAuth + refresh, same as the others.

---

## 5. Package: flow-smart (~6 tools) — the orchestrator

Thin. Each tool is glue over already-built sibling clients; it owns no API code,
no storage, no state. Imports `TasksClient`, `DocsClient`, `AppsScriptClient`,
`CalendarClient`, `EmailClient` via the `./client` subpath exports.

Tools:

1. `email_to_task` — Gmail thread → Task (title from subject, notes from a
   short snippet summary, optional `due`). `EmailClient` + `TasksClient`.
2. `task_to_calendar_block` — schedule a task as a timed calendar block on a
   chosen day. `TasksClient` + `CalendarClient`.
3. `weekly_review_doc` — read this week's completed/open tasks + calendar
   events, render a formatted Google Doc via `create_doc_from_markdown`.
   `TasksClient` + `CalendarClient` + `DocsClient`. (flagship)
4. `inbox_digest_doc` — summarize N recent unread threads into a Doc.
   `EmailClient` + `DocsClient`.
5. `daily_brief_doc` — today's agenda + due/overdue tasks → a one-page Doc.
   `CalendarClient` + `TasksClient` + `DocsClient`.
6. `deploy_inbox_watcher` — write + version + deploy an Apps Script that, on a
   self-installed time trigger, polls Gmail and files Tasks while the user is
   offline. `AppsScriptClient`. Honest limitation surfaced in the result: the
   API cannot install the trigger; the generated script self-installs it on its
   first manual run, and the tool returns the exact next manual step. This is
   the most ambitious tool and is allowed to ship as "scaffolds + deploys, one
   manual first-run to arm the trigger."

Error propagation: if any underlying client throws, `flow-smart` surfaces which
step failed (e.g. "created the task but calendar block failed: <reason>") rather
than a bare error — partial-progress honesty is part of the contract.

---

## 6. Build plan (subagent-driven, autonomous)

Order and parallelism:

1. **Foundation (lead, in-context):** scaffold all four packages (package.json,
   tsconfig referencing core, vitest.config, empty src skeleton, README stub),
   add the `./client` subpath export to the two existing packages, one root
   `npm install`, confirm empty skeletons build. Commit as the scaffold.
2. **Wrappers in parallel:** one implementer per package — `tasks-smart`,
   `docs-smart`, `apps-script-smart`. Each: strict TDD (red → green per tool
   area), reads its research doc + `calendar-smart` as the template + its
   section of this spec. Returns only when `npm test --workspace=<pkg>` and
   `tsc --noEmit` are green and `smoke` passes. They edit only their own package
   dir; they do NOT run root `npm install` and do NOT commit (lead owns git).
3. **flow-smart** after the three wrappers expose stable clients. Same TDD bar.
4. **Cross-verify / pressure test:** an adversarial reviewer per package, each
   tasked to break it — focused on: Docs index-shifting correctness, Apps Script
   `scripts.run` gating + HTTP-200-error parsing + `update_content` clobber,
   Tasks date-only bucketing + move-rejection, flow-smart partial-failure
   honesty, and every wire test (count / snake_case / unique / ≤15-token desc).
   Lead then inspects the real critical files (not agent summaries) and runs the
   full monorepo `npm test` + `npm run typecheck` + every `smoke`.
5. **Register + handoff:** `install-clients.sh` for the four packages, write the
   handoff note (enable 3 APIs in GCP, run the four auth CLIs, restart), update
   the monorepo memory. Lead builds the clean atomic commit history.

### Done definition (all four packages)

Behavior exists in code, integrated, unit/typecheck/boot-verified, and
adversarially cross-verified. **Not** live-API verified — that needs the user's
one-time OAuth consent for the new scopes (their manual morning step, per the
repo's existing tagging discipline). The result is labeled honestly as such; no
"working"/"done" claim is made about live behavior, and `scripts.run` is
explicitly only static-verified (its GCP setup is the user's).

### Out of scope (deferred, logged here so it is not silently dropped)

- Live integration tests against the real Google APIs (blocked on user OAuth).
- Apps Script trigger creation (API cannot; documented limitation).
- Docs: full 1:1 mirror of all 40 `batchUpdate` request kinds beyond the raw
  passthrough.
- `git push` / any GitHub action (waits for the user).
