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

TBD (scaffold only — JSON + media tools added by the implementers).

## One-time auth

Mint a token for the account (needs `~/.santo-agent/oauth/client.json`, a Desktop
OAuth client). A localhost loopback flow captures the consent redirect:

```bash
node packages/gdrive-smart/dist/bin/gdrive-smart-auth.js <account>
```

Writes `~/.santo-agent/oauth/<account>.gdrive.json` (mode 0600), then restart
Claude Code to pick up gdrive-smart.
