import { ValidationError } from "smart-mcp-core";
import {
  BODY_START_INDEX,
  ORDERED_BULLET_PRESET,
  UNORDERED_BULLET_PRESET,
  buildTextStyle,
  createParagraphBulletsRequest,
  insertTextRequest,
  updateParagraphStyleRequest,
  type DocsRequest,
  type NamedStyleType,
} from "./request-builders.js";

/**
 * A tiny, dependency-free Markdown subset parser + Google-Docs renderer.
 *
 * Supported: ATX headings (`#`..`######`), paragraphs, unordered lists
 * (`-`/`*`/`+`, nested by indentation), ordered lists (`1.`), GitHub pipe
 * tables, and inline bold (`**`/`__`), italic (`*`/`_`), and code (`` ` ``).
 *
 * RENDER STRATEGY — "insert all flow text first, then style by recorded ranges"
 * (the reference's strategy A). Tables are handled out-of-band because
 * `insertTable` only makes an empty grid and perturbs indexes heavily:
 *
 *   Phase A: ONE `insertText` of the whole flow text at BODY_START_INDEX, then
 *            paragraph/text-style + bullet requests whose ranges are recorded
 *            against that final flow layout. No index is reused after a mutating
 *            insert — styles don't change index counts, so this is corruption-free.
 *   Phase B (orchestrated in the tool): insert the empty tables at their recorded
 *            flow indexes in DESCENDING order ("write backwards") so each insert
 *            leaves the lower recorded indexes valid.
 *   Phase C (orchestrated in the tool): documents.get to read real cell indexes,
 *            then fill cells write-backwards.
 *
 * `buildMarkdownPlan` produces Phase A's requests + the table descriptors that
 * Phases B/C consume. `flowText` is returned so tests can assert that every
 * recorded style range slices the correct substring (proving no index drift).
 */

// ===========================================================================
// AST
// ===========================================================================

export type InlineSpan = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
};

export type ListItem = { level: number; spans: InlineSpan[] };

export type Block =
  | { type: "heading"; level: number; spans: InlineSpan[] }
  | { type: "paragraph"; spans: InlineSpan[] }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "table"; rows: string[][] };

// ===========================================================================
// Inline parser
// ===========================================================================

/**
 * The 32 ASCII punctuation characters (CommonMark's "ASCII punctuation" class):
 * `!"#$%&'()*+,-./:;<=>?@[\]^_` plus `` ` `` `{|}~`. A backslash escape is only
 * honored before one of these; every inline marker this parser recognizes
 * (`* _ ` `` ` `` ` # |`) is a member, so escaping suppresses formatting.
 */
