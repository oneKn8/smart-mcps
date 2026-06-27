import { ValidationError } from "smart-mcp-core";

/**
 * Extract a spreadsheet id from a docs.google.com URL of the form
 * `https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0`.
 */
const URL_ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

/**
 * A bare spreadsheet id: only the URL-safe characters Google uses in file ids
 * (`A-Z a-z 0-9 - _`), no spaces/slashes/punctuation. Anything else (e.g.
 * `"not a url"`) is rejected with a ValidationError.
 */
const BARE_ID_RE = /^[a-zA-Z0-9-_]+$/;

/**
 * Resolve a spreadsheet reference (a bare id OR a full Google Sheets URL) to
 * the bare spreadsheet id. Throws `ValidationError` on anything that is
 * neither.
 */
export function parseSpreadsheetId(input: string): string {
  const urlMatch = input.match(URL_ID_RE);
  if (urlMatch && urlMatch[1]) return urlMatch[1];
  if (BARE_ID_RE.test(input)) return input;
  throw new ValidationError(`not a spreadsheet id or url: ${input}`);
}

/**
 * Single-quote-wrap an A1 sheet (tab) title when it contains anything other
 * than `A-Z a-z 0-9 _`, doubling any embedded apostrophe per Google's A1
 * escaping convention (`Jon's` -> `'Jon''s'`). Plain titles pass through
 * unquoted.
 */
export function quoteSheetTitle(title: string): string {
  if (/[^A-Za-z0-9_]/.test(title)) {
    return `'${title.replace(/'/g, "''")}'`;
  }
  return title;
}
