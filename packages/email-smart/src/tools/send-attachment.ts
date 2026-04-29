import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { loadIdentity, type Identity } from "../identities.js";
import { buildRawMessageWithAttachments, type AttachmentPart } from "../mime.js";
import { appendAudit } from "../audit.js";

const MAX_COMBINED_BYTES = 25 * 1024 * 1024;

// MIME type inference table. Lowercased extensions including the dot. Default
// fallback is application/octet-stream when no entry matches. Kept narrow on
// purpose: this is a smart MCP, not a full mimetype database — extending the
// table is a one-line change when needed.
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".zip": "application/zip",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

const attachmentInputSchema = z.union([
  z.object({
    filename: z.string().min(1),
    path: z.string().min(1),
    content_type: z.string().optional(),
  }),
  z.object({
    filename: z.string().min(1),
    data: z.string().min(1),
    content_type: z.string().optional(),
  }),
]);

const sendWithAttachmentInputSchema = z.object({
  account: z.string().min(1),
  to: z.string().min(1),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  reply_to: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  attachments: z.array(attachmentInputSchema).min(1).max(10),
  confirm: z.boolean().optional().default(false),
});

type SendWithAttachmentInput = z.infer<typeof sendWithAttachmentInputSchema>;

type SendWithAttachmentOutput = {
  gmail_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  sent_at: string;
  attachment_count: number;
  /**
   * Present only when the email was successfully sent but the audit-log
   * append failed. Mirrors the soft-fail pattern in send_email.
   */
  audit_warning?: string;
};

function fromHeader(identity: Identity): string {
  if (identity.display_name.length === 0) return identity.email;
  return `${identity.display_name} <${identity.email}>`;
}

function buildPreview(
  input: SendWithAttachmentInput,
  identity: Identity,
  dataOnlyBytes: number,
  hasPathAttachment: boolean,
): string {
  const n = input.attachments.length;
  const noun = n === 1 ? "attachment" : "attachments";
  // Size string: when only data-form attachments are present we can show the
  // exact KB count; when path-form attachments contribute, append "+ files
  // on disk" so the operator knows the displayed number is partial.
  const sizeKb = Math.max(0, Math.round(dataOnlyBytes / 1024));
  const sizeLabel = hasPathAttachment
    ? dataOnlyBytes > 0
      ? `${sizeKb}KB inline + files on disk`
      : "files on disk"
    : `${Math.max(1, sizeKb)}KB`;
  let preview = `Will send to ${input.to} from ${fromHeader(identity)}: "${input.subject}" with ${n} ${noun} (${sizeLabel})`;
  if (input.cc !== undefined && input.cc.length > 0) {
    preview += ` (cc: ${input.cc})`;
  }
  if (input.bcc !== undefined && input.bcc.length > 0) {
    preview += ` (bcc: ${input.bcc})`;
  }
  return preview;
}

export const sendWithAttachment = defineTool<
  SendWithAttachmentInput,
  SendWithAttachmentOutput,
  EmailContext
