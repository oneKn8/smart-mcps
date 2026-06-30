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
- [~] Implement docs-smart (TDD, ~18 tools) — parallel (dispatched)
- [~] Implement apps-script-smart (TDD, ~17 tools) — parallel (dispatched)
- [ ] Implement flow-smart (TDD, ~6 tools) — after the three wrappers
- [ ] Adversarial cross-verify each package + lead inspects critical real code
- [ ] Full monorepo `npm test` + `typecheck` + every `smoke` green
- [ ] Register via install-clients.sh + clean atomic commit history + memory + handoff

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
