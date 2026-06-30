# Google Docs API (docs/v1) — Verified Implementation Reference

> Researched 2026-06-30. Every claim below is sourced from official Google documentation
> (`developers.google.com/workspace/docs/api/...` and the OAuth scopes pages). No values are guessed.
> Note: in 2024-2025 Google migrated these docs from `developers.google.com/docs/api/...` to
> `developers.google.com/workspace/docs/api/...`; both paths redirect to the same content. The **REST
> service endpoint is unchanged**: `https://docs.googleapis.com/v1`.

Primary sources:
- REST reference root: https://developers.google.com/workspace/docs/api/reference/rest/v1/documents
- Request reference (all batchUpdate request types): https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request
- Document structure concept: https://developers.google.com/workspace/docs/api/concepts/structure
- Structural edit rules: https://developers.google.com/workspace/docs/api/concepts/rules-behavior
- Insert/delete/move text how-to: https://developers.google.com/workspace/docs/api/how-tos/move-text
- Choose Docs API scopes: https://developers.google.com/workspace/docs/api/auth
- Choose Drive API scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- OAuth 2.0 scopes index: https://developers.google.com/identity/protocols/oauth2/scopes
- Usage limits/quotas: https://developers.google.com/workspace/docs/api/limits

---

## 1. Base URL and the three top-level methods

**Service endpoint:** `https://docs.googleapis.com`
**API version path prefix:** `/v1`
There is exactly **one resource** (`documents`) with **three methods**. (Source: REST reference root.)

| Method | Verb + Path | Path / Query params | Request body | Response |
|---|---|---|---|---|
| `documents.get` | `GET https://docs.googleapis.com/v1/documents/{documentId}` | path: `documentId`. query: `suggestionsViewMode` (enum, default `DEFAULT_FOR_CURRENT_ACCESS`), `includeTabsContent` (bool) | none | a **Document** resource |
| `documents.create` | `POST https://docs.googleapis.com/v1/documents` | none | a **Document** — **only `title` is honored; all other fields (body, content, styles) are ignored** | the newly created **Document** (with `documentId`, `revisionId`, empty body) |
| `documents.batchUpdate` | `POST https://docs.googleapis.com/v1/documents/{documentId}:batchUpdate` | path: `documentId` | `{ requests: [Request], writeControl: WriteControl }` | **BatchUpdateDocumentResponse** |

**documents.create gotcha (verified):** "Creates a blank document using the title given in the
request. Other fields in the request, including any provided content, are ignored." → You cannot create
a populated doc in one call. Always `create` (title only) then `batchUpdate` to fill it.

**batchUpdate request/response shapes (verified):**
```jsonc
// Request body
{
  "requests": [ { /* one Request union member each, see §3 */ } ],
  "writeControl": {                 // optional, optimistic concurrency
    "requiredRevisionId": "string", // reject if document is not at this revision
    "targetRevisionId":  "string"   // OR merge against this revision (mutually exclusive)
  }
}
// BatchUpdateDocumentResponse
{
  "documentId": "string",
  "replies": [ { /* Response union member; maps 1:1 and in-order with requests */ } ],
  "writeControl": { /* updated WriteControl state */ }
}
```
`replies` is positional and 1:1 with `requests`; a request that produces no output yields an empty
reply object at that index. Output-bearing replies include e.g. `createNamedRange.namedRangeId`,
`insertInlineImage.objectId`, `replaceAllText.occurrencesChanged`.

---

## 2. Document content model and how indexes work