const ASCII_PUNCT_RE = /[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/;

/**
 * CommonMark backslash rule: `pos` (the start of a candidate delimiter) counts
 * as escaped iff an ODD number of backslashes immediately precede it. (`\*` is
 * escaped; `\\*` is an escaped backslash followed by a live `*`.)
 */
function isBackslashEscaped(line: string, pos: number): boolean {
  let backslashes = 0;
  let j = pos - 1;
  while (j >= 0 && line[j] === "\\") {
    backslashes += 1;
    j -= 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Resolve backslash escapes inside an already-delimited run's text: a backslash
 * before ASCII punctuation is dropped and the punctuation kept literally; a
 * backslash before anything else (or at end) stays literal. Keeps the run a
 * single span (this parser does not recurse into nested markers).
 */
function unescapeInline(text: string): string {
  let out = "";
  let k = 0;
  while (k < text.length) {
    const ch = text[k] as string;
    const next = text[k + 1];
    if (ch === "\\" && next !== undefined && ASCII_PUNCT_RE.test(next)) {
      out += next;
      k += 2;
    } else {
      out += ch;
      k += 1;
    }
  }
  return out;
}

/**
 * Split a line into styled spans. Greedy left-to-right scan for the four inline
 * markers; unmatched markers fall through as literal text. Bold is matched
 * before italic so `**x**` is not mis-read as italic-empty-italic.
 *
 * Backslash escapes are CommonMark-correct: `\` before an ASCII punctuation
 * char emits that char as plain text (consuming the backslash) and prevents it
 * from acting as a formatting delimiter — an opener is consumed here in the
 * scan, and a closer is skipped by `findClose`. `\` before a non-punctuation
 * char or at end-of-string stays a literal backslash. This is the hardening
 * that makes a caller's escaping (e.g. flow-smart's `mdInline`) actually inert
 * the markers it neutralizes.
 */
export function parseInline(line: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buf = "";
  let i = 0;
  const flush = (): void => {
    if (buf.length > 0) {
      spans.push({ text: buf });
      buf = "";
    }
  };
  // Next occurrence of `marker` at or after `from` that is NOT backslash-escaped.
  const findClose = (marker: string, from: number): number => {
    let pos = line.indexOf(marker, from);
    while (pos !== -1 && isBackslashEscaped(line, pos)) {
      pos = line.indexOf(marker, pos + 1);
    }
    return pos;
  };
  const takeDelimited = (
    marker: string,
    style: Omit<InlineSpan, "text">,
  ): boolean => {
    const close = findClose(marker, i + marker.length);
    if (close === -1) return false;
    const inner = line.slice(i + marker.length, close);
    if (inner.length === 0) return false;
    flush();
    spans.push({ text: unescapeInline(inner), ...style });
    i = close + marker.length;
    return true;
  };
  while (i < line.length) {
    // Backslash escape FIRST: consume an escaped marker before it can be read
    // as an opener, so `\*` is literal text, not the start of an italic run.
    if (line[i] === "\\") {
      const next = line[i + 1];
      if (next !== undefined && ASCII_PUNCT_RE.test(next)) {
        buf += next;
        i += 2;
      } else {
        buf += "\\";
        i += 1;
      }
      continue;
    }
    const two = line.slice(i, i + 2);
    if ((two === "**" || two === "__") && takeDelimited(two, { bold: true })) {
      continue;
    }
    const one = line[i];
    if (one === "`" && takeDelimited("`", { code: true })) continue;
    if ((one === "*" || one === "_") && takeDelimited(one, { italic: true })) {
      continue;
    }
    buf += one ?? "";
    i += 1;
  }
  flush();
  return spans.length > 0 ? spans : [{ text: "" }];
}

// ===========================================================================
// Block parser
// ===========================================================================

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UNORDERED_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;

function isTableSeparator(line: string): boolean {
  // `|---|:--:|` etc. Cells are dashes with optional leading/trailing colons.
  const trimmed = line.trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed);
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** Indent width -> nesting level (every 2 spaces or 1 tab is one level). */
function indentToLevel(indent: string): number {
  let level = 0;
  for (const ch of indent) level += ch === "\t" ? 1 : 0.5;
  return Math.floor(level);
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: InlineSpan[][] = [];

  const flushParagraph = (): void => {
    if (para.length === 0) return;
    // Join wrapped lines with a space into one paragraph of spans.
    const spans: InlineSpan[] = [];
    para.forEach((lineSpans, idx) => {
      if (idx > 0) spans.push({ text: " " });
      spans.push(...lineSpans);
    });
    blocks.push({ type: "paragraph", spans });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: (heading[1] as string).length,
        spans: parseInline((heading[2] as string).trim()),
      });
      i += 1;
      continue;
    }

    // Table: a pipe row immediately followed by a separator row.
    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1] ?? "")
    ) {
      flushParagraph();
      const rows: string[][] = [splitTableRow(line)];
      i += 2; // skip header + separator
      while (i < lines.length) {
        const rowLine = lines[i] ?? "";
        if (rowLine.trim().length === 0 || !rowLine.includes("|")) break;
        rows.push(splitTableRow(rowLine));
        i += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }

    const unordered = UNORDERED_RE.exec(line);
    const ordered = ORDERED_RE.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null && unordered === null;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        const u = UNORDERED_RE.exec(cur);
        const o = ORDERED_RE.exec(cur);
        const match = isOrdered ? (o ?? u) : (u ?? o);
        if (!match) break;
        // Stop if the list flips ordered<->unordered at the top level.
        const curOrdered = o !== null && u === null;
        if (indentToLevel(match[1] as string) === 0 && curOrdered !== isOrdered) {
          break;
        }
        items.push({
          level: indentToLevel(match[1] as string),
          spans: parseInline((match[2] as string).trim()),
        });
        i += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    // Plain text line -> accumulate into the current paragraph.
    para.push(parseInline(trimmed));
    i += 1;
  }
  flushParagraph();
  return blocks;
}

