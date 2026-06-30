# Phase 7 build journal (autonomous overnight run)

Live state for the tasks/docs/apps-script/flow build. Updated at each checkpoint
so a restarted session can resume. Design contract:
`docs/2026-06-30-phase-7-tasks-docs-script-flow-design.md`.

Branch: `phase-7-google-trio-flow` (off `main`). No push until user approves.

## State machine

- [x] Research verified (3 docs in `docs/research/2026-06-30-*-api-reference.md`)
- [x] Design spec written + committed
- [x] Branch created, research + design committed (2 commits)
- [x] Scaffold 4 packages + `./client` exports on calendar/email + install/build/typecheck green
- [x] Implement tasks-smart (16 tools, 92 tests) — verified green + date-bucket inspected, committed
- [x] Implement docs-smart (18 tools, 125 tests) — verified green + 3-phase renderer inspected, committed
- [x] Implement apps-script-smart (17 tools, 86 tests) — verified green + run_function gating/error-parse inspected, committed
- [x] Implement flow-smart (6 tools, 50 tests) — verified green + error-prop/watcher inspected, committed
- [x] Adversarial cross-verify each package + lead inspects critical real code (4 reviewers, all findings fixed)
  - Full monorepo test GREEN: 13 workspaces, 2398 tests, 0 regressions. New: tasks 92, apps-script 86, docs 125, flow 50.
  - Pressure-test findings (verified in real code), fix agents running:
    - apps-script: RCE gate SOUND. Fixed + committed (86->93 tests): push_file (name,type) match; update_deployment gate+RMW-preserve-pin; runFunction require done+response; vacuous test.
    - tasks: bucket MATH sound. Fixed + committed (92->105 tests): paginate today/overdue + list scan; widen today dueMin; honest recurring test; validate due date.
    - docs: text/style sound. Fixed + committed (125->142 tests): consecutive-table insertIndex collision (separating newline + loud distinct-index guard); tables_filled count; batch_update caveat; cell-newline delete guard.
    - flow: sibling calls/account/partial-failure CLEAN. Fixed + committed (50->57 tests): paginate task gather; weekly window upper bound; time.ts DST two-pass (date-preserving); escape snippet/query injection.

## FINAL STATE (build + cross-verify COMPLETE)

- Full monorepo: 2442 tests pass, typecheck clean, all 4 servers boot. Tool totals: tasks 16, docs 18, apps-script 17, flow 6 = 57 tools.
- 13 commits on `phase-7-google-trio-flow` (research -> design -> scaffold -> 4 feat -> renderer refactor -> 4 fix). NOT pushed (awaiting Santo).
- Registered in ~/.claude.json (tasks/docs/apps-script/flow). Effective on next Claude Code restart.

## LIVE-VERIFIED 2026-06-30 ~10:46 CDT (client layer)
- All 3 tokens minted for your-account (.tasks/.docs/.script.json) via the auth CLIs.
- Read-only live smoke through the REAL client code passed: tasks.listTaskLists -> "My Tasks";
  docs.getDocument(fake) -> 404 (auth+scope OK); appsScript.listProcesses -> OK (0). No data created.
