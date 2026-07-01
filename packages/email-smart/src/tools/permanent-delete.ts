import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { resolveAccount, rejectIfSmtp } from "./account.js";

// These three tools use the full `https://mail.google.com/` scope and are
// IRREVERSIBLE: they bypass Trash and cannot be undone. All are hard-gated with
// guardDestructive; batch_delete_messages additionally defaults to dry_run.

// ---------- delete_message_permanent ----------

const deleteMessagePermanentInputSchema = z.object({
  account: z.string().min(1).optional(),
  message_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteMessagePermanentInput = z.infer<
  typeof deleteMessagePermanentInputSchema
>;

type DeleteMessagePermanentOutput = {
  id: string;
  deleted: boolean;
};

export const deleteMessagePermanent = defineTool<
  DeleteMessagePermanentInput,
  DeleteMessagePermanentOutput,
  EmailContext
>({
  name: "delete_message_permanent",
  description: "Permanently delete a message (bypasses trash).",
  // Cast required: ZodDefault on `confirm` widens the schema input type.
  inputSchema:
    deleteMessagePermanentInputSchema as unknown as z.ZodType<DeleteMessagePermanentInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    guardDestructive({
      confirm: input.confirm,
      preview: `Will PERMANENTLY delete ${input.message_id} (bypasses trash, CANNOT be recovered) for account ${account}.`,
    });
    await context.client.deleteMessage(account, input.message_id);
    return { id: input.message_id, deleted: true };
  },
});

// ---------- delete_thread_permanent ----------

const deleteThreadPermanentInputSchema = z.object({
  account: z.string().min(1).optional(),
  thread_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteThreadPermanentInput = z.infer<
  typeof deleteThreadPermanentInputSchema
>;

type DeleteThreadPermanentOutput = {
  id: string;
  deleted: boolean;
};

export const deleteThreadPermanent = defineTool<
  DeleteThreadPermanentInput,
  DeleteThreadPermanentOutput,
  EmailContext
>({
  name: "delete_thread_permanent",
  description: "Permanently delete a thread (bypasses trash).",
  // Cast required: ZodDefault on `confirm` widens the schema input type.
  inputSchema:
    deleteThreadPermanentInputSchema as unknown as z.ZodType<DeleteThreadPermanentInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    guardDestructive({
      confirm: input.confirm,
      preview: `Will PERMANENTLY delete ${input.thread_id} (bypasses trash, CANNOT be recovered) for account ${account}; every message in the thread is deleted too.`,
    });
    await context.client.deleteThread(account, input.thread_id);
    return { id: input.thread_id, deleted: true };
  },
});

// ---------- batch_delete_messages ----------

const batchDeleteMessagesInputSchema = z.object({
  account: z.string().min(1).optional(),
  message_ids: z.array(z.string().min(1)).min(1),
  dry_run: z.boolean().default(true),
  confirm: z.boolean().optional().default(false),
});

type BatchDeleteMessagesInput = z.infer<typeof batchDeleteMessagesInputSchema>;

type BatchDeleteMessagesOutput = {
  count: number;
  message_ids: string[];
  applied: boolean;
};

export const batchDeleteMessages = defineTool<
  BatchDeleteMessagesInput,
  BatchDeleteMessagesOutput,
  EmailContext
>({
  name: "batch_delete_messages",
  description: "Permanently delete many messages (dry_run default).",
  // Cast required: ZodDefault on `dry_run` / `confirm` widens the schema input
  // type vs the resolved input the handler receives.
  inputSchema:
    batchDeleteMessagesInputSchema as unknown as z.ZodType<BatchDeleteMessagesInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    const ids = input.message_ids;

    // dry_run wins over confirm: surface the ids that WOULD be deleted without
    // touching Gmail.
    if (input.dry_run) {
      return { count: ids.length, message_ids: ids, applied: false };
    }

    guardDestructive({
      confirm: input.confirm,
      preview: `Will PERMANENTLY delete ${ids.length} messages (bypasses trash, CANNOT be recovered) for account ${account}.`,
    });
    await context.client.batchDeleteMessages(account, ids);
    return { count: ids.length, message_ids: ids, applied: true };
  },
});