// ===========================================================================
// Renderer
// ===========================================================================

export type TableDescriptor = {
  /** Flow index (final-layout) at which to insert the empty table. */
  insertIndex: number;
  rows: number;
  columns: number;
  /** Row-major cell text (rows x columns). */
  cells: string[][];
};

export type MarkdownPlan = {
  /** The full flow text laid out in document order (no table text). */
  flowText: string;
  /** Phase A requests: the single insertText, then styles + bullets. */
  flowRequests: DocsRequest[];
  /** Tables to insert (Phase B) and fill (Phase C), in source order (asc index). */
  tables: TableDescriptor[];
};

const HEADING_STYLE: Record<number, NamedStyleType> = {
  1: "HEADING_1",
  2: "HEADING_2",
  3: "HEADING_3",
  4: "HEADING_4",
  5: "HEADING_5",
  6: "HEADING_6",
};

export function buildMarkdownPlan(blocks: Block[]): MarkdownPlan {
  let cursor = BODY_START_INDEX;
  let flow = "";
  const styleRequests: DocsRequest[] = [];
  const tables: TableDescriptor[] = [];
  // The flow index of the most recently recorded table. A table contributes no
  // flow text, so if the very next block is ALSO a table the cursor will not
  // have advanced and the two tables would collide on one insertIndex (see the
  // table branch below). Seed with a sentinel that can never equal a real
  // BODY_START_INDEX-based cursor.
  let lastTableInsertIndex = Number.NEGATIVE_INFINITY;

  const emit = (s: string): void => {
    flow += s;
    cursor += s.length; // UTF-16 code units — matches Google's index model
  };

  // Record bold/italic/code spans of a line whose plain text starts at `from`.
  const recordSpans = (spans: InlineSpan[], from: number): void => {
    let idx = from;
    for (const span of spans) {
      const len = span.text.length;
      if (len > 0 && (span.bold || span.italic || span.code)) {
        const built = buildTextStyle({
          ...(span.bold ? { bold: true } : {}),
          ...(span.italic ? { italic: true } : {}),
          ...(span.code ? { fontFamily: "Consolas" } : {}),
        });
        if (built) {
          styleRequests.push({
            updateTextStyle: {
              range: { startIndex: idx, endIndex: idx + len },
              textStyle: built.textStyle,
              fields: built.fields,
            },
          });
        }
      }
      idx += len;
    }
  };

  const plainOf = (spans: InlineSpan[]): string =>
    spans.map((s) => s.text).join("");

  for (const block of blocks) {
    if (block.type === "heading") {
      const start = cursor;
      const text = plainOf(block.spans);
      emit(text + "\n");
      recordSpans(block.spans, start);
      const named = HEADING_STYLE[block.level] ?? "HEADING_6";
      styleRequests.push(
        updateParagraphStyleRequest({
          startIndex: start,
          endIndex: cursor,
          paragraphStyle: { namedStyleType: named },
          fields: "namedStyleType",
        }),
      );
      continue;
    }

    if (block.type === "paragraph") {
      const start = cursor;
      emit(plainOf(block.spans) + "\n");
      recordSpans(block.spans, start);
      continue;
    }

    if (block.type === "list") {
      const blockStart = cursor;
      for (const item of block.items) {
        emit("\t".repeat(item.level)); // nesting via leading tabs (per reference)
        const textStart = cursor;
        emit(plainOf(item.spans) + "\n");
        recordSpans(item.spans, textStart);
      }
      styleRequests.push(
        createParagraphBulletsRequest({
          startIndex: blockStart,
          endIndex: cursor,
          bulletPreset: block.ordered
            ? ORDERED_BULLET_PRESET
            : UNORDERED_BULLET_PRESET,
        }),
      );
      continue;
    }

    if (block.type === "table") {
      // CRITICAL anti-corruption step. If the previous block was also a table
      // the cursor has not advanced since we recorded its insertIndex (a table
      // emits no flow text), so this table would be recorded at the SAME
      // insertIndex. Phase B would then insert both grids at one point and
      // Phase C's positional table<->descriptor match would mis-place or drop
      // cells. Emit a separating empty paragraph so this table gets a strictly
      // greater, DISTINCT anchor. Google Docs also REQUIRES an empty paragraph
      // between two adjacent tables, so this is also more correct output.
      if (cursor === lastTableInsertIndex) {
        emit("\n");
      }
      const rows = block.rows.length;
      const columns = block.rows.reduce((m, r) => Math.max(m, r.length), 0);
      // Normalize each row to `columns` cells.
      const cells = block.rows.map((r) => {
        const row = r.slice(0, columns);
        while (row.length < columns) row.push("");
        return row;
      });
      // Table is inserted later at the current flow boundary (a paragraph
      // start). It contributes no flow text, so surrounding blocks keep their
      // correct order once the table is spliced in at `insertIndex`.
      const insertIndex = cursor;
      tables.push({ insertIndex, rows, columns, cells });
      lastTableInsertIndex = insertIndex;
      continue;
    }
  }

  const flowRequests: DocsRequest[] = [];
  if (flow.length > 0) {
    flowRequests.push(
      insertTextRequest({ text: flow, index: BODY_START_INDEX }),
    );
  }
  flowRequests.push(...styleRequests);

  return { flowText: flow, flowRequests, tables };
}

