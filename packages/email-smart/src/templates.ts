import * as fs from "node:fs";
import * as path from "node:path";
import { NotFoundError, ValidationError } from "smart-mcp-core";

function templateDir(home: string): string {
  return path.join(home, ".santo-agent", "templates");
}

function templateFile(home: string, name: string): string {
  return path.join(templateDir(home), `${name}.html`);
}

function resolveHome(home: string | undefined): string {
  if (home !== undefined) return home;
  const env = process.env.HOME;
  if (!env) {
    throw new ValidationError(
      "HOME environment variable is not set; cannot locate ~/.santo-agent/templates",
    );
  }
  return env;
}

/**
 * Read `<HOME>/.santo-agent/templates/<name>.html` and return the raw string.
 * Throws NotFoundError (with the resolved path embedded in the message) when
 * the file does not exist. HOME is resolved lazily at call time so the server
 * can boot before the env var is set (mirrors `identities.ts` and `audit.ts`).
 */
export function loadTemplate(name: string, home?: string): string {
  const root = resolveHome(home);
  const filePath = templateFile(root, name);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError(`template not found: ${name} at ${filePath}`);
    }
    throw err;
  }
}

// Match `{{KEY}}` where KEY is one or more uppercase/lowercase ASCII letters,
// digits, or underscores. No back-references, no nested braces — bounded
// linear-time match, immune to ReDoS. Single-pass replace; substituted values
// are NOT re-scanned (prevents template injection via user-supplied vars).
const TEMPLATE_VAR_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;

/**
 * Replace every `{{KEY}}` in `template` with `vars.KEY`. Throws
 * ValidationError if the template references a key not present in `vars`.
 * Vars keys not referenced in the template are silently ignored. The
 * substitution is a single pass — values containing `{{X}}` are NOT
 * re-expanded, which closes a template-injection vector where caller-supplied
 * content could pull in other template vars.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(TEMPLATE_VAR_RE, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new ValidationError(
        `template references undefined variable: ${key}`,
      );
    }
    return vars[key]!;
  });
}

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#39);/g;

// Tags that produce a paragraph break in the derived plain-text. We treat any
// occurrence (open OR close, with or without attrs) as a single newline so
// `<p>one</p><p>two</p>` becomes "one\ntwo" rather than running together.
const BLOCK_TAG_RE =
  /<\s*\/?\s*(?:p|div|br|h[1-6]|li|tr|td|table|blockquote|hr|section|article|header|footer|main|nav|aside|figure|figcaption|address|pre)\b[^>]*>/gi;

const ANY_TAG_RE = /<[^>]*>/g;

/**
 * Best-effort plain-text fallback for the multipart/alternative `text` part.
 * Strips HTML, decodes a small set of common entities, and converts block-level
 * tags into newlines. Not perfect — Gmail clients overwhelmingly render the
 * HTML part — but this gives us a deliverability hedge that says something
 * legible when the receiving client falls back to text.
 */
export function deriveTextFromHtml(html: string): string {
  if (html.length === 0) return "";
  // 1. block-level tags → newlines (preserves paragraph structure).
  let out = html.replace(BLOCK_TAG_RE, "\n");
  // 2. all remaining tags → empty.
  out = out.replace(ANY_TAG_RE, "");
  // 3. decode common entities.
  out = out.replace(ENTITY_RE, (m) => HTML_ENTITY_MAP[m] ?? m);
  // 4. collapse runs of horizontal whitespace into a single space, but keep
  //    newlines as-is so paragraph breaks survive.
  out = out.replace(/[ \t\r\f\v]+/g, " ");
  // 5. collapse 3+ consecutive newlines to a maximum of 2.
  out = out.replace(/\n{3,}/g, "\n\n");
  // 6. trim spaces around newlines.
  out = out.replace(/ *\n */g, "\n");
  // 7. trim leading/trailing whitespace.
  return out.trim();
}