### Hierarchy (verified, structure concept page)
```
Document
 ├─ documentId, title, revisionId, documentStyle, namedStyles, lists, namedRanges,
 │  inlineObjects, positionedObjects, tabs[]
 └─ body
     └─ content[]  : StructuralElement[]
          each StructuralElement has startIndex, endIndex and exactly ONE of:
            • paragraph        → elements[] : ParagraphElement[]  (each has startIndex/endIndex + one of:
                                   textRun{content, textStyle}, inlineObjectElement, pageBreak,
                                   horizontalRule, footnoteReference, person, richLink, ...)
                                 + paragraphStyle, bullet
            • table            → tableRows[] → tableCells[] → content[] (StructuralElement[], recursive)
            • sectionBreak     → sectionStyle
            • tableOfContents  → content[] (StructuralElement[])
```
**Text lives only in `paragraph.elements[].textRun.content`.** "A TextRun represents a contiguous string
of text with all the same text style" and "text runs never cross paragraph boundaries." Every paragraph
ends with a newline `\n` that is part of the index space.

### Indexes — the critical concept (verified)
- **Zero-based**, measured in **UTF-16 code units**. "Surrogate pairs consume two indexes" (e.g. 😄 =
  `😀` takes 2 indexes).
- Indexes are **relative to the start of their enclosing segment**. A **segment** is the body, a header,
  a footer, or a footnote. `Location`/`Range` select a segment via `segmentId` (**empty/omitted
  `segmentId` = the document body**) plus `tabId` for multi-tab docs.
- A `Range` is `{startIndex, endIndex, segmentId, tabId}`; **`endIndex` is exclusive** (range covers
  `[startIndex, endIndex)`).
- **First writable body index = 1.** A blank document's body holds one empty paragraph whose trailing
  newline occupies index 0; its `endIndex` is 1. You insert body text at index ≥ 1. (Derived from the
  zero-based model + the final-newline rule below; matches `InsertText` examples that target index 1.)

### THE BIG GOTCHA — indexes shift mid-batch (verified, move-text how-to)
> "Each insertion increments all the higher-numbered indexes by the size of the inserted text."

Requests in a single `batchUpdate` are applied **sequentially, in array order**, and every insert/delete
**re-numbers all higher indexes** before the next request runs. So indexes you computed from the
original `documents.get` snapshot are stale the moment the first mutating request runs.

> Official mitigation: "To avoid having to precalculate these offset changes, order your insertions to
> 'write backwards': do the insertion at the highest-numbered index first."

**Strategy:** sort mutating requests by descending index and emit them last-position-first; then earlier
(lower-index) edits don't move. (See §7 for the markdown-renderer application of this.)

### Structural edit rules that bite (verified, rules-behavior page)
- Text "must be inserted within the bounds of an existing `Paragraph`. For example, text cannot be
  inserted at a table's start index" — insert into the preceding paragraph instead.
- You **cannot delete the last newline** of a `Body`, `Header`, `Footer`, `Footnote`, `TableCell`, or
  `TableOfContents`. A full-body wipe must stop before the final newline.
- "Inserting a newline character implicitly creates a `Paragraph` at that index," inheriting the current
  paragraph's style (including list/bullet membership).

---

## 3. All batchUpdate Request types

A `Request` is a union — **set exactly one field**. Full list (verified from the Request reference page).
**★ = high-value for an LLM-driven editor.**

