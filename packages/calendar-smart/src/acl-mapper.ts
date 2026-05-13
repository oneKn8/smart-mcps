import { nullableString } from "./null-helpers.js";

/**
 * Slim ACL rule shape. Strips upstream noise (`kind`, `etag`) and flattens
 * Google's nested `scope: { type, value }` block into top-level
 * `scope_type` / `scope_value` for the LLM-facing tool surface.
 *
 * Rule IDs follow the format `{scope.type}:{scope.value}` for `user`,
 * `group`, and `domain` scopes (e.g. `user:alice@example.com`,
 * `domain:example.com`). For `default` scope (anyone with the link) the
 * id is the literal string `default`.
 *
 * Field-stripping is asserted in the mapper unit tests via
 * `Object.keys(...).sort()` so upstream additions cannot leak through.
 */
export type SlimAclRule = {
  id: string;
  role: "none" | "freeBusyReader" | "reader" | "writer" | "owner";
  scope_type: "default" | "user" | "group" | "domain";
  /**
   * The principal the rule applies to: an email address for `user`/`group`,
   * a domain name for `domain`, or `null` for `default` (public — anyone
   * with the link). Google explicitly omits `value` from the wire payload
   * for default scopes; we surface the absence as `null`.
   */
  scope_value: string | null;
};

const ROLE_VALUES = new Set([
  "none",
  "freeBusyReader",
  "reader",
  "writer",
  "owner",
]);

const SCOPE_TYPE_VALUES = new Set(["default", "user", "group", "domain"]);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickRole(raw: Record<string, unknown>): SlimAclRule["role"] {
  if (typeof raw.role === "string" && ROLE_VALUES.has(raw.role)) {
    return raw.role as SlimAclRule["role"];
  }
  // Default to the most-restrictive role. If Google adds a new role and we
  // don't recognize it, treating it as `none` (no access) is safe.
  return "none";
}

function pickScopeType(scope: Record<string, unknown>): SlimAclRule["scope_type"] {
  if (typeof scope.type === "string" && SCOPE_TYPE_VALUES.has(scope.type)) {
    return scope.type as SlimAclRule["scope_type"];
  }
  // Default to `default` (public) when missing or unknown — matches Google's
  // own behavior on the rare wire payloads with an absent scope block.
  return "default";
}

/**
 * Convert a raw Google ACL rule resource into the slim shape. Unknown fields
 * are dropped; missing fields collapse to safe defaults so the slim shape is
 * total. The nested `scope: { type, value }` block is flattened into top-level
 * `scope_type` / `scope_value` for the tool surface.
 */
export function mapAclRule(raw: unknown): SlimAclRule {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapAclRule: expected an object ACL rule resource");
  }
  const scope = asObject(obj.scope) ?? {};
  return {
    id: typeof obj.id === "string" ? obj.id : "",
    role: pickRole(obj),
    scope_type: pickScopeType(scope),
    // `scope.value` is omitted for `default` scopes; surface as null.
    scope_value: nullableString(scope.value),
  };
}
