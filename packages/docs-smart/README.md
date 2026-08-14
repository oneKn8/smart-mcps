# docs-smart

Personal Google Docs MCP — read + create + edit documents on a single account. Reuses the `~/.santo-agent/oauth/` token jar pattern with a dedicated `<account>.docs.json` token slot. Scopes: `https://www.googleapis.com/auth/documents` + `https://www.googleapis.com/auth/drive.file`. Part of the [smart-mcps](../../README.md) monorepo; built on `smart-mcp-core`.

## Tools (18)

| Tool | Wraps | Notes |
| --- | --- | --- |
| `get_document` | `documents.get` | slim metadata (id, title, revisionId) |
| `read_text` | `documents.get` + local walk | reconstructed plain text |
| `create_document` | `documents.create` (+ optional `batchUpdate`) | **title-only** create; optional seed text |
| `insert_text` | `insertText` | rejects index 0 and a table's start index (does a `get`) |
| `delete_range` | `deleteContentRange` | rejects deleting the body's final newline (does a `get`) |
| `replace_all_text` | `replaceAllText` | templating; returns `occurrences_changed` |
| `append_text` | `insertText` (end-of-segment) | index-free append |
| `set_text_style` | `updateTextStyle` | auto-builds the `fields` mask from the supplied attributes |
| `set_paragraph_style` | `updateParagraphStyle` | auto `fields` mask |
| `set_heading` | `updateParagraphStyle` | `title`/`subtitle`/`heading_1..6`/`normal` |
| `make_bullets` | `createParagraphBullets` | unordered or numbered preset |
| `remove_bullets` | `deleteParagraphBullets` | |
| `insert_table` | `insertTable` | empty R×C grid |
| `fill_table` | `get` + `insertText` per cell | fills cells **write-backwards** |
| `insert_image` | `insertInlineImage` | public URI + optional size |
| `insert_page_break` | `insertPageBreak` | |
| `create_doc_from_markdown` | parser → batched requests | **flagship** — headings, bold/italic, nested bullets, tables |
| `batch_update` | raw `documents.batchUpdate` | escape hatch: forwards `requests[]` verbatim (**bypasses guards** — see below) |

### Index-shifting (the one thing to get right)

Document indexes are zero-based UTF-16 offsets that **renumber after every
insert/delete within a batch** (requests apply sequentially). A `get` snapshot's
indexes go stale the instant the first mutating request lands. Every multi-edit
path here uses one of the two safe strategies:

- **Insert all text first, then style by ranges recorded against the final
  layout** (`create_doc_from_markdown`'s text phase — strategy A).
- **Emit mutations in descending index order ("write backwards")** so each edit
  leaves the lower indexes valid (`fill_table`, and `create_doc_from_markdown`'s
  table-insert + cell-fill phases).

Two hard rules are enforced with clear errors: never insert at a table's start
index, never delete a segment's final newline (the body's, and any top-level
table cell's). Every `update*Style` request carries a `fields` mask built from
exactly the attributes the caller set.

`create_doc_from_markdown` also separates two **adjacent** tables (tables with
only a blank line between them) by inserting an empty paragraph, so each table
gets a strictly-distinct, ascending flow anchor. Without it both tables would be
recorded at the same `insertIndex` and the table-insert/cell-fill phases would
mis-place or drop cells. Google Docs requires that separating paragraph anyway.

> **`batch_update` bypasses the guards.** The raw escape hatch forwards your
> `requests[]` verbatim: it does **not** run `assertNotTableStartIndex` /
> `assertDeletableRange`, and does **not** manage index-shifting. You own
> index-safety (insert-all-then-style, or write backwards). A bad batch is a
> loud upstream 400, not silent corruption — but it is on you to avoid.

> Note: the Docs API rate ceiling is 60 writes/min/user; `fetchJson`'s built-in 429 backoff covers it. The tools coalesce edits into single `batchUpdate` calls to stay under it.

## Setup

Follows the same OAuth bootstrap as [`calendar-smart`](../calendar-smart/README.md): drop a Google OAuth Desktop client at `~/.santo-agent/oauth/client.json`, enable the Google Docs API on the project, build, then mint a token:

```bash
npm run build --workspace=docs-smart
node packages/docs-smart/dist/bin/docs-smart-auth.js your-account
```

The token is written to `~/.santo-agent/oauth/your-account.docs.json` (mode 600). Requires `DOCS_DEFAULT_IDENTITY` in `~/.config/smart-mcps/.env`.
