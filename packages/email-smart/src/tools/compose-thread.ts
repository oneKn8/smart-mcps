import { z } from "zod";
import {
  defineTool,
  guardDestructive,
  ValidationError,
} from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { loadIdentity, type Identity } from "../identities.js";
import { buildRawMessage } from "../mime.js";
import { appendAudit } from "../audit.js";

const composeThreadInputSchema = z.object({
  account: z.string().min(1),
  in_reply_to_id: z.string().min(1),
  subject_prefix: z.enum(["Re:", "Fwd:", ""]).optional().default("Re:"),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  html: z.string().min(1),
  text: z.string().min(1),
  reply_to: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  confirm: z.boolean().optional().default(false),
});

type ComposeThreadInput = z.infer<typeof composeThreadInputSchema>;

type ComposeThreadOutput = {
  gmail_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  sent_at: string;
  audit_warning?: string;
};

type GmailHeader = { name: string; value: string };

function fromHeader(identity: Identity): string {
  if (identity.display_name.length === 0) return identity.email;
  return `${identity.display_name} <${identity.email}>`;
}

/**
 * Read the headers array from a Gmail message payload. Returns [] when the
 * shape is unexpected so callers can treat absence-of-header uniformly.
 */
function readHeaders(rawMessage: unknown): GmailHeader[] {
  if (typeof rawMessage !== "object" || rawMessage === null) return [];
  const payload = (rawMessage as Record<string, unknown>)["payload"];
  if (typeof payload !== "object" || payload === null) return [];
  const list = (payload as Record<string, unknown>)["headers"];
  if (!Array.isArray(list)) return [];
  const out: GmailHeader[] = [];
  for (const h of list) {
    if (
      typeof h === "object" &&
      h !== null &&
      typeof (h as { name?: unknown }).name === "string" &&
      typeof (h as { value?: unknown }).value === "string"
    ) {
      out.push({
        name: (h as { name: string }).name,
        value: (h as { value: string }).value,
      });
    }
  }
  return out;
}

/**
 * Case-insensitive header lookup. Gmail normalizes most headers to canonical
 * form but `Message-ID` vs `Message-Id` (and lowercase-everything from some
 * mailers) requires case-insensitive comparison.
 */
function findHeader(headers: GmailHeader[], target: string): string | undefined {
  const lower = target.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return undefined;
}

/**
 * RFC 2822 requires Message-ID values to be wrapped in angle brackets. Gmail
 * almost always returns them already wrapped, but some senders emit
 * unwrapped values; normalize for our In-Reply-To / References output.
 */
