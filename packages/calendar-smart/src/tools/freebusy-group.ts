import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";

// =============================================================================
// freebusy_group
// =============================================================================

const freebusyGroupInputSchema = z.object({
  group_email: z.string().min(1),
  time_min: z.string().min(1),
  time_max: z.string().min(1),
  group_expansion_max: z.number().int().min(1).optional().default(100),
  calendar_expansion_max: z.number().int().min(1).optional().default(50),
});

type FreebusyGroupInput = z.input<typeof freebusyGroupInputSchema>;
type FreebusyGroupParsed = z.infer<typeof freebusyGroupInputSchema>;

type BusySpan = { start: string; end: string };
type GroupMemberError = { domain: string; reason: string };
type GroupMemberResult = {
  email: string;
  busy: BusySpan[];
  errors: GroupMemberError[];
};
type FreebusyGroupOutput = { members: GroupMemberResult[] };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Map a raw `busy[]` array from Google's freeBusy response into a slim
 * `BusySpan[]`. Items missing either `start` or `end` are skipped — Google
 * shouldn't emit such entries, but defensive parsing keeps `undefined` from
 * leaking into the slim output.
 */
function mapBusy(value: unknown): BusySpan[] {
  if (!Array.isArray(value)) return [];
  const out: BusySpan[] = [];
  for (const span of value) {
    const obj = asObject(span);
    if (!obj) continue;
    if (typeof obj.start !== "string" || typeof obj.end !== "string") continue;
    out.push({ start: obj.start, end: obj.end });
  }
  return out;
}

/**
 * Map raw `errors[]` from Google's per-calendar freeBusy block into the slim
 * `{ domain, reason }` shape. Google's error entries always carry both
 * fields; defensive parsing drops malformed entries silently.
 */
function mapErrors(value: unknown): GroupMemberError[] {
  if (!Array.isArray(value)) return [];
  const out: GroupMemberError[] = [];
  for (const e of value) {
    const obj = asObject(e);
    if (!obj) continue;
    const domain = typeof obj.domain === "string" ? obj.domain : "";
    const reason = typeof obj.reason === "string" ? obj.reason : "";
    out.push({ domain, reason });
  }
  return out;
}

export const freebusyGroupTool = defineTool<
  FreebusyGroupInput,
  FreebusyGroupOutput,
  CalendarContext
>({
  name: "freebusy_group",
  description: "Query group calendar availability",
  // Cast required because expansion-max fields have `.optional().default(...)`.
  inputSchema:
    freebusyGroupInputSchema as unknown as z.ZodType<FreebusyGroupInput>,
  handler: async (input, ctx) => {
    const parsed = input as FreebusyGroupParsed;
    const raw = await ctx.client.freeBusyGroup({
      timeMin: parsed.time_min,
      timeMax: parsed.time_max,
      groupEmail: parsed.group_email,
      groupExpansionMax: parsed.group_expansion_max,
      calendarExpansionMax: parsed.calendar_expansion_max,
    });

    // Group expansion: Google returns one entry per member calendar (keyed
    // by member email). Surface them as an array so consumers can iterate
    // without juggling object keys; preserve per-member errors so partial
    // failures don't drop the whole call.
    const members: GroupMemberResult[] = [];
    for (const [email, block] of Object.entries(raw.calendars)) {
      members.push({
        email,
        busy: mapBusy(block.busy),
        errors: mapErrors(block.errors),
      });
    }
    return { members };
  },
});
