import { ValidationError } from "smart-mcp-core";

/**
 * Pure builders for Google Docs `batchUpdate` Request union members, plus the
 * structural-validation guards that keep multi-edit paths from corrupting a
 * document.
 *
 * A `Request` is a union: each builder returns an object with exactly one
 * top-level key (`insertText`, `updateTextStyle`, ...). Nothing here performs
 * I/O — the client sends these objects verbatim as JSON.
 *
 * THE INDEX MODEL (verified, docs/research/2026-06-30-docs-api-reference.md):
 *   - Indexes are zero-based UTF-16 code-unit offsets. JS string `.length` is
 *     also UTF-16 code units, so a cursor advanced by `s.length` matches Google
 *     exactly (a surrogate-pair emoji counts as 2 in both).
 *   - A fresh document's body is `[ sectionBreak@[0,1), paragraph("\n")@[1,2) ]`.
 *     Index 0 is the section break (not writable); the first writable body
 *     index is 1. `BODY_START_INDEX` encodes that.
 *   - Within one `batchUpdate`, requests apply sequentially and every
 *     insert/delete renumbers all higher indexes. Callers must either insert
 *     all text first then style by ranges recorded against the final layout, OR
 *     emit mutations in descending index order ("write backwards").
 */

/** A single `batchUpdate` request (one union member). */
export type DocsRequest = Record<string, unknown>;

/** First writable index in a document body (index 0 is the section break). */
export const BODY_START_INDEX = 1;

/** A point dimension, e.g. font size or indent magnitude. */
export type Dimension = { magnitude: number; unit: "PT" };

function pt(magnitude: number): Dimension {
  return { magnitude, unit: "PT" };
}

// ===========================================================================
// Field-mask helper (CRITICAL: every update*Style request needs a `fields`
// mask listing EXACTLY the sub-fields being written; over/under-listing is
// silently wrong). Object key-insertion order is preserved for string keys, so
// builders that add keys in a fixed order yield a deterministic mask.
// ===========================================================================

export function fieldsMask(style: Record<string, unknown>): string {
  return Object.keys(style).join(",");
}

// ===========================================================================
// Color helper
// ===========================================================================

export type OptionalColor = {
  color: { rgbColor: { red: number; green: number; blue: number } };
};

/** Parse `#RRGGBB` (or `RRGGBB`) into a Docs `OptionalColor` (0..1 channels). */
export function hexToColor(hex: string): OptionalColor {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) {
    throw new ValidationError(
      `Invalid hex color "${hex}"; expected #RRGGBB (e.g. "#1a73e8").`,
    );
  }
  const n = Number.parseInt(m[1] as string, 16);
  return {
    color: {
      rgbColor: {
        red: ((n >> 16) & 0xff) / 255,
        green: ((n >> 8) & 0xff) / 255,
        blue: (n & 0xff) / 255,
      },
    },
  };
}

// ===========================================================================
// Text / location primitives
// ===========================================================================

/**
 * Insert text. Pass `endOfSegment: true` to append to the end of the body
 * (index-math-free), otherwise an explicit `index` (>= 1) is required.
 */
export function insertTextRequest(opts: {
  text: string;
  index?: number;
  endOfSegment?: boolean;
}): DocsRequest {
  if (opts.endOfSegment === true) {
    return { insertText: { text: opts.text, endOfSegmentLocation: {} } };
  }
  if (opts.index === undefined) {
    throw new ValidationError(
      "insertTextRequest requires either `index` or `endOfSegment: true`.",
    );
  }
  assertValidInsertIndex(opts.index);
  return { insertText: { text: opts.text, location: { index: opts.index } } };
}

export function deleteContentRangeRequest(opts: {
  startIndex: number;
  endIndex: number;
}): DocsRequest {
  return {
    deleteContentRange: {
      range: { startIndex: opts.startIndex, endIndex: opts.endIndex },
    },
  };
}

export function replaceAllTextRequest(opts: {
  find: string;
  replace: string;
  matchCase?: boolean;
}): DocsRequest {
  return {
    replaceAllText: {
      containsText: { text: opts.find, matchCase: opts.matchCase === true },
      replaceText: opts.replace,
    },
  };
}