- DEEP live E2E (create-verify-DELETE, self-cleaning, no debris):
  - docs flagship `renderMarkdownToNewDoc` with the CRITICAL 2-consecutive-table case rendered
    against LIVE Google Docs: headings/bold/bullets present, exactly 2 tables, both grids' cells
    correct ([[a,b,c],[d,e,f]] and [[x,y],[1,2]]). Doc deleted (204). Table-collision fix PROVEN live.
  - flow orchestrator `daily_brief_doc` composed live Calendar + Tasks -> rendered Doc (233 chars),
    deleted (204). Cross-app orchestration thesis PROVEN live.
  - (apps-script WRITE lifecycle intentionally NOT live-tested: a created script project may not be
    deletable via drive.file, and I won't leave un-cleanable Drive debris. Read path + auth proven.)
  - Harness note: call tool handlers via `tool.inputSchema.parse(input)` first — the MCP server applies
    zod defaults; calling handler() directly skips them (calendar_id default would be undefined).
- Honesty boundary now: CLIENT/API layer live-verified. MCP *tools* load after a Claude Code restart
  (servers registered, this session's tool list was fixed at startup). run_function still needs the
  one-time GCP-project relink. Consent screen recommended -> Production (removes 7-day token expiry).

## KNOWN MINOR
- RESOLVED 2026-06-30: docs-smart `parseInline` now honors CommonMark backslash escapes
  (commit 3512152, +15 tests -> docs 157). `mdInline` escaping is now effective end-to-end.
  flow inbox-digest test updated to assert paragraph STRUCTURALLY (no createParagraphBullets)
  instead of the old inert-backslash string (commit c237f11). No known-minors remain.
  Final monorepo total: 2457 tests.

## HANDOFF — Santo's manual steps to go live (the ONE thing I could not do)

Live-API verification needs your browser/OAuth; do these in the morning:
1. GCP console (same project as your existing email/calendar OAuth client): ENABLE 3 APIs — Google Tasks API, Google Docs API, Apps Script API.
2. OAuth consent screen: add scopes `auth/tasks`, `auth/documents`, `auth/drive.file`, `auth/script.projects`, `auth/script.deployments`, `auth/script.processes`, `auth/script.metrics`.
3. Mint scoped tokens (account = your-account):
   - `node packages/tasks-smart/dist/bin/tasks-smart-auth.js your-account`
   - `node packages/docs-smart/dist/bin/docs-smart-auth.js your-account`
   - `node packages/apps-script-smart/dist/bin/apps-script-smart-auth.js your-account`
   (flow-smart needs NO auth CLI; it reuses tasks/docs/script + your existing calendar/email tokens.)
4. Restart Claude Code. Try a READ-ONLY tool first (e.g. tasks `list_task_lists`, docs `get_document`).
5. `apps-script-smart` `run_function` ONLY: the painful one-time GCP setup (standard project relink + API-Executable deploy) per `packages/apps-script-smart/README.md`. Management tools (create/update/deploy) need only the per-user toggle at script.google.com/home/usersettings.
- [x] Full monorepo `npm test` + `typecheck` + every `smoke` green
- [x] Register via install-clients.sh + clean atomic commit history + memory + handoff

## Resume instructions (if context reset)

1. `git -C ~/projects/tools/smart-mcps log --oneline -20` and `git status` to see
   how far commits got.
2. `cd ~/projects/tools/smart-mcps && npm run build && npm test` to see real state.
3. Read this journal's checkboxes + the design doc, then continue the first
   unchecked step. Per-package implementers read their `docs/research/*` ref +
   `calendar-smart` as template + their section of the design doc.

## Honesty boundary (do not violate)

Live-API verification is BLOCKED on the user's one-time OAuth consent for the new
scopes (needs their browser + 3 APIs enabled in GCP console). Everything else is
buildable/testable offline. Never label anything "live-verified" or "working" in
production terms. `scripts.run` is static-verified only.

## Notes / decisions / surprises

- Scaffold green (independently verified build+typecheck). Client classes:
  `TasksClient`, `DocsClient`, `AppsScriptClient`, `CalendarClient`, `EmailClient`.
- Deviation: `flow-smart` build uses `tsc -b` (build mode) not `tsc -p`, so sibling
  `./client` `.d.ts` exist before flow compiles (workspaces build alphabetically;
  f before t). All other packages keep `tsc -p`.
- `EmailClient` constructor is `(home?: string)` (multi-account), unlike the four
  `(account, opts)` Google clients. flow-smart's buildContext handles both shapes.
- docs-smart renderer extracted to `src/render.ts` + `./render` subpath export
  (`renderMarkdownToNewDoc`) so flow-smart reuses it; docs-smart still 125 green.
- flow-smart implementer STALLED mid-stream (API error) after building helpers
  (extract.ts/flow-error.ts/time.ts) but before writing the 6 tools. Resumed the
  same agent from transcript to finish. docs-smart extraction confirmed green.
