import { nullableNumber, nullableString } from "./null-helpers.js";

/**
 * Slim Drive file shape returned by `list_sheets`. Source fields:
 * `id`, `name`, `modifiedTime`, `webViewLink`.
 */
export type SlimFile = {
  id: string | null;
  name: string | null;
  modified_time: string | null;
  url: string | null;
};

export function mapDriveFile(raw: unknown): SlimFile {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: nullableString(f.id),
    name: nullableString(f.name),
    modified_time: nullableString(f.modifiedTime),
    url: nullableString(f.webViewLink),
  };
}

/**
 * Slim per-tab shape returned by `get_sheet`. Derived from each
 * `sheets[].properties` block.
 */
export type SlimTab = {
  sheet_id: number | null;
  title: string | null;
  rows: number | null;
  cols: number | null;
  frozen_rows: number | null;
};

export type SlimSpreadsheet = {
  title: string | null;
  url: string | null;
  tabs: SlimTab[];
  named_ranges: unknown[];
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function mapTab(rawSheet: unknown): SlimTab {
  const props = asObject(asObject(rawSheet).properties);
  const grid = asObject(props.gridProperties);
  return {
    sheet_id: nullableNumber(props.sheetId),
    title: nullableString(props.title),
    rows: nullableNumber(grid.rowCount),
    cols: nullableNumber(grid.columnCount),
    frozen_rows: nullableNumber(grid.frozenRowCount),
  };
}

/**
 * Map a Sheets `spreadsheets.get` response (requested with the
 * `spreadsheetId,spreadsheetUrl,properties.title,sheets.properties,namedRanges`
 * fields mask) to the slim `get_sheet` output.
 */
export function mapSpreadsheetMeta(raw: unknown): SlimSpreadsheet {
  const s = asObject(raw);
  const props = asObject(s.properties);
  const sheets = Array.isArray(s.sheets) ? s.sheets : [];
  const named = Array.isArray(s.namedRanges) ? s.namedRanges : [];
  return {
    title: nullableString(props.title),
    url: nullableString(s.spreadsheetUrl),
    tabs: sheets.map(mapTab),
    named_ranges: named,
  };
}

/**
 * The `{ sheet_id, title }` pair returned by `create_sheet` and `add_tab`.
 */
export function mapTabRef(rawSheet: unknown): {
  sheet_id: number | null;
  title: string | null;
} {
  const props = asObject(asObject(rawSheet).properties);
  return {
    sheet_id: nullableNumber(props.sheetId),
    title: nullableString(props.title),
  };
}

/**
 * Build the `userEnteredValue` cell payload for a seed value passed to
 * `create_sheet`. Numbers become `numberValue`, booleans `boolValue`, a string
 * starting with `=` becomes a `formulaValue`, everything else `stringValue`.
 */
export function userEnteredCellValue(value: unknown): Record<string, unknown> {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { numberValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "string" && value.startsWith("=")) {
    return { formulaValue: value };
  }
  if (value === null || value === undefined) {
    return { stringValue: "" };
  }
  return { stringValue: String(value) };
}
