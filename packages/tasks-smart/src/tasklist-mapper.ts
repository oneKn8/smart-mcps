import { nullableString } from "./null-helpers.js";

/**
 * Slim task-list shape. Strips upstream `TaskList` noise (`kind`, `etag`,
 * `selfLink`). The Google `TaskList` resource is tiny — only `id`, `title`,
 * and `updated` carry user-facing meaning, so the slim shape is those three.
 *
 * - `id` is the opaque list identifier used as the `{tasklist}` path param.
 * - `title` is the display name (max 1024 chars upstream).
 * - `updated` is the RFC 3339 last-modification timestamp (output only),
 *   or `null` when Google omits it.
 *
 * Field-stripping is asserted in `tasklist-mapper.test.ts` via
 * `Object.keys(...).sort()`.
 */
export type SlimTaskList = {
  id: string;
  title: string;
  updated: string | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Convert a raw Google `TaskList` resource into the slim shape. Unknown
 * fields are dropped; missing `id`/`title` collapse to empty strings so the
 * slim shape stays total.
 */
export function mapTaskList(raw: unknown): SlimTaskList {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapTaskList: expected an object task-list resource");
  }
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    title: typeof obj.title === "string" ? obj.title : "",
    updated: nullableString(obj.updated),
  };
}
