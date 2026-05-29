import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { nullableString, asObject } from "../null-helpers.js";

// ---------------------------------------------------------------------------
// list_pins
// ---------------------------------------------------------------------------

const listPinsInputSchema = z.object({
  channel: z.string().min(1),
});

type ListPinsInput = z.infer<typeof listPinsInputSchema>;

type SlimPinItem = {
  type: string;
  ts?: string;
  text?: string;
  user?: string;
  file_id?: string;
};

function mapPinItem(raw: unknown): SlimPinItem {
  const obj = asObject(raw);
  const type = nullableString(obj["type"]) ?? "unknown";
  const slim: SlimPinItem = { type };

  if (type === "message") {
    const msg = asObject(obj["message"]);
    const ts = nullableString(msg["ts"]);
    const text = nullableString(msg["text"]);
    const user = nullableString(msg["user"]);
    if (ts !== null) slim.ts = ts;
    if (text !== null) slim.text = text;
    if (user !== null) slim.user = user;
  } else if (type === "file") {
    const file = asObject(obj["file"]);
    const id = nullableString(file["id"]);
    if (id !== null) slim.file_id = id;
  }

  return slim;
}

type ListPinsOutput = {
  items: SlimPinItem[];
  count: number;
};

export const list_pins = defineTool<ListPinsInput, ListPinsOutput, SlackContext>({
  name: "list_pins",
  description: "List pinned items in a channel (user token, scope pins:read).",
  inputSchema: listPinsInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.listPins({ channel: input.channel });
    const items = resp.items.map(mapPinItem);
    return { items, count: items.length };
  },
});

// ---------------------------------------------------------------------------
// pin_message
// ---------------------------------------------------------------------------

// Cast required: ZodDefault on confirm widens schema input type vs the resolved
// type the handler receives.
const pinMessageInputSchema = z.object({
  channel: z.string().min(1),
  timestamp: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type PinMessageInput = z.infer<typeof pinMessageInputSchema>;

type PinMessageOutput = { ok: true };

export const pin_message = defineTool<PinMessageInput, PinMessageOutput, SlackContext>({
  name: "pin_message",
  description: "Pin a message in a channel (user token, scope pins:write).",
  inputSchema: pinMessageInputSchema as unknown as z.ZodType<PinMessageInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Pin message ${input.timestamp} in ${input.channel}`,
    });
    await context.client.addPin({ channel: input.channel, timestamp: input.timestamp });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// unpin_message
// ---------------------------------------------------------------------------

// Cast required: ZodDefault on confirm widens schema input type vs the resolved
// type the handler receives.
const unpinMessageInputSchema = z.object({
  channel: z.string().min(1),
  timestamp: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type UnpinMessageInput = z.infer<typeof unpinMessageInputSchema>;

type UnpinMessageOutput = { ok: true };

export const unpin_message = defineTool<UnpinMessageInput, UnpinMessageOutput, SlackContext>({
  name: "unpin_message",
  description: "Unpin a message from a channel (user token, scope pins:write).",
  inputSchema: unpinMessageInputSchema as unknown as z.ZodType<UnpinMessageInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Unpin message ${input.timestamp} in ${input.channel}`,
    });
    await context.client.removePin({ channel: input.channel, timestamp: input.timestamp });
    return { ok: true };
  },
});
