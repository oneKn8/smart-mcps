# Phase 8 build journal — gdrive-smart (Google Drive API manager)

Live state. Design: `docs/2026-06-30-phase-8-gdrive-smart-design.md`.
Research: `docs/research/2026-06-30-drive-api-write-reference.md`.
Branch: `phase-8-gdrive-smart` (stacked on `phase-7-google-trio-flow`). No push without Santo.

Context: the existing `drive-smart` is a LOCAL-DISK scanner (untouched). `gdrive-smart`
is a NEW Google Drive REST API v3 manager. Full `drive` scope, token `.gdrive.json`.

## State machine
- [x] Research verified + design written + committed (2 commits)
- [ ] Scaffold gdrive-smart (client.ts auth + media.ts stub + auth CLI + ./client export) green
- [ ] Implement A: client.ts JSON methods + create/organize/lifecycle/read/sharing tools
- [ ] Implement B: media.ts + upload/update_content/download/export tools
- [ ] Adversarial cross-verify (gating, multipart, binary, share exposure, fields, pageSize 100)
- [ ] LIVE E2E self-cleaning (folder->file->move->rename->trash->restore->delete; share->unshare)
- [ ] Register + auth CLI (one more consent, durable in Production) + memory + handoff

## Notes / decisions
- Full `drive` scope required to manage files the app didn't create (`drive.file` = dead end).
- Two media wrinkles: multipart upload (raw fetch, not fetchJson) + binary download/export
  (arrayBuffer -> local path, never inline bytes). Isolated in media.ts.
- files.list pageSize max = 100 (not 1000). Paginate.
- Safety: trash is the reversible default; delete/empty_trash/anyone-share/ownership hard-gated.
