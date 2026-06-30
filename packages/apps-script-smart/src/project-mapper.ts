import { asObject, nullableString } from "./null-helpers.js";

/**
 * Slim Apps Script project shape. Strips the upstream `User` objects
 * (`creator`, `lastModifyUser`) down to their email address, drops `kind`
 * and any future fields, and renames camelCase to snake_case.
 *
 * Both `projects.create` and `projects.get` return the same `Project`
 * resource, so this single mapper feeds both tools.
 */
export type SlimProject = {
  script_id: string;
  title: string;
  /** Drive ID of the container doc/sheet/form for a bound script; null for standalone. */
  parent_id: string | null;
  create_time: string | null;
  update_time: string | null;
  /** Creator's email, or null when the upstream `creator.email` is absent. */
  creator: string | null;
  /** Last modifier's email, or null when absent. */
  last_modify_user: string | null;
};

/** Pull `<user>.email` from a raw Google `User` object, or null. */
function userEmail(value: unknown): string | null {
  const obj = asObject(value);
  if (!obj) return null;
  return nullableString(obj.email);
}

/**
 * Convert a raw Google `Project` resource into the slim shape. Unknown
 * fields are dropped; missing fields collapse to null (or "" for the two
 * always-present identity fields) so the slim shape is total.
 */
export function mapProject(raw: unknown): SlimProject {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapProject: expected an object project resource");
  }
  return {
    script_id: typeof obj.scriptId === "string" ? obj.scriptId : "",
    title: typeof obj.title === "string" ? obj.title : "",
    parent_id: nullableString(obj.parentId),
    create_time: nullableString(obj.createTime),
    update_time: nullableString(obj.updateTime),
    creator: userEmail(obj.creator),
    last_modify_user: userEmail(obj.lastModifyUser),
  };
}
