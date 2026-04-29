import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { loadIdentity, type Identity } from "../identities.js";
import { buildRawMessage } from "../mime.js";
import { appendAudit } from "../audit.js";
import {
  loadTemplate,
  renderTemplate,
  deriveTextFromHtml,
} from "../templates.js";

const sendWithTemplateInputSchema = z.object({
  account: z.string().min(1),
  template: z.string().min(1).default("email-base"),
  to: z.string().min(1),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().min(1),
  vars: z.record(z.string(), z.string()),
  text_override: z.string().optional(),
  reply_to: z.string().optional(),
  confirm: z.boolean().optional().default(false),
});

type SendWithTemplateInput = z.infer<typeof sendWithTemplateInputSchema>;

type SendWithTemplateOutput = {
  gmail_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  sent_at: string;
  /**
   * Mirrors send_email: present only when the email DID get sent but the
   * audit-log append failed. Surfaces the failure without losing gmail_id.
   */
  audit_warning?: string;
};

function fromHeader(identity: Identity): string {
  if (identity.display_name.length === 0) return identity.email;
  return `${identity.display_name} <${identity.email}>`;
}

function buildPreview(
  input: SendWithTemplateInput,
  identity: Identity,
): string {
  let preview = `Will send to ${input.to} from ${fromHeader(identity)}: "${input.subject}"`;
  if (input.cc !== undefined && input.cc.length > 0) {
    preview += ` (cc: ${input.cc})`;
  }
  if (input.bcc !== undefined && input.bcc.length > 0) {
    preview += ` (bcc: ${input.bcc})`;
  }
  return preview;
}

/**
 * Build the final substitution map that `renderTemplate` will use.
 *
 * The real `~/.santo-agent/templates/email-base.html` uses UPPERCASE keys
 * (TITLE, PREHEADER, SENDER_NAME, BODY_HTML, SIGNATURE_HTML, FOOTER_LINE).
 * The tool's input takes a lowercase `vars` map (per the plan's `body`,
 * `intro`, `cta_url` examples) so callers don't have to think about template
 * conventions. We map a small set of well-known lowercase keys to their
 * uppercase template counterparts and then merge the user's vars verbatim so
 * advanced callers can also pass UPPERCASE keys directly when they want to
 * substitute additional template-specific placeholders.
 */
function buildFinalVars(
  input: SendWithTemplateInput,
  identity: Identity,
): Record<string, string> {
  const userVars = input.vars;
  // identity-derived defaults (caller can override via UPPERCASE keys in vars)
  const finalVars: Record<string, string> = {
    TITLE: input.subject,
    PREHEADER:
      typeof userVars["preheader"] === "string"
        ? userVars["preheader"]!
        : input.subject,
    SENDER_NAME: identity.display_name,
    BODY_HTML: userVars["body"]!, // already validated upstream
    SIGNATURE_HTML: identity.signature_html ?? "",
    FOOTER_LINE: identity.default_footer ?? "",
  };
  // Pass-through any UPPERCASE keys the caller supplied verbatim. We don't
  // forward lowercase keys (they'd never match a template's UPPERCASE
  // placeholder) but we DO let an UPPERCASE key from the caller override an
  // identity-derived default — useful for ad-hoc per-send signature swaps.
  for (const [k, v] of Object.entries(userVars)) {
    if (k === k.toUpperCase()) {
      finalVars[k] = v;
    }
  }
  return finalVars;
}

export const sendWithTemplate = defineTool<
  SendWithTemplateInput,
  SendWithTemplateOutput,
  EmailContext
>({
  name: "send_with_template",
  description: "Send templated HTML email with variable substitution.",
  // Cast required: ZodDefault on `confirm` and `template` widens the schema's
  // input type vs the resolved output type the handler actually sees.
  inputSchema: sendWithTemplateInputSchema as unknown as z.ZodType<SendWithTemplateInput>,
  handler: async (input, context) => {
    const identity = loadIdentity(input.account, context.home);

    // Reject SMTP-transport identities at the gate (mirror send_email).
    // Falling through to OAuth would surface a misleading "token not found"
    // error pointing at the wrong remediation.
    if (identity.transport !== "oauth") {
      throw new ValidationError(
        `account "${input.account}" uses transport "${identity.transport}"; send_with_template currently supports oauth only (smtp transport deferred to a future phase)`,
      );
    }

    // vars.body is the minimum required substitution. Validate BEFORE the
    // confirm gate so callers see the actionable error instead of a
    // ConfirmRequiredError that would just mask a malformed payload.
    if (typeof input.vars["body"] !== "string" || input.vars["body"].length === 0) {
      throw new ValidationError(
        "send_with_template requires vars.body (the rendered HTML body content)",
      );
    }

    const rawTemplate = loadTemplate(input.template, context.home);
    const finalVars = buildFinalVars(input, identity);
    const renderedHtml = renderTemplate(rawTemplate, finalVars);
    const renderedText =
      input.text_override !== undefined
        ? input.text_override
        : deriveTextFromHtml(renderedHtml);

    const preview = buildPreview(input, identity);
    guardDestructive({ confirm: input.confirm, preview });

    const raw = buildRawMessage({
      identity,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      html: renderedHtml,
      text: renderedText,
      reply_to: input.reply_to,
    });

    const sendResult = await context.client.sendMessage(input.account, raw);

    // Single timestamp shared between audit row and tool output so callers can
    // correlate the JSONL line with the response.
    const sentAt = new Date().toISOString();

    // Soft-fail audit append: a successful send must not be masked by a disk
    // / permission failure on the JSONL write. Surface as `audit_warning`.
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
        `[email-smart] WARN: send_with_template succeeded (gmail_id=${sendResult.id}) but ${auditWarning}`,
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
