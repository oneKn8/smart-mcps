// Shared narrowing helpers for tool mappers. The Apps Script REST payloads
// occasionally omit fields or send unexpected types, so every slim mapper does
// the same "string-or-null / number-or-null / boolean-or-null" coercion.
// Extracting once keeps the per-resource mappers focused on field selection.

export function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Narrow an unknown to a plain object (not array, not null), or null. */
export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
