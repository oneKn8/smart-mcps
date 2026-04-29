import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { loadIdentity, type Identity } from "../identities.js";
import { buildRawMessage } from "../mime.js";
import { appendAudit } from "../audit.js";
import { renderTemplate } from "../templates.js";

// bulk_send — sequential multi-recipient send with rate limiting and
// per-recipient template-variable substitution.
//
// Resilient to partial failures: a single recipient's failure (missing
// template var, sendMessage error) does NOT abort the batch — that recipient
// lands in `failed[]` and the loop proceeds.
//
// Conventions:
// - dry_run wins over confirm (matches kill_idle_pods / mark_read_by_query).
// - The default `dry_run: true` short-circuits BEFORE OAuth load, BEFORE any
//   identity validation that would surface auth errors, and never touches the
//   audit log. Identity validation still runs first so the caller learns about
//   a missing-account / SMTP-transport problem before previewing.
// - rate_limit_ms is applied AFTER each send except the last (no trailing
//   delay). rate_limit_ms=0 skips the sleep call entirely.
// - bulk_send does NOT auto-inject identity vars (display_name, email, etc.)
//   into the per-recipient `vars` map. Callers who reference identity in
//   templates must pass those vars explicitly per recipient.

const recipientSchema = z.object({
  to: z.string().min(1),
  vars: z.record(z.string(), z.string()).optional(),
});

const bulkSendInputSchema = z.object({
  account: z.string().min(1),
  recipients: z.array(recipientSchema).min(1).max(50),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  reply_to: z.string().optional(),
  rate_limit_ms: z.number().int().min(0).max(10_000).optional().default(500),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
});

type BulkSendInput = z.infer<typeof bulkSendInputSchema>;

type BulkSendOutput = {
  attempted: number;
  sent: Array<{ to: string; gmail_id: string; thread_id: string }>;
  failed: Array<{ to: string; reason: string }>;
  dry_run: boolean;
};

function fromHeader(identity: Identity): string {
  if (identity.display_name.length === 0) return identity.email;
  return `${identity.display_name} <${identity.email}>`;
}

function buildPreview(input: BulkSendInput, identity: Identity): string {
  const firstThree = input.recipients
    .slice(0, 3)
    .map((r) => r.to)
    .join(", ");
  return (
    `Will bulk-send to ${input.recipients.length} recipients from ` +
    `${fromHeader(identity)}: "${input.subject}" ` +
    `(rate limit: ${input.rate_limit_ms}ms between sends) ` +
    `(first 3: ${firstThree})`
  );
}

function findDuplicate(recipients: BulkSendInput["recipients"]): string | null {
  const seen = new Set<string>();
  for (const r of recipients) {
    if (seen.has(r.to)) return r.to;
    seen.add(r.to);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const bulkSend = defineTool<BulkSendInput, BulkSendOutput, EmailContext>({
  name: "bulk_send",
  description: "Sequential multi-recipient send with rate limit.",
  // Cast required: ZodDefault on `dry_run`, `confirm`, `rate_limit_ms` widens
  // the schema's input type vs the resolved output type the handler sees.
  inputSchema: bulkSendInputSchema as unknown as z.ZodType<BulkSendInput>,
  handler: async (input, context) => {
    // Validate up front so SMTP / duplicate / missing-account errors surface
    // BEFORE the dry_run short-circuit. A dry_run on a misconfigured account
    // should still tell the caller their config is broken.
    const identity = loadIdentity(input.account, context.home);
    if (identity.transport !== "oauth") {
      throw new ValidationError(
        `account "${input.account}" uses transport "${identity.transport}"; bulk_send currently supports oauth only (smtp transport deferred to a future phase)`,
      );
    }

    const dup = findDuplicate(input.recipients);
    if (dup !== null) {
      throw new ValidationError(`duplicate recipient: ${dup}`);
    }

    // dry_run wins over confirm — preview only, no side effects, no audit.
    if (input.dry_run) {
      return {
        attempted: input.recipients.length,
        sent: [],
        failed: [],
        dry_run: true,
      };
    }

    const preview = buildPreview(input, identity);
    guardDestructive({ confirm: input.confirm, preview });

    const sent: BulkSendOutput["sent"] = [];
    const failed: BulkSendOutput["failed"] = [];

    for (let i = 0; i < input.recipients.length; i += 1) {
      const recipient = input.recipients[i]!;
      const vars = recipient.vars ?? {};

      try {
        // Per-recipient template substitution. renderTemplate throws
        // ValidationError on missing-var; we fold that into failed[] rather
        // than letting it abort the loop.
        const renderedSubject = renderTemplate(input.subject, vars);
        const renderedHtml = renderTemplate(input.html, vars);
        const renderedText = renderTemplate(input.text, vars);

        const raw = buildRawMessage({
          identity,
          to: recipient.to,
          subject: renderedSubject,
          html: renderedHtml,
          text: renderedText,
          reply_to: input.reply_to,
        });

        const sendResult = await context.client.sendMessage(input.account, raw);

        sent.push({
          to: recipient.to,
          gmail_id: sendResult.id,
          thread_id: sendResult.threadId,
        });

        // Audit append — soft-fail. A successful send must not be reclassified
        // as failed because the JSONL write blew up. Surface to stderr only.
        try {
          appendAudit(
            {
              ts: new Date().toISOString(),
              account: input.account,
              to: recipient.to,
              subject: renderedSubject,
              gmail_id: sendResult.id,
              gmail_thread_id: sendResult.threadId,
            },
            context.home,
          );
        } catch (auditErr) {
          const reason =
            auditErr instanceof Error ? auditErr.message : String(auditErr);
          console.error(
            `[email-smart] WARN: bulk_send succeeded (gmail_id=${sendResult.id}) but audit append failed: ${reason}`,
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failed.push({ to: recipient.to, reason });
      }

      // Inter-send delay. Skip after last recipient (no trailing wait) and
      // skip when rate_limit_ms is 0 to avoid a pointless setTimeout(0).
      const isLast = i === input.recipients.length - 1;
      if (!isLast && input.rate_limit_ms > 0) {
        await sleep(input.rate_limit_ms);
      }
    }

    return {
      attempted: input.recipients.length,
      sent,
      failed,
      dry_run: false,
    };
  },
});