/**
 * Defensive corruption guard: every table descriptor MUST carry a distinct
 * `insertIndex`. Two tables sharing an anchor is the flagship's worst silent
 * failure mode (Phase B inserts both grids at one point; Phase C's positional
 * table<->descriptor match drops or cross-contaminates cells). `buildMarkdownPlan`
 * guarantees distinctness by separating adjacent tables, but any future
 * regression must fail LOUD here instead of corrupting the rendered document.
 * Order-agnostic (callers may pass source order OR ascending) — distinctness is
 * the invariant, not sortedness.
 */
export function assertDistinctTableInsertIndices(
  tables: ReadonlyArray<{ insertIndex: number }>,
): void {
  const seen = new Set<number>();
  for (const table of tables) {
    if (seen.has(table.insertIndex)) {
      throw new ValidationError(
        `Two tables share insertIndex ${table.insertIndex}; each table needs a ` +
          `distinct flow anchor or table inserts/fills will mis-place cells. ` +
          `Adjacent tables must be separated by an empty paragraph.`,
      );
    }
    seen.add(table.insertIndex);
  }
}

/**
 * Order empty-table inserts "write backwards": highest flow index first, so
 * each insert leaves the lower recorded indexes valid. Returns descriptors,
 * not requests, so the tool can build `insertTableRequest`s with the descriptor
 * geometry. Asserts distinct anchors first so a colliding plan throws here
 * rather than silently corrupting the document downstream.
 */
export function tablesWriteBackwards(
  tables: TableDescriptor[],
): TableDescriptor[] {
  assertDistinctTableInsertIndices(tables);
  return [...tables].sort((a, b) => b.insertIndex - a.insertIndex);
}
