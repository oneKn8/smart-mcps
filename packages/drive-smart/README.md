# drive-smart

Smart MCP for scanning **local disk and OS-mounted Google Drive folders** — indexing files, then
searching, ranking by size, finding duplicates, aggregating stats, and planning cleanup. 7 tools.

This is a **filesystem scanner**, not the Google Drive API. For Drive API operations (upload, share,
trash, permissions) use the separate `gdrive-smart`. drive-smart reads whatever is mounted on disk:
local folders and any OS-mounted (gvfs/rclone) Drive, into a durable index at
`~/.santo-agent/drive-smart/index.json` — a common view of files across accounts that does not depend
on one chat session's mounted state.

No credentials required — it never talks to a network API.

## Safety: network mounts are not walked by default

An OS-mounted Google Drive (gvfs FUSE) is network-backed. Reading *inside* a stale mount blocks in
uninterruptible kernel state — a process stuck there cannot be killed, even with SIGKILL, until the
mount responds. So drive-smart never touches mount internals blindly:

- `drive_roots` surfaces each mount by reading only the gvfs base directory and parsing the account
  from the mount name — it never descends into a mount, so it cannot hang. Each mount surfaces as one
  `network: true` root.
- `drive_scan` **skips network-mounted roots by default**. To index one, pass `include_network_roots:
  true`, or name its root id explicitly in `root_ids` (per-root opt-in); `root_ids` scoping is applied
  before any filesystem walk. Local roots always scan.

Directory symlinks are detected (`lstatSync`) and skipped to avoid symlink-loop re-walks.

## Tools (7)

- **drive_scan** `{ root_ids?, max_depth=12, limit_files=100000, include_network_roots=false }` — walk
  the configured + discovered roots into the index. Ignores `.git`, `node_modules`, `.cache`, Trash,
  and configured `ignore_names`.
- **drive_roots** `{}` — list discovered roots (config + local + any OS-mounted Drive), without descending.
- **drive_stats** `{}` — aggregate the index by root and by extension.
- **drive_search** `{ q, account?, root_id?, extension?, min_size?, max_results=50 }` — find files by
  name/path substring with filters, sorted by size.
- **drive_largest** `{ account?, root_id?, extension?, limit=25 }` — the biggest files, filtered.
- **drive_duplicates** `{ mode="same_name_and_size"|"same_size", min_size=1, limit_groups=50 }` — group
  likely duplicates (metadata-only; no content hashing).
- **drive_plan_cleanup** `{ strategy="large_files"|"archives"|"media"|"caches", min_size=104857600, limit=50 }`
  — **plan only** (`dry_run: true`; no file is moved or deleted): list cleanup candidates by strategy.

All file results are slim: `id, name, path, account?, size, size_human, extension`.

## Configuration

Optional config at `~/.santo-agent/drive-smart/config.json`:

```json
{
  "roots": [
    { "id": "photos", "label": "Photos", "path": "/home/me/Pictures", "kind": "local" }
  ],
  "ignore_names": ["node_modules", ".cache"]
}
```

Each root needs a `path`; `id`/`label`/`account`/`kind` (`local` | `google-drive` | `rclone` |
`unknown`) are optional. Without config, drive-smart auto-discovers common local roots plus any
OS-mounted Drive (the latter only listed, not walked).

## Scope

v1 is **read / index / plan only** — no file is moved, copied, or deleted. A mutation layer
(`drive_apply_plan`, `drive_move_or_copy`) with `guardDestructive` + dry-run + audit log is deferred to
a future version. Duplicate detection is metadata-based (name + size); content hashing is not yet done.

## Build & test

```bash
npm run build --workspace drive-smart
npm test --workspace drive-smart
npm run typecheck --workspace drive-smart
```