// ===========================================================================
// Text style (character formatting)
// ===========================================================================

export type TextStyleInput = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number; // points
  fontFamily?: string;
  foregroundColorHex?: string;
  linkUrl?: string;
};

/**
 * Build a `{ textStyle, fields }` pair from exactly the attributes the caller
 * set. Keys are added in a fixed canonical order so the derived `fields` mask
 * is deterministic. Returns `null` when no attribute was supplied (caller
 * should reject — a no-field updateTextStyle is a silent no-op).
 */
export function buildTextStyle(
  input: TextStyleInput,
): { textStyle: Record<string, unknown>; fields: string } | null {
  const style: Record<string, unknown> = {};
  if (input.bold !== undefined) style.bold = input.bold;
  if (input.italic !== undefined) style.italic = input.italic;
  if (input.underline !== undefined) style.underline = input.underline;
  if (input.strikethrough !== undefined) {
    style.strikethrough = input.strikethrough;
  }
  if (input.fontSize !== undefined) style.fontSize = pt(input.fontSize);
  if (input.fontFamily !== undefined) {
    style.weightedFontFamily = { fontFamily: input.fontFamily };
  }
  if (input.foregroundColorHex !== undefined) {
    style.foregroundColor = hexToColor(input.foregroundColorHex);
  }
  if (input.linkUrl !== undefined) style.link = { url: input.linkUrl };
  if (Object.keys(style).length === 0) return null;
  return { textStyle: style, fields: fieldsMask(style) };
}

export function updateTextStyleRequest(opts: {
  startIndex: number;
  endIndex: number;
  textStyle: Record<string, unknown>;
  fields: string;
}): DocsRequest {
  return {
    updateTextStyle: {
      range: { startIndex: opts.startIndex, endIndex: opts.endIndex },
      textStyle: opts.textStyle,
      fields: opts.fields,
    },
  };
}

// ===========================================================================
// Paragraph style
// ===========================================================================

export const NAMED_STYLE_TYPES = [
  "NORMAL_TEXT",
  "TITLE",
  "SUBTITLE",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "HEADING_4",
  "HEADING_5",
  "HEADING_6",
] as const;
export type NamedStyleType = (typeof NAMED_STYLE_TYPES)[number];

