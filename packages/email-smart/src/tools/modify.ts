import { z } from "zod";
import {
  defineTool,
  guardDestructive,
  NotFoundError,
  ValidationError,
} from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { loadIdentity } from "../identities.js";
import { mapMessage, type SlimMessage } from "../message-mapper.js";

// =============================================================================
// Bulk modify by query — shared shape
// =============================================================================
//
// Four destructive tools that share a common flow:
//
//   1. Reject SMTP-transport identities up front (these tools require Gmail
//      OAuth scope; SMTP cannot perform server-side modify).
//   2. (apply_label_by_query only) Resolve human-readable label names to
//      Gmail label IDs via listLabels. Unknown names → NotFoundError BEFORE
//      any modify call.
//   3. List up to `max` matching message IDs via Gmail's search query.
//   4. Fetch metadata for the first 10 IDs to build a slim preview. Failed
//      individual fetches are skipped, never abort the whole call.
//   5. dry_run wins over confirm. dry_run=true → return preview, applied=false.
//   6. dry_run=false + confirm=false → guardDestructive throws
//      ConfirmRequiredError carrying the preview text.
//   7. dry_run=false + confirm=true → call batchModify or batchTrash, return
//      applied=true.
//
// Gmail's batchModify and batchTrash return 204 No Content on success and do
// not surface per-id errors, so the `failed` field in the output is always
// omitted on success. The shape leaves room to add per-id error reporting
// later if Gmail begins exposing it.

type BulkOutput = {
  scanned: number;
  matched: number;
  preview: SlimMessage[];
  applied: boolean;
  failed?: Array<{ id: string; reason: string }>;
};

const PREVIEW_LIMIT = 10;

async function listMatchingIds(
  context: EmailContext,
  account: string,
  q: string,
  max: number,
): Promise<{ ids: string[]; scanned: number }> {
  // Gmail caps each page at 500; for the MVP `max` itself caps at 500 via the
  // schema, so a single listMessages call covers it. We still tolerate the
  // possibility of Gmail returning fewer than requested and a nextPageToken
  // — we ignore the token and only use what we got, which is the conservative
  // default for destructive ops.
  const list = await context.client.listMessages(account, {
    q,
    maxResults: max,
  });
  const ids = list.messages.map((m) => m.id);
  return { ids, scanned: ids.length };
}

async function buildPreview(
  context: EmailContext,
  account: string,
  ids: string[],
): Promise<SlimMessage[]> {
  const subset = ids.slice(0, PREVIEW_LIMIT);
  const out: SlimMessage[] = [];
  for (const id of subset) {
    try {
      const raw = await context.client.getMessage(account, id, "metadata");
      out.push(mapMessage(raw));
    } catch {
      // Skip individual failures — preview is best-effort. The destructive
      // op itself runs against the full ID list and is the source of truth
      // for "did this work".
    }
  }
  return out;
}

function rejectIfSmtp(account: string, home: string | undefined): void {
  const identity = loadIdentity(account, home);
  if (identity.transport !== "oauth") {
    throw new ValidationError(
      `account "${account}" uses transport "${identity.transport}"; this tool requires oauth transport`,
    );
  }
}

// ---------- mark_read_by_query ----------

const markReadByQueryInputSchema = z.object({
  account: z.string().min(1),
  q: z.string().min(1),
  max: z.number().int().min(1).max(500).optional().default(100),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
});

type MarkReadByQueryInput = z.infer<typeof markReadByQueryInputSchema>;

export const markReadByQuery = defineTool<
  MarkReadByQueryInput,
  BulkOutput,
  EmailContext
>({
  name: "mark_read_by_query",
  description: "Bulk mark as read by Gmail query.",
  // Cast required: ZodDefault on `max`, `dry_run`, `confirm` widens schema's
  // input type vs the resolved input the handler receives.
  inputSchema: markReadByQueryInputSchema as unknown as z.ZodType<MarkReadByQueryInput>,
  handler: async (input, context) => {
    rejectIfSmtp(input.account, context.home);

    const { ids, scanned } = await listMatchingIds(
      context,
      input.account,
      input.q,
      input.max,
    );
    const preview = await buildPreview(context, input.account, ids);

    if (input.dry_run) {
      return { scanned, matched: ids.length, preview, applied: false };
    }

    if (ids.length === 0) {
      return { scanned, matched: 0, preview, applied: false };
    }

    guardDestructive({
      confirm: input.confirm,
      preview: `Will mark ${ids.length} messages as read for account ${input.account}. Query: ${input.q}`,
    });

    await context.client.batchModify(input.account, {
      ids,
      removeLabelIds: ["UNREAD"],
    });

    return { scanned, matched: ids.length, preview, applied: true };
  },
});

// ---------- archive_by_query ----------

const archiveByQueryInputSchema = z.object({
  account: z.string().min(1),
  q: z.string().min(1),
  max: z.number().int().min(1).max(500).optional().default(100),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
});

type ArchiveByQueryInput = z.infer<typeof archiveByQueryInputSchema>;

export const archiveByQuery = defineTool<
  ArchiveByQueryInput,
  BulkOutput,
  EmailContext
