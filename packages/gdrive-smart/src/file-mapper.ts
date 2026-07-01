import { nullableString } from "./null-helpers.js";

/**
 * Slim Drive file shape. Strips upstream noise (`kind`, `etag`,
 * `shortcutDetails`, `owners`, `capabilities`, `md5Checksum`, etc.) and
 * renames Google's camelCase fields to the snake_case tool surface.
 *
 * `size` is surfaced as a string because Drive returns it in int64 string
 * form (e.g. `"1048576"`); native docs/folders omit it entirely, so the
 * absence collapses to `null`.
 *
 * Field-stripping is asserted in the mapper unit tests via
 * `Object.keys(...).sort()` so upstream additions cannot leak through.
 */
export type SlimFile = {
  id: string;
  name: string;
  mime_type: string;
  /**
   * Parent folder ids. Drive files have at most one parent in My Drive;
   * `root`-level items and some shared items omit `parents`, which collapses
   * to an empty array.
   */
  parents: string[];
  web_view_link: string | null;
  trashed: boolean;
  starred: boolean;
  /** int64 byte count as a string, or null for folders / native docs. */
  size: string | null;
  modified_time: string | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Convert a raw Google Drive File resource into the slim shape. Unknown
 * fields are dropped; missing fields collapse to safe defaults so the slim
 * shape is total. `parents` is normalized to a string array (non-string
 * entries are filtered out).
 */
export function mapFile(raw: unknown): SlimFile {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapFile: expected an object file resource");
  }
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    name: typeof obj.name === "string" ? obj.name : "",
    mime_type: typeof obj.mimeType === "string" ? obj.mimeType : "",
    parents: Array.isArray(obj.parents)
      ? obj.parents.filter((p): p is string => typeof p === "string")
      : [],
    web_view_link: nullableString(obj.webViewLink),
    trashed: obj.trashed === true,
    starred: obj.starred === true,
    size: nullableString(obj.size),
    modified_time: nullableString(obj.modifiedTime),
  };
}
