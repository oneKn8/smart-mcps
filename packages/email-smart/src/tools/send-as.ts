import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import type { UpdateSendAsOpts } from "../client.js";
import { mapSendAs, type SlimSendAs } from "../settings-mapper.js";
import { resolveAccount, rejectIfSmtp } from "./account.js";

// ---------- list_send_as ----------

const listSendAsInputSchema = z.object({
  account: z.string().min(1).optional(),
});

type ListSendAsInput = z.infer<typeof listSendAsInputSchema>;

type ListSendAsOutput = {
  send_as: SlimSendAs[];
  count: number;
};

export const listSendAs = defineTool<
  ListSendAsInput,
  ListSendAsOutput,
  EmailContext
>({
  name: "list_send_as",
  description: "List send-as aliases and signatures.",
  inputSchema: listSendAsInputSchema,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    const raw = await context.client.listSendAs(account);
    const send_as = raw.map(mapSendAs);
    return { send_as, count: send_as.length };
  },
});

// ---------- update_send_as ----------

const updateSendAsInputSchema = z
  .object({
    account: z.string().min(1).optional(),
    send_as_email: z.string().min(1),
    signature: z.string().optional(),
    display_name: z.string().optional(),
  })
  .refine((d) => d.signature !== undefined || d.display_name !== undefined, {
    message: "must provide signature or display_name",
  });

type UpdateSendAsInput = z.infer<typeof updateSendAsInputSchema>;

export const updateSendAs = defineTool<
  UpdateSendAsInput,
  SlimSendAs,
  EmailContext
>({
  name: "update_send_as",
  description: "Update a send-as signature or display name.",
  // Cast required: the .refine() widens the schema type vs the resolved input.
  inputSchema:
    updateSendAsInputSchema as unknown as z.ZodType<UpdateSendAsInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    const opts: UpdateSendAsOpts = {};
    if (input.signature !== undefined) opts.signature = input.signature;
    if (input.display_name !== undefined) opts.displayName = input.display_name;
    const raw = await context.client.updateSendAs(
      account,
      input.send_as_email,
      opts,
    );
    return mapSendAs(raw);
  },
});
