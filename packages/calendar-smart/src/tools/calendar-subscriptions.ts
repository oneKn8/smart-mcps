import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapCalendar, type SlimCalendar } from "../calendar-mapper.js";

// =============================================================================
// subscribe_calendar
// =============================================================================

const subscribeCalendarInputSchema = z.object({
  calendar_id: z.string().min(1),
  color_id: z.string().optional(),
  background_color: z.string().optional(),
  foreground_color: z.string().optional(),
  summary_override: z.string().optional(),
  selected: z.boolean().optional().default(true),
  hidden: z.boolean().optional().default(false),
});

type SubscribeCalendarInput = z.input<typeof subscribeCalendarInputSchema>;
type SubscribeCalendarParsed = z.infer<typeof subscribeCalendarInputSchema>;
type SubscribeCalendarOutput = { calendar: SlimCalendar };

export const subscribeCalendarTool = defineTool<
  SubscribeCalendarInput,
  SubscribeCalendarOutput,
  CalendarContext
>({
  name: "subscribe_calendar",
  description: "Add an existing calendar to your sidebar",
  // Cast required because `selected` and `hidden` have defaults.
  inputSchema:
    subscribeCalendarInputSchema as unknown as z.ZodType<SubscribeCalendarInput>,
  handler: async (input, ctx) => {
    const parsed = input as SubscribeCalendarParsed;
    const body: Record<string, unknown> = { id: parsed.calendar_id };
    if (parsed.color_id !== undefined) body.colorId = parsed.color_id;
    if (parsed.background_color !== undefined) {
      body.backgroundColor = parsed.background_color;
    }
    if (parsed.foreground_color !== undefined) {
      body.foregroundColor = parsed.foreground_color;
    }
    if (parsed.summary_override !== undefined) {
      body.summaryOverride = parsed.summary_override;
    }
    body.selected = parsed.selected;
    body.hidden = parsed.hidden;

    // colorRgbFormat=true is required for Google to honor explicit hex
    // colors; without it Google interprets backgroundColor/foregroundColor
    // as a hint to pick the matching colorId from its fixed palette and
    // ignores the literal hex.
    const useRgbFormat =
      parsed.background_color !== undefined ||
      parsed.foreground_color !== undefined;

    const opts: { body: Record<string, unknown>; colorRgbFormat?: boolean } = {
      body,
    };
    if (useRgbFormat) opts.colorRgbFormat = true;

    const raw = await ctx.client.insertCalendarListEntry(opts);
    return { calendar: mapCalendar(raw) };
  },
});
