import { nullableString, nullableBoolean } from "./null-helpers.js";

/**
 * Slim Drive permission shape. Strips upstream noise (`kind`, `etag`,
 * `displayName`, `photoLink`, `deleted`, `pendingOwner`, etc.) and keeps only
 * the fields a caller needs to reason about who has access.
 *
 * `email_address` is present for `user`/`group` scopes, `domain` for the
 * `domain` scope, and both are `null` for the `anyone` (public/link) scope.
 *
 * Field-stripping is asserted in the mapper unit tests via
 * `Object.keys(...).sort()` so upstream additions cannot leak through.
 */
export type SlimPermission = {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: "owner" | "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader";
  email_address: string | null;
  domain: string | null;
  /**
   * For `domain`/`anyone` grants: `true` = a discoverable/searchable link,
   * `false` = anyone-with-the-link only. `null` when Drive omits it (e.g.
   * user/group grants, where it has no meaning) (L3).
   */
  allow_file_discovery: boolean | null;
};

const TYPE_VALUES = new Set(["user", "group", "domain", "anyone"]);
const ROLE_VALUES = new Set([
  "owner",
  "organizer",
  "fileOrganizer",
  "writer",
  "commenter",
  "reader",
]);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickType(raw: Record<string, unknown>): SlimPermission["type"] {
  if (typeof raw.type === "string" && TYPE_VALUES.has(raw.type)) {
    return raw.type as SlimPermission["type"];
  }
  // Default to `user` (a specific, non-public principal) when the type is
  // missing or unrecognized — never silently widen to the public `anyone`.
  return "user";
}

function pickRole(raw: Record<string, unknown>): SlimPermission["role"] {
  if (typeof raw.role === "string" && ROLE_VALUES.has(raw.role)) {
    return raw.role as SlimPermission["role"];
  }
  // Default to the most-restrictive role. If Google adds a new role and we
  // don't recognize it, treating it as `reader` (view-only) is safe.
  return "reader";
}

/**
 * Convert a raw Google Drive Permission resource into the slim shape.
 * Unknown fields are dropped; missing fields collapse to safe defaults so the
 * slim shape is total.
 */
export function mapPermission(raw: unknown): SlimPermission {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapPermission: expected an object permission resource");
  }
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    type: pickType(obj),
    role: pickRole(obj),
    email_address: nullableString(obj.emailAddress),
    domain: nullableString(obj.domain),
    allow_file_discovery: nullableBoolean(obj.allowFileDiscovery),
  };
}
