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

/**
 * One resolved attachment ready for MIME assembly. The caller is responsible
 * for resolving `path` / `data` to raw bytes BEFORE invoking the builder so
 * size validation, filename validation, and content-type inference all live
 * in the tool layer (which has access to the user-facing input schema).
 */
export type AttachmentPart = {
  filename: string;
  content_type: string;
  bytes: Buffer;
};

export type BuildRawMessageWithAttachmentsOpts = BuildRawMessageOpts & {
  attachments: AttachmentPart[];
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

function generateBoundary(prefix: string): string {
  return `=_${prefix}_${randomBytes(12).toString("hex")}`;
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

/**
 * Build the multipart/alternative body (no top-level outer headers). Returns
 * an object with the raw body string AND the boundary used so callers can
 * either prepend their own outer headers (for top-level use) or wrap this
 * body inside an outer multipart/mixed for attachment-bearing messages.
 *
 * The first child is text/plain, the second is text/html. RFC 2046: clients
 * pick the LAST renderable preferred part — keeping html second matches what
 * users expect (rich rendering when supported, plaintext fallback otherwise).
 */
export function buildAlternativeBody(opts: {
  text: string;
  html: string;
}): { body: string; boundary: string; contentType: string } {
  const boundary = generateBoundary("alt");
  const body = [
    bodyPart(boundary, "text/plain", opts.text),
    bodyPart(boundary, "text/html", opts.html),
    `--${boundary}--`,
    "",
  ].join(CRLF);
  return {
    body,
    boundary,
    contentType: `multipart/alternative; boundary="${boundary}"`,
  };
}

type TopLevelHeadersOpts = {
  identity: Identity;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  reply_to?: string;
  headers?: Record<string, string>;
  contentType: string;
};

/**
 * Build the ordered top-level header lines (From, To, Subject, etc.) that go
 * on the outermost MIME part. The Content-Type is supplied by the caller so
 * this function works for both multipart/alternative (no attachments) and
 * multipart/mixed (with attachments) outer wrappers.
 */
function buildTopLevelHeaderLines(opts: TopLevelHeadersOpts): string[] {
  const { identity } = opts;
  const fromHeader = formatAddress(identity.display_name, identity.email);
  const replyTo =
    opts.reply_to ?? identity.default_reply_to ?? identity.email;
  const domain = senderDomain(identity.email);
  const messageId = `<${randomUUID()}@${domain}>`;

  // Defaults first, custom headers override.
  const headers: Record<string, string> = {
    From: fromHeader,
    To: opts.to,
    Subject: encodeHeaderValue(opts.subject),
    Date: rfc5322Date(),
    "Message-ID": messageId,
    "Reply-To": replyTo,
    "MIME-Version": "1.0",
    "Content-Type": opts.contentType,
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
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
}

/**
 * Wrap a multipart body string with top-level headers and base64url-encode
 * the full message for the Gmail send API. The body is expected to be
 * pre-built (e.g. by buildAlternativeBody or the multipart/mixed assembler).
 */
function finalizeMessage(headerLines: string[], body: string): string {
  const message = headerLines.join(CRLF) + CRLF + CRLF + body;
  return Buffer.from(message, "utf8").toString("base64url");
}

export function buildRawMessage(opts: BuildRawMessageOpts): string {
  const alt = buildAlternativeBody({ text: opts.text, html: opts.html });
  const headerLines = buildTopLevelHeaderLines({
    identity: opts.identity,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    reply_to: opts.reply_to,
    headers: opts.headers,
    contentType: alt.contentType,
  });
  return finalizeMessage(headerLines, alt.body);
}

/**
 * Encode a buffer as base64 with CRLF line breaks every 76 chars per RFC 2045
 * § 6.8 ("max 76 chars per line"). Gmail accepts longer lines but downstream
 * clients (some Outlook builds, archive parsers) break on them — sticking to
 * the spec is cheap insurance.
 */
function base64WithLineBreaks(buf: Buffer): string {
  const b64 = buf.toString("base64");
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    chunks.push(b64.slice(i, i + 76));
  }
  return chunks.join(CRLF);
}

function attachmentPart(boundary: string, att: AttachmentPart): string {
  // Filename is wrapped in quotes per RFC 2183. Non-ASCII filenames need
  // RFC 2231 encoding (`filename*=utf-8''<percent-encoded>`) which the tool
  // layer rejects up-front with a clear ValidationError, so we can assume
  // ASCII here.
  return [
    `--${boundary}`,
    `Content-Type: ${att.content_type}`,
    `Content-Disposition: attachment; filename="${att.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64WithLineBreaks(att.bytes),
    "",
  ].join(CRLF);
}

/**
 * Build a multipart/mixed message with an inner multipart/alternative body
 * and one or more attachment parts. The Gmail API expects the entire raw
 * message base64url-encoded; this function returns that final string.
 */
export function buildRawMessageWithAttachments(
  opts: BuildRawMessageWithAttachmentsOpts,
): string {
  const alt = buildAlternativeBody({ text: opts.text, html: opts.html });
  const mixedBoundary = generateBoundary("mixed");

  // Inner alternative is wrapped as a child of the outer mixed boundary. The
  // inner alternative declares its OWN Content-Type header (with its OWN
  // boundary) but inherits no top-level addressing headers.
  const innerAlternativePart = [
    `--${mixedBoundary}`,
    `Content-Type: ${alt.contentType}`,
    "",
    alt.body,
  ].join(CRLF);

  const attachmentParts = opts.attachments
    .map((a) => attachmentPart(mixedBoundary, a))
    .join("");

  const body =
    innerAlternativePart +
    CRLF +
    attachmentParts +
    `--${mixedBoundary}--` +
    CRLF;

  const headerLines = buildTopLevelHeaderLines({
    identity: opts.identity,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    reply_to: opts.reply_to,
    headers: opts.headers,
    contentType: `multipart/mixed; boundary="${mixedBoundary}"`,
  });

  return finalizeMessage(headerLines, body);
}
