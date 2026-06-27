# sheets-smart

Personal Google Sheets MCP — full read + write control of Google Sheets in a single Google account. Create / find / read / write / append / format / restructure / share spreadsheets. Wraps Google Sheets API v4 + Google Drive API v3 over the `~/.santo-agent/oauth/` token jar pattern with a dedicated `<account>.sheets.json` token slot. Part of the [smart-mcps](../../README.md) monorepo. Built on `smart-mcp-core`.

Scopes: `https://www.googleapis.com/auth/spreadsheets` (full Sheets) + `https://www.googleapis.com/auth/drive` (full Drive).

## Tools (16)

### Discover / lifecycle (4 + share)

| Name | Summary |
|---|---|
| `list_sheets` | List spreadsheets in Drive (optional name filter). |
| `create_sheet` | Create a spreadsheet, optional tabs / seed rows / folder. |
| `get_sheet` | Get spreadsheet metadata and tabs. |
| `delete_sheet` | Trash (default) or permanently delete a spreadsheet. |
| `share_sheet` | Share a spreadsheet (Drive permissions). |

### Values (5)

| Name | Summary |
|---|---|
| `read_range` | Read cell values from an A1 range. |
| `write_range` | Write values to an A1 range (USER_ENTERED default). |
| `append_rows` | Append rows after a table (INSERT_ROWS default). |
| `update_cells` | Batch-update multiple ranges in one call. |
| `clear_range` | Clear values in a range (keeps formatting). |

### Structure / format (5)

| Name | Summary |
|---|---|
| `add_tab` | Add a tab to a spreadsheet. |
| `rename_tab` | Rename a tab. |
| `delete_tab` | Delete a tab. |
| `format_range` | Format cells (bold / number format / background / freeze). |
| `batch_update` | Raw `spreadsheets:batchUpdate` escape hatch. |

### Shortcut (1)

| Name | Summary |
|---|---|
| `quick_add_row` | Append one row to the first or named tab. |

Destructive tools (`delete_sheet`, `delete_tab`, `share_sheet`) require `confirm: true`. `delete_sheet` defaults to trash (30-day recoverable).

## Auth

```
node packages/sheets-smart/dist/bin/sheets-smart-auth.js <account>
```

Mints `~/.santo-agent/oauth/<account>.sheets.json` (0600) via loopback OAuth consent.

## Default account

`SHEETS_DEFAULT_IDENTITY` env (else `your-account`).
