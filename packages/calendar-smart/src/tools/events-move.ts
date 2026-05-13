import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, type SlimEvent } from "../event-mapper.js";

// =============================================================================
// move_event
// =============================================================================

const sendUpdatesSchema = z.enum(["all", "externalOnly", "none"]);

const moveEventInputSchema = z.object({
  event_id: z.string().min(1),
  source_calendar_id: z.string().optional().default("primary"),
  destination_calendar_id: z.string().min(1),
  send_updates: sendUpdatesSchema.optional().default("none"),
});

type MoveEventInput = z.input<typeof moveEventInputSchema>;
type MoveEventParsed = z.infer<typeof moveEventInputSchema>;
type MoveEventOutput = { event: SlimEvent };

export const moveEventTool = defineTool<
  MoveEventInput,
  MoveEventOutput,
  CalendarContext
>({
  name: "move_event",
  description: "Move event to another calendar",
  // Cast required because `source_calendar_id` and `send_updates` have
  // `.optional().default(...)`.
  inputSchema: moveEventInputSchema as unknown as z.ZodType<MoveEventInput>,
  handler: async (input, ctx) => {
    const parsed = input as MoveEventParsed;
    const raw = await ctx.client.moveEvent({
      calendarId: parsed.source_calendar_id,
      eventId: parsed.event_id,
      destination: parsed.destination_calendar_id,
      sendUpdates: parsed.send_updates,
    });
    // The event id is preserved across the move; map under the new
    // destination so SlimEvent.calendar_id reflects where the event lives now.
    return { event: mapEvent(raw, parsed.destination_calendar_id) };
  },
});
