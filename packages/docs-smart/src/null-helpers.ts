// Shared narrowing helpers for slim mappers. Google Docs REST payloads
// occasionally omit fields or send unexpected types, so the mappers do the same
// "string-or-null / number-or-null / boolean-or-null" coercion. Extracting once
// keeps the per-resource mappers focused on field selection. Mirrors the
// identical helper in calendar-smart (the canonical Google-API template).

export function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