| Field | Purpose | ★ |
|---|---|:--:|
| `insertText` | Insert text at a location | ★ |
| `deleteContentRange` | Delete content over a range | ★ |
| `replaceAllText` | Replace all instances of matching text (templating) | ★ |
| `updateTextStyle` | Set character formatting over a range | ★ |
| `updateParagraphStyle` | Set paragraph formatting (incl. heading style) over a range | ★ |
| `createParagraphBullets` | Turn paragraphs in a range into a bulleted/numbered list | ★ |
| `deleteParagraphBullets` | Remove bullets from paragraphs in a range | ★ |
| `insertTable` | Insert an R×C table | ★ |
| `insertTableRow` | Insert an empty row above/below a cell | ★ |
| `insertTableColumn` | Insert an empty column left/right of a cell | ★ |
| `deleteTableRow` | Delete a table row | ★ |
| `deleteTableColumn` | Delete a table column | ★ |
| `insertInlineImage` | Insert an inline image from a URI | ★ |
| `insertPageBreak` | Insert a page break | ★ |
| `insertSectionBreak` | Insert a section break | ★ |
| `updateDocumentStyle` | Update document-wide style (margins, page size, default header/footer) | ★ |
| `createNamedRange` | Create a named range (anchor/bookmark for later edits) | ★ |
| `deleteNamedRange` | Delete named range(s) by name or id | |
| `replaceNamedRangeContent` | Replace the content inside a named range | ★ |
| `replaceImage` | Replace an existing image's source | |
| `updateTableColumnProperties` | Set column width/properties | |
| `updateTableCellStyle` | Style table cells (background, borders, padding) | |
| `updateTableRowStyle` | Style table rows (e.g. min height, header row) | |
| `mergeTableCells` | Merge a rectangular block of cells | |
| `unmergeTableCells` | Unmerge previously merged cells | |
| `pinTableHeaderRows` | Set number of pinned (repeating) header rows | |
| `createHeader` | Create a header segment | |
| `createFooter` | Create a footer segment | |
| `createFootnote` | Create a footnote + reference | |
| `deleteHeader` | Delete a header | |
| `deleteFooter` | Delete a footer | |
| `deletePositionedObject` | Delete a floating/positioned object | |
| `updateSectionStyle` | Style a document section | |
| `updateNamedStyle` | Modify a built-in named style definition (e.g. HEADING_1 default look) | |
| `addDocumentTab` | Add a document tab | |
| `deleteTab` | Delete a document tab | |
| `updateDocumentTabProperties` | Update a tab's properties | |
| `insertPerson` | Insert a person/smart-chip mention | |
| `insertRichLink` | Insert a rich link (smart chip to a URL/Drive file) | |
| `insertDate` | Insert a date smart chip | |

(40 request kinds documented. The Request reference labels the union as having 41 members; the spread
includes an `unspecified`/internal placeholder. Treat the 40 named kinds above as the usable surface.)

### Key fields of the high-value requests (verified)
```jsonc
// Shared location/range building blocks
Location               = { index, segmentId?, tabId? }          // a single insertion point
EndOfSegmentLocation   = { segmentId?, tabId? }                 // append to end of a segment
Range                  = { startIndex, endIndex, segmentId?, tabId? }  // endIndex exclusive

insertText             = { text, location | endOfSegmentLocation }     // one of the two locations
deleteContentRange     = { range }
replaceAllText         = { replaceText, containsText: { text, matchCase } }
updateTextStyle        = { range, textStyle: TextStyle, fields }       // fields = FieldMask (§4)
updateParagraphStyle   = { range, paragraphStyle: ParagraphStyle, fields }
createParagraphBullets = { range, bulletPreset: BulletGlyphPreset }
deleteParagraphBullets = { range }
insertTable            = { rows, columns, location | endOfSegmentLocation }
insertTableRow         = { tableCellLocation, insertBelow }
insertTableColumn      = { tableCellLocation, insertRight }
deleteTableRow         = { tableCellLocation }
deleteTableColumn      = { tableCellLocation }
insertInlineImage      = { uri, objectSize: { height, width }, location | endOfSegmentLocation }
insertPageBreak        = { location | endOfSegmentLocation }
insertSectionBreak     = { sectionType, location | endOfSegmentLocation }
createNamedRange       = { name, range }
replaceNamedRangeContent = { namedRangeName | namedRangeId, text }
```

**`TextStyle` fields** (character formatting; used by `updateTextStyle`):
`bold`, `italic`, `underline`, `strikethrough`, `smallCaps`, `fontSize` (`{magnitude, unit}`),
`weightedFontFamily` (`{fontFamily, weight}`), `foregroundColor`, `backgroundColor`, `baselineOffset`
(SUPERSCRIPT/SUBSCRIPT), `link` (`{url}` | `{bookmarkId}` | `{headingId}`).

