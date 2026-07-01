import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { mapDelegate, type SlimDelegate } from "../settings-mapper.js";
import { resolveAccount, rejectIfSmtp } from "./account.js";

// ---------- list_delegates ----------

const listDelegatesInputSchema = z.object({
  account: z.string().min(1).optional(),
});

type ListDelegatesInput = z.infer<typeof listDelegatesInputSchema>;

type ListDelegatesOutput = {
  delegates: SlimDelegate[];
  count: number;
};

export const listDelegates = defineTool<
  ListDelegatesInput,
  ListDelegatesOutput,
  EmailContext
>({
  name: "list_delegates",
  description: "List mailbox delegates for account.",
  inputSchema: listDelegatesInputSchema,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    const raw = await context.client.listDelegates(account);
    const delegates = raw.map(mapDelegate);
    return { delegates, count: delegates.length };
  },
});

// ---------- create_delegate ----------

const createDelegateInputSchema = z.object({
  account: z.string().min(1).optional(),
  delegate_email: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type CreateDelegateInput = z.infer<typeof createDelegateInputSchema>;

export const createDelegate = defineTool<
  CreateDelegateInput,
  SlimDelegate,
  EmailContext
>({
  name: "create_delegate",
  description: "Grant a delegate access to the mailbox (gated).",
  // Cast required: ZodDefault on `confirm` widens the schema input type.
  inputSchema:
    createDelegateInputSchema as unknown as z.ZodType<CreateDelegateInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    guardDestructive({
      confirm: input.confirm,
      preview: `Will add delegate ${input.delegate_email} to account ${account}; grants ${input.delegate_email} FULL read/send access to your mailbox.`,
    });
    const raw = await context.client.createDelegate(
      account,
      input.delegate_email,
    );
    return mapDelegate(raw);
  },
});

// ---------- delete_delegate ----------

const deleteDelegateInputSchema = z.object({
  account: z.string().min(1).optional(),
  delegate_email: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteDelegateInput = z.infer<typeof deleteDelegateInputSchema>;

type DeleteDelegateOutput = {
  delegate_email: string;
  deleted: boolean;
};

export const deleteDelegate = defineTool<
  DeleteDelegateInput,
  DeleteDelegateOutput,
  EmailContext
>({
  name: "delete_delegate",
  description: "Revoke a delegate's access (gated).",
  // Cast required: ZodDefault on `confirm` widens the schema input type.
  inputSchema:
    deleteDelegateInputSchema as unknown as z.ZodType<DeleteDelegateInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    guardDestructive({
      confirm: input.confirm,
      preview: `Will remove delegate ${input.delegate_email} from account ${account}.`,
    });
    await context.client.deleteDelegate(account, input.delegate_email);
    return { delegate_email: input.delegate_email, deleted: true };
  },
});