>({
  name: "send_with_attachment",
  description: "Send Gmail email with file attachments (multipart/mixed).",
  // Cast required: ZodDefault on `confirm` widens schema input type vs
  // the resolved output type the handler actually sees.
  inputSchema: sendWithAttachmentInputSchema as unknown as z.ZodType<SendWithAttachmentInput>,
  handler: async (input, context) => {
    const identity = loadIdentity(input.account, context.home);

    // Reject SMTP-transport identities at the gate (matches send_email).
    if (identity.transport !== "oauth") {
      throw new ValidationError(
        `account "${input.account}" uses transport "${identity.transport}"; send_with_attachment currently supports oauth only (smtp transport deferred to a future phase)`,
      );
    }

    // Reject non-ASCII filenames up-front. RFC 2231 (filename*=utf-8''...)
    // would let us encode them, but punting that to a future phase keeps the
    // MIME builder simple. Surface a clear error so the caller can rename.
    for (const a of input.attachments) {
      if (!isAscii(a.filename)) {
        throw new ValidationError(
          `attachment filename "${a.filename}" contains non-ASCII characters; rename to ASCII or use RFC 2231 encoding (deferred to future phase)`,
        );
      }
    }

    // Cheap pre-confirm size estimate: use base64-decoded length for `data`
    // attachments (in-memory, no I/O) and the schema-bounded MAX cap for
    // `path` attachments via a placeholder. We can't statSync before confirm
    // (ENOENT would mask ConfirmRequiredError) and we can't read file content
    // either, so for path-form attachments we punt the strict size check to
    // AFTER reading. Data-form attachments that exceed the cap on their own
    // still trip the early guard so the caller sees the cap message.
    let dataOnlyBytes = 0;
    let hasPathAttachment = false;
    for (const a of input.attachments) {
      if ("path" in a) {
        hasPathAttachment = true;
      } else {
        // base64 length → byte count (overcount by up to 2 bytes; harmless
        // for the cap check).
        dataOnlyBytes += Math.floor((a.data.length * 3) / 4);
      }
    }

    if (dataOnlyBytes > MAX_COMBINED_BYTES) {
      const mb = (dataOnlyBytes / (1024 * 1024)).toFixed(1);
      throw new ValidationError(
        `attachment size ${mb}MB exceeds Gmail's 25MB cap`,
      );
    }

    // Preview shows the data-form byte count + an indicator for path-form.
    // Final exact size is computed post-read.
    const preview = buildPreview(
      input,
      identity,
      dataOnlyBytes,
      hasPathAttachment,
    );
    guardDestructive({ confirm: input.confirm, preview });

    // Confirm passed → resolve every attachment to bytes. This is the first
    // disk touch for path-form attachments; ENOENT here surfaces to the user.
    const parts: AttachmentPart[] = input.attachments.map((a) => {
      const bytes =
        "path" in a ? fs.readFileSync(a.path) : Buffer.from(a.data, "base64");
      const contentType =
        a.content_type !== undefined && a.content_type.length > 0
          ? a.content_type
          : inferContentType(a.filename);
      return {
        filename: a.filename,
        content_type: contentType,
        bytes,
      };
    });

    // Final exact size cap: combined bytes across resolved attachments.
    const totalBytes = parts.reduce((sum, p) => sum + p.bytes.length, 0);
    if (totalBytes > MAX_COMBINED_BYTES) {
      const mb = (totalBytes / (1024 * 1024)).toFixed(1);
      throw new ValidationError(
        `attachment size ${mb}MB exceeds Gmail's 25MB cap`,
      );
    }

    const raw = buildRawMessageWithAttachments({
      identity,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      html: input.html,
      text: input.text,
      reply_to: input.reply_to,
      headers: input.headers,
      attachments: parts,
    });

    const sendResult = await context.client.sendMessage(input.account, raw);
    const sentAt = new Date().toISOString();

    // Audit-append must NOT mask a successful send. Mirror send_email's
    // soft-fail path: log to stderr, surface as audit_warning.
    let auditWarning: string | undefined;
    try {
      appendAudit(
        {
          ts: sentAt,
          account: input.account,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          gmail_id: sendResult.id,
          gmail_thread_id: sendResult.threadId,
          attachment_count: parts.length,
        },
        context.home,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      auditWarning = `audit append failed: ${reason}`;
      console.error(
        `[email-smart] WARN: send_with_attachment succeeded (gmail_id=${sendResult.id}) but ${auditWarning}`,
      );
    }

    return {
      gmail_id: sendResult.id,
      thread_id: sendResult.threadId,
      from: fromHeader(identity),
      to: input.to,
      subject: input.subject,
      sent_at: sentAt,
      attachment_count: parts.length,
      ...(auditWarning !== undefined ? { audit_warning: auditWarning } : {}),
    };
  },
});
