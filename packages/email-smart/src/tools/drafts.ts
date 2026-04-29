import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { loadIdentity, type Identity } from "../identities.js";
import { buildRawMessage } from "../mime.js";
import { appendAudit } from "../audit.js";
import { mapMessage } from "../message-mapper.js";

function fromHeader(identity: Identity): string {
  if (identity.display_name.length === 0) return identity.email;
  return `${identity.display_name} <${identity.email}>`;
}

function rejectSmtp(identity: Identity, account: string, tool: string): void {
  if (identity.transport !== "oauth") {
    throw new ValidationError(
      `account "${account}" uses transport "${identity.transport}"; ${tool} currently supports oauth only (smtp transport deferred to a future phase)`,
    );
  }
}

/**
 * Extract the inner Gmail message resource from a getDraft response. Gmail's
 * `users.drafts.get` returns `{ id, message: <message-resource> }`; our slim
 * mapper expects the bare message-resource shape.
 */
function unwrapDraftMessage(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  return (raw as Record<string, unknown>)["message"];
}

// ---------- create_draft ----------

const createDraftInputSchema = z.object({
  account: z.string().min(1),
  to: z.string().min(1),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  reply_to: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

type CreateDraftInput = z.infer<typeof createDraftInputSchema>;

type CreateDraftOutput = {
  draft_id: string;
  message_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  created_at: string;
};

export const createDraft = defineTool<
  CreateDraftInput,
  CreateDraftOutput,
  EmailContext
>({
  name: "create_draft",
  description: "Create a Gmail draft (does not send).",
  inputSchema: createDraftInputSchema,
  handler: async (input, context) => {
    const identity = loadIdentity(input.account, context.home);
    rejectSmtp(identity, input.account, "create_draft");

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

    const ref = await context.client.createDraft(input.account, raw);
    return {
      draft_id: ref.id,
      message_id: ref.messageId,
      thread_id: ref.threadId,
      from: fromHeader(identity),
      to: input.to,
      subject: input.subject,
      created_at: new Date().toISOString(),
    };
  },
});

// ---------- list_drafts ----------

const listDraftsInputSchema = z.object({
  account: z.string().min(1),
  max_results: z.number().int().min(1).max(100).optional().default(20),
  q: z.string().optional(),
  page_token: z.string().optional(),
});

type ListDraftsInput = z.infer<typeof listDraftsInputSchema>;

type SlimDraft = {
  draft_id: string;
  message_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  size_bytes: number;
};

type ListDraftsOutput = {
  drafts: SlimDraft[];
  count: number;
  next_page_token?: string;
};

export const listDrafts = defineTool<
  ListDraftsInput,
  ListDraftsOutput,
  EmailContext
>({
  name: "list_drafts",
  description: "List Gmail drafts (slim shape).",
  // Cast required: ZodDefault on `max_results` widens the input type.
  inputSchema: listDraftsInputSchema as unknown as z.ZodType<ListDraftsInput>,
  handler: async (input, context) => {
    const list = await context.client.listDrafts(input.account, {
      maxResults: input.max_results,
      ...(input.q !== undefined ? { q: input.q } : {}),
      ...(input.page_token !== undefined ? { pageToken: input.page_token } : {}),
    });

    const slim: SlimDraft[] = [];
    for (const ref of list.drafts) {
      const raw = await context.client.getDraft(
        input.account,
        ref.id,
        "metadata",
      );
      const message = unwrapDraftMessage(raw);
      const mapped = mapMessage(message);
      // Reshape SlimMessage into the draft-slim shape: rename `id` to
      // `message_id` (the wrapping draft has its own id, which is `draft_id`).
      slim.push({
        draft_id: ref.id,
        message_id: mapped.id,
        thread_id: mapped.thread_id,
        from: mapped.from,
        to: mapped.to,
        subject: mapped.subject,
        snippet: mapped.snippet,
        date: mapped.date,
        labels: mapped.labels,
        size_bytes: mapped.size_bytes,
      });
    }

    return {
      drafts: slim,
      count: slim.length,
      ...(list.nextPageToken !== undefined
        ? { next_page_token: list.nextPageToken }
        : {}),
    };
  },
});

// ---------- send_draft ----------

const sendDraftInputSchema = z.object({
  account: z.string().min(1),
  draft_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type SendDraftInput = z.infer<typeof sendDraftInputSchema>;

type SendDraftOutput = {
  gmail_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  sent_at: string;
  audit_warning?: string;
};

function findHeader(
  headers: Array<{ name?: unknown; value?: unknown }>,
  target: string,
): string {
  const lower = target.toLowerCase();
  for (const h of headers) {
    if (typeof h?.name === "string" && h.name.toLowerCase() === lower) {
      return typeof h.value === "string" ? h.value : "";
    }
  }
  return "";
}

function readDraftHeaders(rawDraft: unknown): {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
} {
  const message = unwrapDraftMessage(rawDraft);
  const payload =
    typeof message === "object" && message !== null
      ? ((message as Record<string, unknown>)["payload"] ?? {})
      : {};
  const rawHeaders =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)["headers"]
      : undefined;
  const headers = Array.isArray(rawHeaders)
    ? (rawHeaders as Array<{ name?: unknown; value?: unknown }>)
    : [];
  return {
    from: findHeader(headers, "From"),
    to: findHeader(headers, "To"),
    cc: findHeader(headers, "Cc"),
    bcc: findHeader(headers, "Bcc"),
    subject: findHeader(headers, "Subject"),
  };
}

export const sendDraft = defineTool<
  SendDraftInput,
  SendDraftOutput,
  EmailContext
>({
  name: "send_draft",
  description: "Send an existing Gmail draft by ID.",
  // Cast required: ZodDefault on `confirm` widens the input type.
  inputSchema: sendDraftInputSchema as unknown as z.ZodType<SendDraftInput>,
  handler: async (input, context) => {
    const identity = loadIdentity(input.account, context.home);
    rejectSmtp(identity, input.account, "send_draft");

    // Fetch draft metadata to build a faithful preview AND to source the
    // audit-log subject/to/cc/bcc fields. NotFoundError propagates verbatim
    // (already friendly: "draft not found: <id>").
    const rawDraft = await context.client.getDraft(
      input.account,
      input.draft_id,
      "metadata",
    );
    const headers = readDraftHeaders(rawDraft);

    const preview = `Will SEND draft ${input.draft_id} from ${fromHeader(identity)}: "${headers.subject}" → ${headers.to}`;
    guardDestructive({ confirm: input.confirm, preview });

    const sendResult = await context.client.sendDraft(
      input.account,
      input.draft_id,
    );

    const sentAt = new Date().toISOString();

    // Audit-append must NOT mask a successful send. Mirror send_email's soft-
    // fail wrap so callers still receive gmail_id when the JSONL append fails.
    let auditWarning: string | undefined;
    try {
      appendAudit(
        {
          ts: sentAt,
          account: input.account,
          to: headers.to,
          cc: headers.cc,
          bcc: headers.bcc,
          subject: headers.subject,
          gmail_id: sendResult.id,
          gmail_thread_id: sendResult.threadId,
        },
        context.home,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      auditWarning = `audit append failed: ${reason}`;
      console.error(
        `[email-smart] WARN: send_draft succeeded (gmail_id=${sendResult.id}) but ${auditWarning}`,
      );
    }

    return {
      gmail_id: sendResult.id,
      thread_id: sendResult.threadId,
      from: fromHeader(identity),
      to: headers.to,
      subject: headers.subject,
      sent_at: sentAt,
      ...(auditWarning !== undefined ? { audit_warning: auditWarning } : {}),
    };
  },
});

// ---------- update_draft ----------

const updateDraftInputSchema = z.object({
  account: z.string().min(1),
  draft_id: z.string().min(1),
  to: z.string().min(1),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().min(1),
  reply_to: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

type UpdateDraftInput = z.infer<typeof updateDraftInputSchema>;

type UpdateDraftOutput = {
  draft_id: string;
  message_id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  updated_at: string;
};

export const updateDraft = defineTool<
  UpdateDraftInput,
  UpdateDraftOutput,
  EmailContext
>({
  name: "update_draft",
  description: "Update an existing Gmail draft.",
  inputSchema: updateDraftInputSchema,
  handler: async (input, context) => {
    const identity = loadIdentity(input.account, context.home);
    rejectSmtp(identity, input.account, "update_draft");

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

    const ref = await context.client.updateDraft(
      input.account,
      input.draft_id,
      raw,
    );
    return {
      draft_id: ref.id,
      message_id: ref.messageId,
      thread_id: ref.threadId,
      from: fromHeader(identity),
      to: input.to,
      subject: input.subject,
      updated_at: new Date().toISOString(),
    };
  },
});

// ---------- delete_draft ----------

const deleteDraftInputSchema = z.object({
  account: z.string().min(1),
  draft_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteDraftInput = z.infer<typeof deleteDraftInputSchema>;

type DeleteDraftOutput = {
  draft_id: string;
  deleted: boolean;
};

export const deleteDraft = defineTool<
  DeleteDraftInput,
  DeleteDraftOutput,
  EmailContext
>({
  name: "delete_draft",
  description: "Permanently delete a Gmail draft (not recoverable).",
  // Cast required: ZodDefault on `confirm` widens the input type.
  inputSchema: deleteDraftInputSchema as unknown as z.ZodType<DeleteDraftInput>,
  handler: async (input, context) => {
    const identity = loadIdentity(input.account, context.home);
    rejectSmtp(identity, input.account, "delete_draft");

    // getDraft for preview context AND to surface 404 before the destructive
    // confirm gate. NotFoundError propagates verbatim.
    const rawDraft = await context.client.getDraft(
      input.account,
      input.draft_id,
      "metadata",
    );
    const headers = readDraftHeaders(rawDraft);

    const preview = `Will PERMANENTLY DELETE draft ${input.draft_id} (not recoverable from Trash). Subject: "${headers.subject}"`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteDraft(input.account, input.draft_id);

    return { draft_id: input.draft_id, deleted: true };
  },
});