export const ALIGNMENTS = ["START", "CENTER", "END", "JUSTIFIED"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

export type ParagraphStyleInput = {
  namedStyleType?: NamedStyleType;
  alignment?: Alignment;
  lineSpacing?: number;
  spaceAbove?: number; // points
  spaceBelow?: number; // points
  indentStart?: number; // points
  indentFirstLine?: number; // points
};

export function buildParagraphStyle(
  input: ParagraphStyleInput,
): { paragraphStyle: Record<string, unknown>; fields: string } | null {
  const style: Record<string, unknown> = {};
  if (input.namedStyleType !== undefined) {
    style.namedStyleType = input.namedStyleType;
  }
  if (input.alignment !== undefined) style.alignment = input.alignment;
  if (input.lineSpacing !== undefined) style.lineSpacing = input.lineSpacing;
  if (input.spaceAbove !== undefined) style.spaceAbove = pt(input.spaceAbove);
  if (input.spaceBelow !== undefined) style.spaceBelow = pt(input.spaceBelow);
  if (input.indentStart !== undefined) {
    style.indentStart = pt(input.indentStart);
  }
  if (input.indentFirstLine !== undefined) {
    style.indentFirstLine = pt(input.indentFirstLine);
  }
  if (Object.keys(style).length === 0) return null;
  return { paragraphStyle: style, fields: fieldsMask(style) };
}

export function updateParagraphStyleRequest(opts: {
  startIndex: number;
  endIndex: number;
  paragraphStyle: Record<string, unknown>;
  fields: string;
}): DocsRequest {
  return {
    updateParagraphStyle: {
      range: { startIndex: opts.startIndex, endIndex: opts.endIndex },
      paragraphStyle: opts.paragraphStyle,
      fields: opts.fields,
    },
  };
}

// ===========================================================================
// Bullets
// ===========================================================================

export const UNORDERED_BULLET_PRESET = "BULLET_DISC_CIRCLE_SQUARE";
export const ORDERED_BULLET_PRESET = "NUMBERED_DECIMAL_ALPHA_ROMAN";

export function createParagraphBulletsRequest(opts: {
  startIndex: number;
  endIndex: number;
  bulletPreset: string;
}): DocsRequest {
  return {
    createParagraphBullets: {
      range: { startIndex: opts.startIndex, endIndex: opts.endIndex },
      bulletPreset: opts.bulletPreset,
    },
  };
}

export function deleteParagraphBulletsRequest(opts: {
  startIndex: number;
  endIndex: number;
}): DocsRequest {
  return {
    deleteParagraphBullets: {
      range: { startIndex: opts.startIndex, endIndex: opts.endIndex },
    },
  };
}

// ===========================================================================
// Table / image / page break
// ===========================================================================

export function insertTableRequest(opts: {
  rows: number;
  columns: number;
  index?: number;
  endOfSegment?: boolean;
}): DocsRequest {
  if (opts.endOfSegment === true) {
    return {
      insertTable: {
        rows: opts.rows,
        columns: opts.columns,
        endOfSegmentLocation: {},
      },
    };
  }
  if (opts.index === undefined) {
    throw new ValidationError(
      "insertTableRequest requires either `index` or `endOfSegment: true`.",
    );
  }
  assertValidInsertIndex(opts.index);
  return {
    insertTable: {
      rows: opts.rows,
      columns: opts.columns,
      location: { index: opts.index },
    },
  };
}

export function insertInlineImageRequest(opts: {
  uri: string;
  index?: number;
  endOfSegment?: boolean;
  width?: number; // points
  height?: number; // points
}): DocsRequest {
  const image: Record<string, unknown> = { uri: opts.uri };
  if (opts.width !== undefined || opts.height !== undefined) {
    const objectSize: Record<string, unknown> = {};
    if (opts.width !== undefined) objectSize.width = pt(opts.width);
    if (opts.height !== undefined) objectSize.height = pt(opts.height);
    image.objectSize = objectSize;
  }
  if (opts.endOfSegment === true) {
    image.endOfSegmentLocation = {};
    return { insertInlineImage: image };
  }
  if (opts.index === undefined) {
    throw new ValidationError(
      "insertInlineImageRequest requires either `index` or `endOfSegment: true`.",
    );
  }
  assertValidInsertIndex(opts.index);
  image.location = { index: opts.index };
  return { insertInlineImage: image };
}

export function insertPageBreakRequest(opts: {
  index?: number;
  endOfSegment?: boolean;
}): DocsRequest {
  if (opts.endOfSegment === true) {
    return { insertPageBreak: { endOfSegmentLocation: {} } };
  }
  if (opts.index === undefined) {
    throw new ValidationError(
      "insertPageBreakRequest requires either `index` or `endOfSegment: true`.",
    );
  }
  assertValidInsertIndex(opts.index);
  return { insertPageBreak: { location: { index: opts.index } } };
}

// ===========================================================================
// Document-structure helpers + validation guards (operate on a documents.get
// response). These enforce the two hard rules: never insert at a table's start
// index, never delete a segment's final newline.
// ===========================================================================

type StructuralElement = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: { elements?: unknown[] };
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{ content?: StructuralElement[]; startIndex?: number }>;
    }>;
  };
  sectionBreak?: unknown;
  tableOfContents?: unknown;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Return `document.body.content` as a structural-element array (or `[]`). */
export function bodyContent(doc: unknown): StructuralElement[] {
  const obj = asObject(doc);
  const body = obj ? asObject(obj.body) : null;
  const content = body?.content;
  return Array.isArray(content) ? (content as StructuralElement[]) : [];
}

/**
 * The body's end index = the `endIndex` of its last structural element. The
 * final newline that cannot be deleted occupies `[endIndex - 1, endIndex)`.
 * Returns `BODY_START_INDEX` for an empty/odd body so guards stay conservative.
 */
