import { z } from "zod";
import { defineTool, NotFoundError } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import type {
  GmailFilterAction,
  GmailFilterCriteria,
} from "../client.js";
import { mapFilter, type SlimFilter } from "../settings-mapper.js";
import { resolveAccount, rejectIfSmtp } from "./account.js";

/**
 * Gmail system label ids. `create_filter` accepts label NAMES or ids in
 * add/remove; user labels resolve by name via list_labels, and these system
 * ids pass through as-is even if list_labels does not surface them.
 */
const SYSTEM_LABEL_IDS = new Set<string>([
  "INBOX",
  "SPAM",
  "TRASH",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SENT",
  "DRAFT",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

// ---------- create_filter (flagship) ----------

const criteriaSchema = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  has_attachment: z.boolean().optional(),
  exclude_chats: z.boolean().optional(),
  negated_query: z.string().min(1).optional(),
  size: z.number().int().min(0).optional(),
  size_comparison: z.enum(["unspecified", "smaller", "larger"]).optional(),
});

const actionSchema = z.object({
  add_label_ids: z.array(z.string().min(1)).optional(),
  remove_label_ids: z.array(z.string().min(1)).optional(),
  forward: z.string().min(1).optional(),
});

const createFilterInputSchema = z
  .object({
    account: z.string().min(1).optional(),
    criteria: criteriaSchema,
    action: actionSchema,
  })
  .refine((d) => Object.values(d.criteria).some((v) => v !== undefined), {
    message: "criteria must have at least one field",
  })
  .refine((d) => Object.values(d.action).some((v) => v !== undefined), {
    message:
      "action must have at least one of add_label_ids, remove_label_ids, forward",
  });

type CreateFilterInput = z.infer<typeof createFilterInputSchema>;

function buildCriteria(
  input: CreateFilterInput["criteria"],
): GmailFilterCriteria {
  const criteria: GmailFilterCriteria = {};
  if (input.from !== undefined) criteria.from = input.from;
  if (input.to !== undefined) criteria.to = input.to;
  if (input.subject !== undefined) criteria.subject = input.subject;
  if (input.query !== undefined) criteria.query = input.query;
  if (input.negated_query !== undefined)
    criteria.negatedQuery = input.negated_query;
  if (input.has_attachment !== undefined)
    criteria.hasAttachment = input.has_attachment;
  if (input.exclude_chats !== undefined)
    criteria.excludeChats = input.exclude_chats;
  if (input.size !== undefined) criteria.size = input.size;
  if (input.size_comparison !== undefined)
    criteria.sizeComparison = input.size_comparison;
  return criteria;
}

/**
 * Resolve label NAMES or ids to Gmail label ids for `create_filter`. Fetches
 * the account's labels once; a token matching a known id passes through, a
 * token matching a known name maps to that label's id, and a recognised system
 * label id passes through even if list_labels did not surface it. Anything else
 * is a NotFoundError so a typo never silently produces a no-op filter.
 */
async function buildAction(
  context: EmailContext,
  account: string,
  action: CreateFilterInput["action"],
): Promise<GmailFilterAction> {
  const out: GmailFilterAction = {};
  const needsLabels =
    (action.add_label_ids?.length ?? 0) > 0 ||
    (action.remove_label_ids?.length ?? 0) > 0;

  let byId: Set<string> | undefined;
  let byName: Map<string, string> | undefined;
  if (needsLabels) {
    const labels = await context.client.listLabels(account);
    byId = new Set(labels.map((l) => l.id));
    byName = new Map(labels.map((l) => [l.name, l.id]));
  }

  const resolve = (token: string): string => {
    if (byId?.has(token)) return token;
    const named = byName?.get(token);
    if (named !== undefined) return named;
    if (SYSTEM_LABEL_IDS.has(token)) return token;
    throw new NotFoundError(
      `label not found: ${token}; run list_labels to see available labels`,
    );
  };

  if (action.add_label_ids !== undefined)
    out.addLabelIds = action.add_label_ids.map(resolve);
  if (action.remove_label_ids !== undefined)
    out.removeLabelIds = action.remove_label_ids.map(resolve);
  if (action.forward !== undefined) out.forward = action.forward;
  return out;
}

export const createFilter = defineTool<CreateFilterInput, SlimFilter, EmailContext>({
  name: "create_filter",
  description: "Create a Gmail filter; resolves label names to ids.",
  // Cast required: the two .refine()s widen the schema type vs the resolved
  // input the handler sees.
  inputSchema: createFilterInputSchema as unknown as z.ZodType<CreateFilterInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    const criteria = buildCriteria(input.criteria);
    const action = await buildAction(context, account, input.action);
    const created = await context.client.createFilter(account, {
      criteria,
      action,
    });
    return mapFilter(created);
  },
});

// ---------- list_filters ----------

const listFiltersInputSchema = z.object({
  account: z.string().min(1).optional(),
});

type ListFiltersInput = z.infer<typeof listFiltersInputSchema>;

type ListFiltersOutput = {
  filters: SlimFilter[];
  count: number;
};

export const listFilters = defineTool<
  ListFiltersInput,
  ListFiltersOutput,
  EmailContext
>({
  name: "list_filters",
  description: "List all Gmail filters for account.",
  inputSchema: listFiltersInputSchema,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    const raw = await context.client.listFilters(account);
    const filters = raw.map(mapFilter);
    return { filters, count: filters.length };
  },
});

// ---------- delete_filter ----------

const deleteFilterInputSchema = z.object({
  account: z.string().min(1).optional(),
  filter_id: z.string().min(1),
});

type DeleteFilterInput = z.infer<typeof deleteFilterInputSchema>;

type DeleteFilterOutput = {
  id: string;
  deleted: boolean;
};

export const deleteFilter = defineTool<
  DeleteFilterInput,
  DeleteFilterOutput,
  EmailContext
>({
  name: "delete_filter",
  description: "Delete a Gmail filter by id.",
  inputSchema: deleteFilterInputSchema,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    await context.client.deleteFilter(account, input.filter_id);
    return { id: input.filter_id, deleted: true };
  },
});
