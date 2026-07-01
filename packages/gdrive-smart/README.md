# gdrive-smart

Personal Google Drive API manager (MCP). Real file management over the Google
Drive REST API v3: folders, move / copy / rename, trash lifecycle, upload /
download / export, and sharing. Single account. Reuses the `~/.santo-agent/oauth/`
token jar pattern with a separate `<account>.gdrive.json` token slot. Part of the
[smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

Distinct from `drive-smart`, which is a LOCAL-DISK scanner (filesystem + GVfs
mounts, no Drive API). `gdrive-smart` talks to the real Drive API.

Scope: `https://www.googleapis.com/auth/drive` (full read + write on every file
the bound user can access — required to touch files the app did not create).

## Tools

22 tools: create (`create_folder`, `create_shortcut`, `generate_ids`), organize
(`rename`, `move`, `star`, `update_metadata`, `copy`), lifecycle (`trash`,
`restore`, `delete`, `empty_trash`), read (`get`, `list`), sharing (`share`,
`list_permissions`, `update_permission`, `unshare`), media (`upload`,
`update_content`, `download`, `export_file`).

### Shared drives

Every files/permissions call sends `supportsAllDrives=true`, so the tools work on
shared-drive items as well as My Drive. To list a shared drive's contents, pass
`drive_id` (and optionally `corpora`: `user` | `drive` | `domain` | `allDrives`)
to `list`; when `drive_id` is set the client adds `includeItemsFromAllDrives=true`
and defaults `corpora` to `drive`.

### Safety notes

- `delete` warns in its confirm preview when the target is a folder (recursive,
  irreversible). Prefer `trash` (recoverable for 30 days).
- `empty_trash` paginates the full trash for a true count and removes EVERY
  trashed file, not just one page.
- `download` / `export_file` refuse to overwrite an existing `dest_path` unless
  `overwrite: true`, and reject any path with a `..` traversal segment.
- `share` with `type: anyone` defaults to a link-only grant
  (`allow_file_discovery: false`); set it true for a discoverable/searchable link.
  `organizer` (shared-drive owner-equivalent) trips the confirm gate like `owner`.

## One-time auth

Mint a token for the account (needs `~/.santo-agent/oauth/client.json`, a Desktop
OAuth client). A localhost loopback flow captures the consent redirect:

```bash
node packages/gdrive-smart/dist/bin/gdrive-smart-auth.js <account>
```

Writes `~/.santo-agent/oauth/<account>.gdrive.json` (mode 0600), then restart
Claude Code to pick up gdrive-smart.