**`ParagraphStyle` fields** (paragraph formatting; used by `updateParagraphStyle`):
`namedStyleType` (see enum below), `alignment` (START/CENTER/END/JUSTIFIED), `lineSpacing`,
`direction`, `spaceAbove`, `spaceBelow`, `indentStart`, `indentEnd`, `indentFirstLine`,
`borderTop/Bottom/Left/Right`, `keepLinesTogether`, `keepWithNext`, `headingId`.

**`NamedStyleType` enum (verified):** `NORMAL_TEXT`, `TITLE`, `SUBTITLE`,
`HEADING_1`, `HEADING_2`, `HEADING_3`, `HEADING_4`, `HEADING_5`, `HEADING_6`.

**`BulletGlyphPreset` enum (verified):** unordered presets
`BULLET_DISC_CIRCLE_SQUARE`, `BULLET_DIAMONDX_ARROW3D_SQUARE`, `BULLET_CHECKBOX`,
`BULLET_ARROW_DIAMOND_DISC`, `BULLET_STAR_CIRCLE_SQUARE`, `BULLET_ARROW3D_CIRCLE_SQUARE`,
`BULLET_LEFTTRIANGLE_DIAMOND_DISC`, `BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE`,
`BULLET_DIAMOND_CIRCLE_SQUARE`; ordered presets `NUMBERED_DECIMAL_ALPHA_ROMAN`,
`NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS`, `NUMBERED_DECIMAL_NESTED`, `NUMBERED_UPPERALPHA_ALPHA_ROMAN`,
`NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL`, `NUMBERED_ZERODECIMAL_ALPHA_ROMAN`.

---

## 4. The fields-mask pattern

`updateTextStyle`, `updateParagraphStyle`, `updateDocumentStyle`, `updateTableCellStyle`, etc. all carry
a **`fields`** parameter (a protobuf `FieldMask`). It is **mandatory** and declares **which sub-fields of
the style object you intend to write**; any field named in the mask but absent from the style object is
**reset to its default**. Fields not in the mask are left untouched. This lets you change one attribute
without clobbering the rest.

- Comma-separated dotted paths, camelCase: `"bold,italic"`, `"foregroundColor,fontSize"`,
  `"namedStyleType,alignment"`.
