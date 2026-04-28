import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
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

    return {
      gmail_id: sendResult.id,
      thread_id: sendResult.threadId,
      from: fromHeader(identity),
      to: input.to,
      subject: input.subject,
      sent_at: sentAt,
    };
  },
});
