import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal dotenv parser supporting:
 *   - KEY=value (unquoted, trimmed; trailing # comment stripped)
 *   - KEY="value" (double-quoted; supports \n \t \\ \" escapes; preserves spaces and #)
 *   - KEY='value' (single-quoted; literal, no escape interpretation)
 *   - # full-line comments and blank lines (ignored)
 *   - Lines that don't match KEY=... are silently skipped (forward-compat)
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2] ?? "";
    if (!key) continue;
    out[key] = parseValue(rest);
  }
  return out;
}

function parseValue(raw: string): string {
  if (raw.startsWith('"')) {
    const end = findClosingQuote(raw, '"');
    if (end === -1) return raw;
    return unescapeDouble(raw.slice(1, end));
  }
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    if (end === -1) return raw;
    return raw.slice(1, end);
  }
  // Unquoted: strip trailing # comment, then trim trailing whitespace.
  const hashIdx = raw.indexOf("#");
  const noComment = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
  return noComment.trim();
}

function findClosingQuote(raw: string, quote: '"' | "'"): number {
  // Walk past index 0 (the opening quote). Honor backslash-escapes for double quotes.
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i];
    if (quote === '"' && ch === "\\") {
      i++; // skip escaped char
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

function unescapeDouble(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      switch (next) {
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "r": out += "\r"; break;
        case "\\": out += "\\"; break;
        case '"': out += '"'; break;
        default: out += next; break;
      }
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Read a dotenv file at the given path. Returns {} if the file doesn't exist
 * or can't be read; never throws.
 */
export function readDotenvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
