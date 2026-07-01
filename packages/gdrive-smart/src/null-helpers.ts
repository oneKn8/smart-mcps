// Shared narrowing helpers for tool mappers. Google Drive's REST payloads
// occasionally omit fields or send unexpected types, so every slim mapper does
// the same "string-or-null / number-or-null / boolean-or-null" coercion.
// Extracting once keeps the per-tool mappers focused on field selection.

export function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
