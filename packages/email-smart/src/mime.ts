import { randomBytes, randomUUID } from "node:crypto";
import type { Identity } from "./identities.js";

const CRLF = "\r\n";
const X_SENT_BY_AGENT = "smart-mcps-email/1.0";
const DEFAULT_X_MAILER_PRODUCT = "santo-mailer/1.0";
const FALLBACK_DOMAIN = "santo-agent";

export type BuildRawMessageOpts = {
  identity: Identity;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  headers?: Record<string, string>;
};

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

/**
 * RFC 2047 base64 "encoded-word" form for non-ASCII header values. ASCII
 * inputs are returned untouched.
 */
function encodeHeaderValue(value: string): string {
  if (isAscii(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `=?utf-8?B?${b64}?=`;
}

/**
 * RFC 5322 address shape. If display name has non-ASCII characters, the name
 * portion is RFC 2047 encoded; otherwise it is quoted only if it contains
 * special characters. For our needs (controlled identity yaml inputs), a
 * simple "Display <addr>" with optional encoded-word covers the spec.
 */
function formatAddress(displayName: string, email: string): string {
  const name = isAscii(displayName)
    ? displayName
    : encodeHeaderValue(displayName);
  return `${name} <${email}>`;
}

function senderDomain(email: string): string {
  const at = email.indexOf("@");
  if (at === -1 || at === email.length - 1) return FALLBACK_DOMAIN;
  return email.slice(at + 1);
}

function generateBoundary(): string {
  return `=_${randomBytes(12).toString("hex")}`;
}

function rfc5322Date(): string {
  // Node's Date#toUTCString returns RFC 7231 / RFC 5322 compliant form:
  //   "Tue, 28 Apr 2026 12:00:00 GMT"
  return new Date().toUTCString();
}

function bodyPart(boundary: string, contentType: string, body: string): string {
  return [
    `--${boundary}`,
    `Content-Type: ${contentType}; charset=utf-8`,
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    "",
  ].join(CRLF);
}

export function buildRawMessage(opts: BuildRawMessageOpts): string {
  const { identity } = opts;
  const fromHeader = formatAddress(identity.display_name, identity.email);
  const replyTo =
    opts.reply_to ?? identity.default_reply_to ?? identity.email;
  const domain = senderDomain(identity.email);
  const messageId = `<${randomUUID()}@${domain}>`;
  const boundary = generateBoundary();

  // Defaults first, custom headers override.
  const headers: Record<string, string> = {
    From: fromHeader,
    To: opts.to,
    Subject: encodeHeaderValue(opts.subject),
    Date: rfc5322Date(),
    "Message-ID": messageId,
    "Reply-To": replyTo,
    "MIME-Version": "1.0",
    "Content-Type": `multipart/alternative; boundary="${boundary}"`,
    "Auto-Submitted": "no",
    "X-Mailer": `${DEFAULT_X_MAILER_PRODUCT} (on behalf of ${identity.display_name})`,
    "X-Sent-By-Agent": X_SENT_BY_AGENT,
    "X-Agent-Operator": identity.email,
  };
  if (opts.cc !== undefined && opts.cc !== "") headers["Cc"] = opts.cc;
  if (opts.bcc !== undefined && opts.bcc !== "") headers["Bcc"] = opts.bcc;
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers[k] = v;
    }
  }

  // Header order: emit in insertion order. Object.entries on the object above
  // preserves insertion order per spec, so defaults appear first and any
  // explicit overrides keep their original keys' positions.
  const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);

  // multipart/alternative: plain FIRST, html SECOND (RFC 2046 — clients pick
  // the LAST preferred renderable part).
  const body = [
    bodyPart(boundary, "text/plain", opts.text),
    bodyPart(boundary, "text/html", opts.html),
    `--${boundary}--`,
    "",
  ].join(CRLF);

  const message = headerLines.join(CRLF) + CRLF + CRLF + body;
  return Buffer.from(message, "utf8").toString("base64url");
}