export function documentEndIndex(doc: unknown): number {
  const content = bodyContent(doc);
  let end = BODY_START_INDEX;
  for (const el of content) {
    if (typeof el.endIndex === "number" && el.endIndex > end) {
      end = el.endIndex;
    }
  }
  return end;
}

/** Start indexes of every top-level table element. */
export function tableStartIndices(doc: unknown): number[] {
  const out: number[] = [];
  for (const el of bodyContent(doc)) {
    if (el.table && typeof el.startIndex === "number") {
      out.push(el.startIndex);
    }
  }
  return out;
}

export function assertValidInsertIndex(index: number): void {
  if (!Number.isInteger(index) || index < BODY_START_INDEX) {
    throw new ValidationError(
      `Insert index must be an integer >= ${BODY_START_INDEX} (got ${index}); ` +
        `index 0 is the document's section break and is not writable.`,
    );
  }
}

/**
 * Reject inserting text exactly at a table's start index. The Docs API forbids
 * it ("text cannot be inserted at a table's start index") — insert into the
 * preceding paragraph instead.
 */
export function assertNotTableStartIndex(doc: unknown, index: number): void {
  if (tableStartIndices(doc).includes(index)) {
    throw new ValidationError(
      `Index ${index} is a table's start index; text cannot be inserted there. ` +
        `Insert into the paragraph before the table (index ${index - 1}) instead.`,
    );
  }
}

/**
 * Guard a delete range against the two failure modes: an out-of-range/empty
 * range, and deleting the body's final newline (which Google forbids for a
 * Body/Header/Footer/Footnote/TableCell).
 */
export function assertDeletableRange(
  doc: unknown,
  startIndex: number,
  endIndex: number,
): void {
  if (!Number.isInteger(startIndex) || startIndex < BODY_START_INDEX) {
    throw new ValidationError(
      `Delete startIndex must be an integer >= ${BODY_START_INDEX} (got ${startIndex}).`,
    );
  }
  if (!Number.isInteger(endIndex) || endIndex <= startIndex) {
    throw new ValidationError(
      `Delete endIndex (${endIndex}) must be an integer greater than startIndex (${startIndex}).`,
    );
  }
  const end = documentEndIndex(doc);
  // endIndex is exclusive; the final newline lives at [end-1, end). Any range
  // whose endIndex reaches `end` would delete that newline.
  if (endIndex >= end) {
    throw new ValidationError(
      `Cannot delete the document's final newline (range endIndex ${endIndex} ` +
        `reaches body end ${end}); the last deletable index is ${end - 1}.`,
    );
  }
}

/**
 * Cell insertion points for a top-level table, in row-major order. Each entry
 * is the start index of the cell's first paragraph — the index to `insertText`
 * into an (empty) cell. Reads a real documents.get response, so no fragile
 * geometry math. `tableOrdinal` selects the Nth table (0-based) in body order.
 */
export type TableCellSlot = { row: number; column: number; index: number };

export function tableCellSlots(
  doc: unknown,
  tableOrdinal: number,
): { rows: number; columns: number; slots: TableCellSlot[] } {
  const tables = bodyContent(doc).filter((el) => el.table);
  const target = tables[tableOrdinal];
  if (!target || !target.table) {
    throw new ValidationError(
      `Table #${tableOrdinal} not found (document has ${tables.length} table(s)).`,
    );
  }
  const tableRows = target.table.tableRows ?? [];
  const slots: TableCellSlot[] = [];
  let columns = 0;
  tableRows.forEach((tr, row) => {
    const cells = tr.tableCells ?? [];
    if (cells.length > columns) columns = cells.length;
    cells.forEach((cell, column) => {
      const first = (cell.content ?? [])[0];
      const idx =
        first && typeof first.startIndex === "number"
          ? first.startIndex
          : typeof cell.startIndex === "number"
            ? cell.startIndex + 1
            : undefined;
      if (idx !== undefined) slots.push({ row, column, index: idx });
    });
  });
  return { rows: tableRows.length, columns, slots };
}
