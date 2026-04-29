import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import {
  listIdentities,
  loadIdentity,
  type Identity,
} from "../identities.js";

// ---------- list_identities ----------

const listIdentitiesInputSchema = z.object({});
type ListIdentitiesInput = z.infer<typeof listIdentitiesInputSchema>;

type SlimIdentity = {
  account: string;
  email: string;
  display_name: string;
  transport: Identity["transport"];
};

type ListIdentitiesOutput = {
  identities: SlimIdentity[];
  count: number;
};

function slim(identity: Identity): SlimIdentity {
  return {
    account: identity.account,
    email: identity.email,
    display_name: identity.display_name,
    transport: identity.transport,
  };
}

export const listIdentitiesTool = defineTool<
  ListIdentitiesInput,
  ListIdentitiesOutput,
  EmailContext
>({
  name: "list_identities",
  description: "List all configured Gmail accounts.",
  inputSchema: listIdentitiesInputSchema as unknown as z.ZodType<ListIdentitiesInput>,
  handler: async (_input, context) => {
    const all = listIdentities(context.home);
    const identities = all.map(slim);
    return { identities, count: identities.length };
  },
});

// ---------- get_identity ----------

const getIdentityInputSchema = z.object({
  account: z.string().min(1),
  include_signature: z.boolean().optional().default(false),
});
type GetIdentityInput = z.infer<typeof getIdentityInputSchema>;

type GetIdentityOutput = {
  account: string;
  email: string;
  display_name: string;
  default_footer?: string;
  default_reply_to?: string;
  transport: Identity["transport"];
  signature_html?: string;
  signature_text?: string;
};

export const getIdentityTool = defineTool<
  GetIdentityInput,
  GetIdentityOutput,
  EmailContext
>({
  name: "get_identity",
  description: "Show full identity record for an account.",
  // Cast required: ZodDefault on `include_signature` widens schema input type
  // vs the resolved output the handler sees.
  inputSchema: getIdentityInputSchema as unknown as z.ZodType<GetIdentityInput>,
  handler: async (input, context) => {
    const identity = loadIdentity(input.account, context.home);
    const out: GetIdentityOutput = {
      account: identity.account,
      email: identity.email,
      display_name: identity.display_name,
      transport: identity.transport,
    };
    if (identity.default_footer !== undefined) {
      out.default_footer = identity.default_footer;
    }
    if (identity.default_reply_to !== undefined) {
      out.default_reply_to = identity.default_reply_to;
    }
    if (input.include_signature) {
      if (identity.signature_html !== undefined) {
        out.signature_html = identity.signature_html;
      }
      if (identity.signature_text !== undefined) {
        out.signature_text = identity.signature_text;
      }
    }
    return out;
  },
});
