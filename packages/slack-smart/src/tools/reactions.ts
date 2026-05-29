import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { nullableString, nullableNumber } from "../null-helpers.js";

// ---------------------------------------------------------------------------
// add_reaction
// ---------------------------------------------------------------------------

// Cast required: ZodDefault on confirm widens schema input type vs the resolved
// type the handler receives.
const addReactionInputSchema = z.object({
  channel: z.string().min(1),
  timestamp: z.string().min(1),
  name: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type AddReactionInput = z.infer<typeof addReactionInputSchema>;

type AddReactionOutput = { ok: true };

export const add_reaction = defineTool<
  AddReactionInput,
  AddReactionOutput,
  SlackContext
>({
  name: "add_reaction",
  description: "Add an emoji reaction to a message (user token, scope reactions:write).",
  inputSchema: addReactionInputSchema as unknown as z.ZodType<AddReactionInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Add :${input.name}: to message ${input.timestamp} in ${input.channel}`,
    });
    await context.client.addReaction({
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.name,
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// remove_reaction
// ---------------------------------------------------------------------------

// Cast required: ZodDefault on confirm widens schema input type vs the resolved
// type the handler receives.
const removeReactionInputSchema = z.object({
  channel: z.string().min(1),
  timestamp: z.string().min(1),
  name: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type RemoveReactionInput = z.infer<typeof removeReactionInputSchema>;

type RemoveReactionOutput = { ok: true };

export const remove_reaction = defineTool<
  RemoveReactionInput,
  RemoveReactionOutput,
  SlackContext
>({
  name: "remove_reaction",
  description: "Remove an emoji reaction from a message (user token, scope reactions:write).",
  inputSchema: removeReactionInputSchema as unknown as z.ZodType<RemoveReactionInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Remove :${input.name}: from message ${input.timestamp} in ${input.channel}`,
    });
    await context.client.removeReaction({
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.name,
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// get_reactions
// ---------------------------------------------------------------------------

type SlimReaction = {
  name: string;
  count: number;
  users?: string[];
};

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function mapReaction(raw: unknown): SlimReaction {
  const obj = asObject(raw);
  const name = nullableString(obj["name"]) ?? "";
  const count = nullableNumber(obj["count"]) ?? 0;
  const slim: SlimReaction = { name, count };

  const users = obj["users"];
  if (Array.isArray(users) && users.length > 0) {
    slim.users = users.filter((u): u is string => typeof u === "string");
  }

  return slim;
}

const getReactionsInputSchema = z.object({
  channel: z.string().min(1),
  timestamp: z.string().min(1),
  full: z.boolean().optional(),
});

type GetReactionsInput = z.infer<typeof getReactionsInputSchema>;

type GetReactionsOutput = {
  reactions: SlimReaction[];
};

export const get_reactions = defineTool<
  GetReactionsInput,
  GetReactionsOutput,
  SlackContext
>({
  name: "get_reactions",
  description: "Get reactions on a message (user token, scope reactions:read).",
  inputSchema: getReactionsInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.getReactions({
      channel: input.channel,
      timestamp: input.timestamp,
      ...(input.full !== undefined ? { full: input.full } : {}),
    });
    const raw = resp.message?.reactions ?? [];
    const reactions = raw.map(mapReaction);
    return { reactions };
  },
});