- `"*"` means "all fields of this style object" (writes everything, resetting anything you didn't set).

Example — make a range bold **without** disturbing its other styles:
```jsonc
{ "updateTextStyle": {
    "range": { "startIndex": 12, "endIndex": 20 },
    "textStyle": { "bold": true },
    "fields": "bold"            // only 'bold' is written; color/size/italic untouched
} }
```
Example — set a heading and center it in one request:
```jsonc
{ "updateParagraphStyle": {
    "range": { "startIndex": 1, "endIndex": 14 },
    "paragraphStyle": { "namedStyleType": "HEADING_1", "alignment": "CENTER" },
    "fields": "namedStyleType,alignment"
} }
```

---

## 5. Exact OAuth scope strings (verified)

From "Choose Google Docs API scopes" (the Docs API accepts all five):

| Scope | Grants | Tier |
|---|---|---|
| `https://www.googleapis.com/auth/documents` | "See, edit, create, and delete all your Google Docs documents" | **Sensitive** |
| `https://www.googleapis.com/auth/documents.readonly` | "See all your Google Docs documents" | **Sensitive** |
| `https://www.googleapis.com/auth/drive.file` | "See, edit, create, and delete only the specific Google Drive files you use with this app" (per-file access) | **Non-sensitive (recommended)** |
| `https://www.googleapis.com/auth/drive` | "See, edit, create, and delete all of your Google Drive files" | **Restricted** |
| `https://www.googleapis.com/auth/drive.readonly` | "See and download all your Google Drive files" | **Restricted** |

**Creation/placement guidance:**
- To **read+write doc content**, the minimal scope is `documents` (read-only: `documents.readonly`).
- The Docs API's `documents.create` drops the new doc in the user's Drive root. To **control placement**
  (a specific folder/shared drive) or to enumerate/move files you must also use the **Drive API**.
- **`drive.file` is the recommended Drive scope**: per-file access, **non-sensitive** (light
  verification), covers files the app creates or the user picks. `drive` (full) is a **restricted** scope
  requiring a Google security assessment — avoid unless you genuinely need access to files your app
  didn't create. For a docs-smart MCP, `documents` + `drive.file` is the right pairing.

---

## 6. Reading plain text back, and replaceAllText templating

**Plain-text extraction** — walk the structure (no API helper exists; you reconstruct text yourself):
```
for el in document.body.content:               # StructuralElement[]
    if el.paragraph:
        for pe in el.paragraph.elements:       # ParagraphElement[]
            if pe.textRun:
                text += pe.textRun.content      # includes the trailing "\n"
    elif el.table:
        for row in el.table.tableRows:
            for cell in row.tableCells:
                recurse(cell.content)           # cells hold StructuralElement[]
    # sectionBreak / tableOfContents contribute structure, not body text
```
Tabs: if you call `documents.get` with `includeTabsContent=true`, body content moves under
`document.tabs[].documentTab.body.content` and you must iterate each tab. With the default
(`includeTabsContent=false`) the **first tab's** content is flattened into `document.body`.

**Templating with `replaceAllText`** — the cleanest mutation because it needs **no index math**:
```jsonc
{ "replaceAllText": {
    "containsText": { "text": "{{customer_name}}", "matchCase": true },
    "replaceText": "Acme Corp"
} }
```
Returns `{ "occurrencesChanged": N }` in its reply. Pattern: author a template doc with `{{tokens}}`,
copy it (Drive `files.copy`), then one `batchUpdate` of N `replaceAllText` requests fills it. Because
replacements are by literal substring (not index), order and index-shifting are irrelevant here.

---

## 7. Recipe: "create doc from markdown"

Goal: render headings, bold/italic, bullet lists, and tables from markdown into a real Doc.

**Two viable strategies; the second is what production renderers use:**

**A. Insert-all-text-first, then style by range (recommended).**
1. `documents.create` with `title` → get `documentId`.
2. Parse markdown into a flat list of blocks (heading/paragraph/list-item/table) and inline spans
   (text + bold/italic/code/link). As you lay out the plain text, **track the start/end index of every
   block and every styled span** in a single running cursor (remember: body starts at index 1, every
   block you emit ends with `\n` which advances the cursor by 1).
3. Emit ONE `insertText` for the full concatenated plain text at index 1 (or several appends via
   `endOfSegmentLocation` — appending to end-of-segment also sidesteps index math).
4. **Then** emit styling requests against the recorded ranges — these don't change index counts:
   - Headings: `updateParagraphStyle` with `namedStyleType: HEADING_n` (+ `fields:"namedStyleType"`).
   - Bold/italic/code: `updateTextStyle` with `{bold:true}` / `{italic:true}` /
     `{weightedFontFamily:{fontFamily:"Consolas"}}` and matching `fields` mask.
   - Links: `updateTextStyle` `{link:{url}}`, `fields:"link"`.
   - Bullet/numbered lists: `createParagraphBullets` over the list block's range with
     `BULLET_DISC_CIRCLE_SQUARE` (unordered) or `NUMBERED_DECIMAL_ALPHA_ROMAN` (ordered). Nesting is by
     leading tabs in the inserted text; the preset supplies per-level glyphs.
5. Tables can't be filled at insert time — `insertTable` makes an **empty** R×C grid, then you must
   `documents.get` again (or compute) to find each cell's start index and `insertText` into cells.
   Because tables perturb indexes heavily, insert tables **last** or handle them in their own batch.

**B. Build bottom-up (write backwards).** If you prefer to interleave inserts and styles, generate all
requests but **sort/emit them from the highest index to the lowest** so each edit leaves earlier indexes
valid (the official "write backwards" rule, §2). This avoids a re-`get` between steps.

**Index-shifting rule for the renderer (the single thing to get right):** never reuse an index computed
before a mutating request in the same batch. Either (A) do all `insertText` first and style by range
afterward, or (B) order every mutating request descending by index. Mixing forward inserts with
pre-computed indexes silently corrupts the output.

---

## 8. Rate limits / quotas (verified, limits page)

| Quota | Limit |
|---|---|
| Read requests — per minute per project | **3,000** |
| Read requests — per minute per user per project | **300** |
| Write requests — per minute per project | **600** |
| Write requests — per minute per user per project | **60** |

- Exceeding a limit returns **HTTP 429 "Too many requests"**; the page prescribes **exponential backoff
  with retries**. Per-user write ceiling of **60/min** is the practical bottleneck for a batch editor —
  **batch many requests into one `batchUpdate` call** (one call, many `requests[]`) rather than many
  calls.
- Quota increases are requestable via Cloud console → Quotas & System Limits (not guaranteed).
- **2026 change (verified):** "Exceeding the quota request limits is planned to incur charges to your
  Google Cloud billing account later in 2026." → over-quota usage will become billable rather than purely
  rate-limited; design to stay within limits and coalesce writes.

---

## Appendix — recommended `docs-smart` MCP tool surface

Full read/create + high-value edits + markdown renderer + raw escape hatch (~18 tools). Names follow the
existing `*-smart` convention (verb_noun).

| Tool | Wraps | Notes |
|---|---|---|
| `get_document` | `documents.get` | options: `includeTabsContent`, `suggestionsViewMode` |
| `read_text` | `documents.get` + local walk | returns reconstructed plain text (§6); cheap LLM-friendly read |
| `create_document` | `documents.create` | title-only; returns `documentId` + URL |
| `insert_text` | `insertText` | location index or end-of-segment append |
| `delete_range` | `deleteContentRange` | guard against deleting final newline |
| `replace_all_text` | `replaceAllText` | templating; returns `occurrencesChanged` |
| `set_text_style` | `updateTextStyle` | auto-builds `fields` mask from supplied attrs |
| `set_paragraph_style` | `updateParagraphStyle` | headings/alignment/indent; auto `fields` mask |
| `set_heading` | `updateParagraphStyle` | convenience: `HEADING_1..6`/`TITLE`/`SUBTITLE` |
| `make_bullets` | `createParagraphBullets` | preset selector (unordered/numbered) |
| `remove_bullets` | `deleteParagraphBullets` | |
| `insert_table` | `insertTable` | R×C empty grid |
| `fill_table` | get + `insertText` per cell | helper (tables can't be filled at insert) |
| `modify_table` | insert/deleteTableRow/Column | row/col add/remove |
| `insert_image` | `insertInlineImage` | public URI + optional size |
| `insert_page_break` | `insertPageBreak` | |
| `append_markdown` / `render_markdown` | parser → batched requests | **the flagship** (§7 strategy A) |
| `create_doc_from_markdown` | `create` + render_markdown | one-shot: title + markdown → live doc + URL |
| `batch_update` | raw `documents.batchUpdate` | **escape hatch**: pass `requests[]` verbatim for any of the 40 request kinds |

**Single biggest implementation gotcha: INDEX SHIFTING.** Indexes are zero-based UTF-16 offsets that
**re-number after every insert/delete within a batch** (requests apply sequentially). Indexes from your
`documents.get` snapshot go stale the instant the first mutating request runs. Every multi-edit tool must
either (a) insert all text first then style by recorded ranges, or (b) emit mutating requests in
descending-index order ("write backwards"). Get this wrong and output silently corrupts. Also enforce the
two hard rules: insert only inside an existing paragraph (never at a table's start index), and never
delete a segment's final newline.
