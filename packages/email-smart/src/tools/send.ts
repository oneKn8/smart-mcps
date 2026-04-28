import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { loadIdentity, type Identity } from "../identities.js";
import { buildRawMessage } from "../mime.js";
import { appendAudit } from "../audit.js";

const sendEmailInputSchema = z.object({
  account: z.string().min(1),
  to: z.string().min(1),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  reply_to: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  confirm: z.boolean().optional().default(false),
});

type SendEmailInput = z.infer<typeof sendEmailInputSchema>;

type SendEmailOutput = {
  gmail_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  sent_at: string;
  /**
   * Present only when the email was successfully sent but the audit-log append
   * failed (disk full, permissions, etc). Surfaces the failure to the caller
   * without losing the gmail_id of the email that DID get sent.
   */
  audit_warning?: string;
};

function fromHeader(identity: Identity): string {
  if (identity.display_name.length === 0) return identity.email;
  return `${identity.display_name} <${identity.email}>`;
}

function buildPreview(input: SendEmailInput, identity: Identity): string {
  let preview = `Will send to ${input.to} from ${fromHeader(identity)}: "${input.subject}"`;
  if (input.cc !== undefined && input.cc.length > 0) {
    preview += ` (cc: ${input.cc})`;
  }
  if (input.bcc !== undefined && input.bcc.length > 0) {
    preview += ` (bcc: ${input.bcc})`;
  }
  return preview;
}

export const sendEmail = defineTool<SendEmailInput, SendEmailOutput, EmailContext>({
  name: "send_email",
  description: "Send HTML+text email via Gmail (multi-account).",
  // Cast required: ZodDefault on `confirm` widens the schema's input type vs
  // the resolved output type the handler actually sees.
  inputSchema: sendEmailInputSchema as unknown as z.ZodType<SendEmailInput>,
  handler: async (input, context) => {
    const identity = loadIdentity(input.account, context.home);

    // Reject SMTP-transport identities at the gate. send_email currently only
    // supports the OAuth-via-Gmail-API path; SMTP is a future-phase concern.
    // Falling through to OAuth would surface a misleading "token not found"
    // error pointing at the wrong remediation.
    if (identity.transport !== "oauth") {
      throw new ValidationError(
        `account "${input.account}" uses transport "${identity.transport}"; send_email currently supports oauth only (smtp transport deferred to a future phase)`,
      );
    }

    const preview = buildPreview(input, identity);
    guardDestructive({ confirm: input.confirm, preview });

    const raw = buildRawMessage({
      identity,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      html: input.html,
      text: input.text,
      reply_to: input.reply_to,
      headers: input.headers,
    });

    const sendResult = await context.client.sendMessage(input.account, raw);

    // Compute timestamp once: it's both the audit row's `ts` AND the tool
    // output's `sent_at`, so callers can correlate audit-log entries with
    // tool returns.
    const sentAt = new Date().toISOString();

    // Audit-append must NOT mask a successful send. If the JSONL write fails
    // (disk full, permissions), surface the failure as `audit_warning` on the
    // success response so the caller still gets the gmail_id back. Logging to
    // stderr keeps the failure visible to the operator running the MCP.
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
        },
        context.home,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      auditWarning = `audit append failed: ${reason}`;
      console.error(
        `[email-smart] WARN: send_email succeeded (gmail_id=${sendResult.id}) but ${auditWarning}`,
      );
    }

    return {
      gmail_id: sendResult.id,
      thread_id: sendResult.threadId,
      from: fromHeader(identity),
      to: input.to,
      subject: input.subject,
      sent_at: sentAt,
      ...(auditWarning !== undefined ? { audit_warning: auditWarning } : {}),
    };
  },
});