function ensureAngleBrackets(messageId: string): string {
  const trimmed = messageId.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed}>`;
}

/**
 * Extract a bare email address from an RFC 5322 From-style value. Prefers the
 * `<addr>` portion when angle brackets are present; falls back to the whole
 * trimmed value otherwise. Only used when the caller didn't override `to`
 * explicitly.
 */
function parseFromAddress(fromHeaderValue: string): string {
  const trimmed = fromHeaderValue.trim();
  const lt = trimmed.indexOf("<");
  const gt = trimmed.lastIndexOf(">");
  if (lt !== -1 && gt !== -1 && gt > lt) {
    return trimmed.slice(lt + 1, gt).trim();
  }
  return trimmed;
}

/**
 * Build the new subject line. The contract:
 *   - subject_prefix === "" → original passes through verbatim (even empty).
 *   - Otherwise → prepend "<prefix> " unless the original ALREADY starts with
 *     the prefix (case-insensitive), in which case the prefix is left alone.
 *   - Edge case: empty original subject + non-empty prefix → just the prefix
 *     (e.g. "Re:") without trailing whitespace, since there's nothing to lead.
 */
function buildSubject(originalSubject: string, prefix: "Re:" | "Fwd:" | ""): string {
  if (prefix === "") return originalSubject;
  if (originalSubject.length === 0) return prefix;
  const lowerSubject = originalSubject.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerSubject.startsWith(lowerPrefix)) return originalSubject;
  return `${prefix} ${originalSubject}`;
}

function buildPreview(opts: {
  inReplyToId: string;
  identity: Identity;
  toAddress: string;
  newSubject: string;
  cc: string | undefined;
  bcc: string | undefined;
}): string {
  let preview = `Will reply to ${opts.inReplyToId} from ${fromHeader(
    opts.identity,
  )}: "${opts.newSubject}" → ${opts.toAddress}`;
  if (opts.cc !== undefined && opts.cc.length > 0) preview += ` (cc: ${opts.cc})`;
  if (opts.bcc !== undefined && opts.bcc.length > 0)
    preview += ` (bcc: ${opts.bcc})`;
  return preview;
}

export const composeThread = defineTool<
  ComposeThreadInput,
  ComposeThreadOutput,
  EmailContext
>({
  name: "compose_thread",
  description: "Reply within Gmail thread (In-Reply-To/References).",
  // Cast required: ZodDefault on `subject_prefix` and `confirm` widens the
  // schema's input type vs the resolved output type the handler sees.
  inputSchema: composeThreadInputSchema as unknown as z.ZodType<ComposeThreadInput>,
  handler: async (input, context) => {
    const identity = loadIdentity(input.account, context.home);

    // Reject SMTP-transport identities at the gate (matches send_email).
    // Falling through to OAuth would surface a misleading "token not found"
    // error pointing at the wrong remediation.
    if (identity.transport !== "oauth") {
      throw new ValidationError(
        `account "${input.account}" uses transport "${identity.transport}"; compose_thread currently supports oauth only (smtp transport deferred to a future phase)`,
      );
    }

    // Build a tentative preview using the user-provided `to` if any. The
    // subject in the preview is best-effort (we don't know original yet) but
    // includes the in_reply_to_id which is the load-bearing identifier here.
    // Confirm gate fires BEFORE the Gmail GET so we don't waste a quota call
    // on an unconfirmed reply.
    const previewSubject =
      input.subject_prefix === "" ? "<original subject>" : `${input.subject_prefix} <original subject>`;
    const previewTo = input.to ?? "<original sender>";
    const earlyPreview = buildPreview({
      inReplyToId: input.in_reply_to_id,
      identity,
      toAddress: previewTo,
      newSubject: previewSubject,
      cc: input.cc,
      bcc: input.bcc,
    });
    guardDestructive({ confirm: input.confirm, preview: earlyPreview });

    // Fetch original. `metadata` format gives us payload.headers without
    // pulling body bytes — all we need for In-Reply-To/References/Subject/From.
    const originalRaw = await context.client.getMessage(
      input.account,
      input.in_reply_to_id,
      "metadata",
    );
    const headers = readHeaders(originalRaw);

    const originalMessageId = findHeader(headers, "Message-ID");
    if (originalMessageId === undefined || originalMessageId.length === 0) {
      throw new ValidationError(
        `original message ${input.in_reply_to_id} has no Message-ID header; cannot thread`,
      );
    }
    const wrappedMessageId = ensureAngleBrackets(originalMessageId);

    const originalReferences = findHeader(headers, "References");
    const newReferences =
      originalReferences !== undefined && originalReferences.length > 0
        ? `${originalReferences} ${wrappedMessageId}`
        : wrappedMessageId;

    const originalFrom = findHeader(headers, "From") ?? "";
    const originalSubject = findHeader(headers, "Subject") ?? "";

    const toAddress =
      input.to !== undefined && input.to.length > 0
        ? input.to
        : parseFromAddress(originalFrom);
    const newSubject = buildSubject(originalSubject, input.subject_prefix);

    // Threading defaults; user-provided headers override per the spec.
    const threadingHeaders: Record<string, string> = {
      "In-Reply-To": wrappedMessageId,
      References: newReferences,
    };
    const mergedHeaders: Record<string, string> = {
      ...threadingHeaders,
      ...(input.headers ?? {}),
    };

    const raw = buildRawMessage({
      identity,
      to: toAddress,
      cc: input.cc,
      bcc: input.bcc,
      subject: newSubject,
      html: input.html,
      text: input.text,
      reply_to: input.reply_to,
      headers: mergedHeaders,
    });

    const sendResult = await context.client.sendMessage(input.account, raw);

    // Compute timestamp once: shared between audit row and tool output so
    // callers can correlate audit-log entries with returned values.
    const sentAt = new Date().toISOString();

    // Audit-append must NOT mask a successful send (matches send_email's
    // soft-fail wrap). On failure, surface as `audit_warning` so the caller
    // still gets the gmail_id back.
    let auditWarning: string | undefined;
    try {
      appendAudit(
        {
          ts: sentAt,
          account: input.account,
          to: toAddress,
          cc: input.cc,
          bcc: input.bcc,
          subject: newSubject,
          gmail_id: sendResult.id,
          gmail_thread_id: sendResult.threadId,
        },
        context.home,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      auditWarning = `audit append failed: ${reason}`;
      console.error(
        `[email-smart] WARN: compose_thread succeeded (gmail_id=${sendResult.id}) but ${auditWarning}`,
      );
    }

    return {
      gmail_id: sendResult.id,
      thread_id: sendResult.threadId,
      from: fromHeader(identity),
      to: toAddress,
      subject: newSubject,
      sent_at: sentAt,
      ...(auditWarning !== undefined ? { audit_warning: auditWarning } : {}),
    };
  },
});