>({
  name: "archive_by_query",
  description: "Bulk archive by Gmail query (removes INBOX).",
  // Cast required: ZodDefault widens schema input type.
  inputSchema: archiveByQueryInputSchema as unknown as z.ZodType<ArchiveByQueryInput>,
  handler: async (input, context) => {
    rejectIfSmtp(input.account, context.home);

    const { ids, scanned } = await listMatchingIds(
      context,
      input.account,
      input.q,
      input.max,
    );
    const preview = await buildPreview(context, input.account, ids);

    if (input.dry_run) {
      return { scanned, matched: ids.length, preview, applied: false };
    }

    if (ids.length === 0) {
      return { scanned, matched: 0, preview, applied: false };
    }

    guardDestructive({
      confirm: input.confirm,
      preview: `Will archive ${ids.length} messages for account ${input.account} (removes INBOX label). Query: ${input.q}`,
    });

    await context.client.batchModify(input.account, {
      ids,
      removeLabelIds: ["INBOX"],
    });

    return { scanned, matched: ids.length, preview, applied: true };
  },
});

// ---------- trash_by_query ----------

const trashByQueryInputSchema = z.object({
  account: z.string().min(1),
  q: z.string().min(1),
  max: z.number().int().min(1).max(500).optional().default(100),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
});

type TrashByQueryInput = z.infer<typeof trashByQueryInputSchema>;

export const trashByQuery = defineTool<
  TrashByQueryInput,
  BulkOutput,
  EmailContext
>({
  name: "trash_by_query",
  description: "Bulk move to trash by Gmail query.",
  // Cast required: ZodDefault widens schema input type.
  inputSchema: trashByQueryInputSchema as unknown as z.ZodType<TrashByQueryInput>,
  handler: async (input, context) => {
    rejectIfSmtp(input.account, context.home);

    const { ids, scanned } = await listMatchingIds(
      context,
      input.account,
      input.q,
      input.max,
    );
    const preview = await buildPreview(context, input.account, ids);

    if (input.dry_run) {
      return { scanned, matched: ids.length, preview, applied: false };
    }

    if (ids.length === 0) {
      return { scanned, matched: 0, preview, applied: false };
    }

    guardDestructive({
      confirm: input.confirm,
      preview: `Will move ${ids.length} messages to Trash for account ${input.account}; auto-purged in 30 days; reversible until then. Query: ${input.q}`,
    });

    await context.client.batchTrash(input.account, ids);

    return { scanned, matched: ids.length, preview, applied: true };
  },
});

// ---------- apply_label_by_query ----------

const applyLabelByQueryInputSchema = z
  .object({
    account: z.string().min(1),
    q: z.string().min(1),
    add_label: z.string().optional(),
    remove_label: z.string().optional(),
    max: z.number().int().min(1).max(500).optional().default(100),
    dry_run: z.boolean().optional().default(true),
    confirm: z.boolean().optional().default(false),
  })
  .refine(
    (d) => d.add_label !== undefined || d.remove_label !== undefined,
    { message: "must provide at least one of add_label or remove_label" },
  );

type ApplyLabelByQueryInput = z.infer<typeof applyLabelByQueryInputSchema>;

function buildLabelPreview(
  matched: number,
  account: string,
  q: string,
  add_label: string | undefined,
  remove_label: string | undefined,
): string {
  const parts: string[] = [];
  if (add_label !== undefined) parts.push(`add label ${add_label}`);
  if (remove_label !== undefined) parts.push(`remove label ${remove_label}`);
  const action = parts.join(" and ");
  return `Will ${action} on ${matched} messages for account ${account}. Query: ${q}`;
}

function resolveLabelId(
  labels: Array<{ id: string; name: string }>,
  name: string,
): string {
  const hit = labels.find((l) => l.name === name);
  if (hit === undefined) {
    throw new NotFoundError(
      `label not found: ${name}; run list_labels to see available labels`,
    );
  }
  return hit.id;
}

// Action behaviour summary:
// - At least one of add_label / remove_label required (zod refinement).
// - Resolves names to Gmail label IDs BEFORE listing messages, so an unknown
//   name fails fast — no wasted Gmail search call.
// - SMTP rejection happens first to avoid leaking SMTP-transport accounts
//   into the listLabels code path.
export const applyLabelByQuery = defineTool<
  ApplyLabelByQueryInput,
  BulkOutput,
  EmailContext
>({
  name: "apply_label_by_query",
  description: "Bulk apply or remove label by query.",
  // Cast required: ZodDefault widens schema input type.
  inputSchema: applyLabelByQueryInputSchema as unknown as z.ZodType<ApplyLabelByQueryInput>,
  handler: async (input, context) => {
    rejectIfSmtp(input.account, context.home);

    // Resolve label names → IDs before anything else. Avoids a Gmail search
    // round-trip when the names are wrong.
    const labels = await context.client.listLabels(input.account);
    const addLabelId =
      input.add_label !== undefined
        ? resolveLabelId(labels, input.add_label)
        : undefined;
    const removeLabelId =
      input.remove_label !== undefined
        ? resolveLabelId(labels, input.remove_label)
        : undefined;

    const { ids, scanned } = await listMatchingIds(
      context,
      input.account,
      input.q,
      input.max,
    );
    const preview = await buildPreview(context, input.account, ids);

    if (input.dry_run) {
      return { scanned, matched: ids.length, preview, applied: false };
    }

    if (ids.length === 0) {
      return { scanned, matched: 0, preview, applied: false };
    }

    guardDestructive({
      confirm: input.confirm,
      preview: buildLabelPreview(
        ids.length,
        input.account,
        input.q,
        input.add_label,
        input.remove_label,
      ),
    });

    const opts: {
      ids: string[];
      addLabelIds?: string[];
      removeLabelIds?: string[];
    } = { ids };
    if (addLabelId !== undefined) opts.addLabelIds = [addLabelId];
    if (removeLabelId !== undefined) opts.removeLabelIds = [removeLabelId];
    await context.client.batchModify(input.account, opts);

    return { scanned, matched: ids.length, preview, applied: true };
  },
});
