import * as fs from "node:fs";
import * as path from "node:path";
import { ValidationError } from "smart-mcp-core";

export type AuditEntry = {
  ts: string;
  account: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  gmail_id: string;
  gmail_thread_id: string;
  /**
   * Number of attachments included in the send. Only set by send_with_attachment
   * tool; legacy send_email entries (and Python writer entries) omit it. Reader
   * tolerates absence.
   */
  attachment_count?: number;
};

// Field order matches what Python `bin/send-email.py` writes so JSONL grep /
// column-position queries work uniformly across Python + TS senders. The
// optional `attachment_count` field is appended only when present (not in
// AUDIT_FIELDS so reader treats Python entries without it as valid).
const AUDIT_FIELDS = [
  "ts",
  "account",
  "to",
  "cc",
  "bcc",
  "subject",
  "gmail_id",
  "gmail_thread_id",
] as const;

function resolveHome(home: string | undefined): string {
  if (home !== undefined) return home;
  const env = process.env.HOME;
  if (!env) {
    throw new ValidationError(
      "HOME environment variable is not set; cannot locate ~/.santo-agent/audit",
    );
  }
  return env;
}

function auditDir(home: string): string {
  return path.join(home, ".santo-agent", "audit");
}

function auditFile(home: string): string {
  return path.join(auditDir(home), "send-log.jsonl");
}

/**
 * Append a send entry to ~/.santo-agent/audit/send-log.jsonl. Creates the
 * directory and file if missing. Optional cc/bcc are coerced to "" so the
 * on-disk shape matches Python's writer (which always emits the keys).
 */
export function appendAudit(entry: AuditEntry, home?: string): void {
  const root = resolveHome(home);
  const dir = auditDir(root);
  fs.mkdirSync(dir, { recursive: true });

  const ordered: Record<string, string | number> = {
    ts: entry.ts,
    account: entry.account,
    to: entry.to,
    cc: entry.cc ?? "",
    bcc: entry.bcc ?? "",
    subject: entry.subject,
    gmail_id: entry.gmail_id,
    gmail_thread_id: entry.gmail_thread_id,
  };

  // Append attachment_count ONLY when set to a positive integer. Keeps the
  // on-disk JSONL shape identical to Python's writer for non-attachment sends
  // so audit-log reader tooling that hard-codes 8 keys continues to match.
  if (
    typeof entry.attachment_count === "number" &&
    entry.attachment_count > 0
  ) {
    ordered.attachment_count = entry.attachment_count;
  }

  fs.appendFileSync(auditFile(root), JSON.stringify(ordered) + "\n");
}

/**
 * Read the audit log into memory. Returns [] when the file is missing.
 * Lines that don't parse as JSON or fail field validation are skipped.
 */
export function readAudit(home?: string): AuditEntry[] {
  const root = resolveHome(home);
  const file = auditFile(root);
  if (!fs.existsSync(file)) return [];

  const raw = fs.readFileSync(file, "utf-8");
  const out: AuditEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = coerceEntry(parsed);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

function coerceEntry(value: unknown): AuditEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  for (const field of AUDIT_FIELDS) {
    if (typeof obj[field] !== "string") return undefined;
  }
  const entry: AuditEntry = {
    ts: obj.ts as string,
    account: obj.account as string,
    to: obj.to as string,
    cc: obj.cc as string,
    bcc: obj.bcc as string,
    subject: obj.subject as string,
    gmail_id: obj.gmail_id as string,
    gmail_thread_id: obj.gmail_thread_id as string,
  };
  // attachment_count is optional. Only carry it through when it's a number;
  // Python entries and pre-attachment-feature TS entries lack the field.
  if (typeof obj.attachment_count === "number") {
    entry.attachment_count = obj.attachment_count;
  }
  return entry;
}
