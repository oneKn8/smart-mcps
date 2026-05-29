import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { nullableBoolean, nullableNumber } from "../null-helpers.js";

// ---------------------------------------------------------------------------
// dnd_status
// ---------------------------------------------------------------------------

const dndStatusInputSchema = z.object({
  user: z.string().optional(),
});

type DndStatusInput = z.infer<typeof dndStatusInputSchema>;

type DndStatusOutput = {
  dnd_enabled: boolean;
  next_dnd_start_ts?: number;
  next_dnd_end_ts?: number;
  snooze_enabled?: boolean;
  snooze_endtime?: number;
};

export const dnd_status = defineTool<DndStatusInput, DndStatusOutput, SlackContext>({
  name: "dnd_status",
  description: "Get Do Not Disturb status for a user (user token, scope dnd:read).",
  inputSchema: dndStatusInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.dndInfo({
      ...(input.user !== undefined ? { user: input.user } : {}),
    });
    const dnd_enabled = nullableBoolean(resp.dnd_enabled) ?? false;
    const out: DndStatusOutput = { dnd_enabled };
    const start = nullableNumber(resp.next_dnd_start_ts);
    const end = nullableNumber(resp.next_dnd_end_ts);
    const snoozeEnabled = nullableBoolean(resp.snooze_enabled);
    const snoozeEnd = nullableNumber(resp.snooze_endtime);
    if (start !== null) out.next_dnd_start_ts = start;
    if (end !== null) out.next_dnd_end_ts = end;
    if (snoozeEnabled !== null) out.snooze_enabled = snoozeEnabled;
    if (snoozeEnd !== null) out.snooze_endtime = snoozeEnd;
    return out;
  },
});

// ---------------------------------------------------------------------------
// set_snooze
// ---------------------------------------------------------------------------

// Cast required: ZodDefault on confirm widens schema input type vs the resolved
// type the handler receives.
const setSnoozeInputSchema = z.object({
  num_minutes: z.number().int().min(1),
  confirm: z.boolean().optional().default(false),
});

type SetSnoozeInput = z.infer<typeof setSnoozeInputSchema>;

type SetSnoozeOutput = { ok: true; snooze_endtime?: number };

export const set_snooze = defineTool<SetSnoozeInput, SetSnoozeOutput, SlackContext>({
  name: "set_snooze",
  description: "Snooze notifications for N minutes (user token, scope dnd:write).",
  inputSchema: setSnoozeInputSchema as unknown as z.ZodType<SetSnoozeInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: `Snooze notifications for ${input.num_minutes} minutes`,
    });
    const resp = await context.client.setSnooze({ num_minutes: input.num_minutes });
    const out: SetSnoozeOutput = { ok: true };
    const snoozeEnd = nullableNumber(resp.snooze_endtime);
    if (snoozeEnd !== null) out.snooze_endtime = snoozeEnd;
    return out;
  },
});

// ---------------------------------------------------------------------------
// end_snooze
// ---------------------------------------------------------------------------

// Cast required: ZodDefault on confirm widens schema input type vs the resolved
// type the handler receives.
const endSnoozeInputSchema = z.object({
  confirm: z.boolean().optional().default(false),
});

type EndSnoozeInput = z.infer<typeof endSnoozeInputSchema>;

type EndSnoozeOutput = { ok: true };

export const end_snooze = defineTool<EndSnoozeInput, EndSnoozeOutput, SlackContext>({
  name: "end_snooze",
  description: "End Do Not Disturb snooze immediately (user token, scope dnd:write).",
  inputSchema: endSnoozeInputSchema as unknown as z.ZodType<EndSnoozeInput>,
  handler: async (input, context) => {
    guardDestructive({
      confirm: input.confirm,
      preview: "End Do Not Disturb snooze",
    });
    await context.client.endSnooze();
    return { ok: true };
  },
});
