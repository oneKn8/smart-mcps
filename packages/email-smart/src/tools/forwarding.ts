import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import type { GmailAutoForwarding } from "../client.js";
import {
  mapAutoForwarding,
  mapForwardingAddress,
  type SlimAutoForwarding,
  type SlimForwardingAddress,
} from "../settings-mapper.js";
import { resolveAccount, rejectIfSmtp } from "./account.js";

// ---------- get_auto_forwarding ----------

const getAutoForwardingInputSchema = z.object({
  account: z.string().min(1).optional(),
});

type GetAutoForwardingInput = z.infer<typeof getAutoForwardingInputSchema>;

export const getAutoForwarding = defineTool<
  GetAutoForwardingInput,
  SlimAutoForwarding,
  EmailContext
>({
  name: "get_auto_forwarding",
  description: "Get auto-forwarding settings for account.",
  inputSchema: getAutoForwardingInputSchema,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    const raw = await context.client.getAutoForwarding(account);
    return mapAutoForwarding(raw);
  },
});

// ---------- update_auto_forwarding ----------

const DISPOSITION = z.enum([
  "dispositionUnspecified",
  "leaveInInbox",
  "archive",
  "trash",
  "markRead",
]);

const updateAutoForwardingInputSchema = z
  .object({
    account: z.string().min(1).optional(),
    enabled: z.boolean(),
    email_address: z.string().min(1).optional(),
    disposition: DISPOSITION.optional(),
    confirm: z.boolean().optional().default(false),
  })
  .refine((d) => d.enabled !== true || d.email_address !== undefined, {
    message: "enabling auto-forwarding requires email_address",
  });

type UpdateAutoForwardingInput = z.infer<typeof updateAutoForwardingInputSchema>;

export const updateAutoForwarding = defineTool<
  UpdateAutoForwardingInput,
  SlimAutoForwarding,
  EmailContext
>({
  name: "update_auto_forwarding",
  description: "Enable or disable auto-forwarding (gated when enabling).",
  // Cast required: the .refine() and ZodDefault on `confirm` widen the schema
  // type vs the resolved input the handler receives.
  inputSchema:
    updateAutoForwardingInputSchema as unknown as z.ZodType<UpdateAutoForwardingInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    if (input.enabled === true) {
      guardDestructive({
        confirm: input.confirm,
        preview: `Will enable auto-forwarding for account ${account}: this forwards your incoming mail to ${input.email_address} OUTSIDE this account.`,
      });
    }
    const settings: GmailAutoForwarding = { enabled: input.enabled };
    if (input.email_address !== undefined)
      settings.emailAddress = input.email_address;
    if (input.disposition !== undefined)
      settings.disposition = input.disposition;
    const raw = await context.client.updateAutoForwarding(account, settings);
    return mapAutoForwarding(raw);
  },
});

// ---------- list_forwarding_addresses ----------

const listForwardingAddressesInputSchema = z.object({
  account: z.string().min(1).optional(),
});

type ListForwardingAddressesInput = z.infer<
  typeof listForwardingAddressesInputSchema
>;

type ListForwardingAddressesOutput = {
  forwarding_addresses: SlimForwardingAddress[];
  count: number;
};

export const listForwardingAddresses = defineTool<
  ListForwardingAddressesInput,
  ListForwardingAddressesOutput,
  EmailContext
>({
  name: "list_forwarding_addresses",
  description: "List forwarding addresses for account.",
  inputSchema: listForwardingAddressesInputSchema,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    const raw = await context.client.listForwardingAddresses(account);
    const forwarding_addresses = raw.map(mapForwardingAddress);
    return { forwarding_addresses, count: forwarding_addresses.length };
  },
});

// ---------- create_forwarding_address ----------

const createForwardingAddressInputSchema = z.object({
  account: z.string().min(1).optional(),
  forwarding_email: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type CreateForwardingAddressInput = z.infer<
  typeof createForwardingAddressInputSchema
>;

export const createForwardingAddress = defineTool<
  CreateForwardingAddressInput,
  SlimForwardingAddress,
  EmailContext
>({
  name: "create_forwarding_address",
  description: "Register a forwarding address (gated).",
  // Cast required: ZodDefault on `confirm` widens the schema input type.
  inputSchema:
    createForwardingAddressInputSchema as unknown as z.ZodType<CreateForwardingAddressInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    guardDestructive({
      confirm: input.confirm,
      preview: `Will register forwarding address ${input.forwarding_email} for account ${account}; once verified, your mail can be forwarded outside this account.`,
    });
    const raw = await context.client.createForwardingAddress(
      account,
      input.forwarding_email,
    );
    return mapForwardingAddress(raw);
  },
});

// ---------- delete_forwarding_address ----------

const deleteForwardingAddressInputSchema = z.object({
  account: z.string().min(1).optional(),
  forwarding_email: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteForwardingAddressInput = z.infer<
  typeof deleteForwardingAddressInputSchema
>;

type DeleteForwardingAddressOutput = {
  forwarding_email: string;
  deleted: boolean;
};

export const deleteForwardingAddress = defineTool<
  DeleteForwardingAddressInput,
  DeleteForwardingAddressOutput,
  EmailContext
>({
  name: "delete_forwarding_address",
  description: "Remove a forwarding address (gated).",
  // Cast required: ZodDefault on `confirm` widens the schema input type.
  inputSchema:
    deleteForwardingAddressInputSchema as unknown as z.ZodType<DeleteForwardingAddressInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    guardDestructive({
      confirm: input.confirm,
      preview: `Will remove forwarding address ${input.forwarding_email} for account ${account}.`,
    });
    await context.client.deleteForwardingAddress(
      account,
      input.forwarding_email,
    );
    return { forwarding_email: input.forwarding_email, deleted: true };
  },
});
