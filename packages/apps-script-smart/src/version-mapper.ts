import { asObject, nullableNumber, nullableString } from "./null-helpers.js";

/**
 * Slim version shape. A version is an immutable, read-only snapshot of
 * project content with a system-assigned integer `versionNumber`.
 */
export type SlimVersion = {
  script_id: string | null;
  version_number: number | null;
  description: string | null;
  create_time: string | null;
};

/** Convert a raw Google `Version` resource into the slim shape. */
export function mapVersion(raw: unknown): SlimVersion {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapVersion: expected an object version resource");
  }
  return {
    script_id: nullableString(obj.scriptId),
    version_number: nullableNumber(obj.versionNumber),
    description: nullableString(obj.description),
    create_time: nullableString(obj.createTime),
  };
}
