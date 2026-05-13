import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapCalendar, type SlimCalendar } from "../calendar-mapper.js";

// =============================================================================
// create_calendar
// =============================================================================

const createCalendarInputSchema = z.object({
  summary: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  time_zone: z.string().optional(),
});

type CreateCalendarInput = z.infer<typeof createCalendarInputSchema>;
type CreateCalendarOutput = { calendar: SlimCalendar };

/**
 * Best-effort re-fetch of a freshly-mutated calendar via the CalendarList
 * endpoint so the slim shape carries `accessRole`/`primary`/`selected` from
 * the per-user view rather than the stripped Calendars-resource shape. If
 * the re-fetch fails (transient, race against quotas, etc.) we fall back to
 * the mutation response so the caller still sees the new id and metadata.
 */
async function refetchAsListEntryOrFallback(
  ctx: CalendarContext,
  fallbackRaw: unknown,
  calendarId: string,
): Promise<SlimCalendar> {
  try {
    const entry = await ctx.client.getCalendarListEntry(calendarId);
    return mapCalendar(entry);
  } catch {
    return mapCalendar(fallbackRaw);
  }
}

function readId(raw: unknown, fallback: string): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id === "string" && obj.id.length > 0) return obj.id;
  }
  return fallback;
}

export const createCalendarTool = defineTool<
  CreateCalendarInput,
  CreateCalendarOutput,
  CalendarContext
>({
  name: "create_calendar",
  description: "Create a new secondary calendar",
  inputSchema: createCalendarInputSchema,
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = { summary: input.summary };
    if (input.description !== undefined) body.description = input.description;
    if (input.location !== undefined) body.location = input.location;
    if (input.time_zone !== undefined) body.timeZone = input.time_zone;

    const raw = await ctx.client.insertCalendar(body);
    const newId = readId(raw, "");
    return {
      calendar: await refetchAsListEntryOrFallback(ctx, raw, newId),
    };
  },
});

// =============================================================================
// update_calendar
// =============================================================================

const updateCalendarInputSchema = z.object({
  calendar_id: z.string().min(1),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  time_zone: z.string().optional(),
});

type UpdateCalendarInput = z.infer<typeof updateCalendarInputSchema>;
type UpdateCalendarOutput = { calendar: SlimCalendar };

export const updateCalendarTool = defineTool<
  UpdateCalendarInput,
  UpdateCalendarOutput,
  CalendarContext
>({
  name: "update_calendar",
  description: "Update calendar metadata",
  inputSchema: updateCalendarInputSchema,
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {};
    if (input.summary !== undefined) body.summary = input.summary;
    if (input.description !== undefined) body.description = input.description;
    if (input.location !== undefined) body.location = input.location;
    if (input.time_zone !== undefined) body.timeZone = input.time_zone;

    const raw = await ctx.client.patchCalendar({
      calendarId: input.calendar_id,
      body,
    });
    return {
      calendar: await refetchAsListEntryOrFallback(
        ctx,
        raw,
        input.calendar_id,
      ),
    };
  },
});

// =============================================================================
// delete_calendar (destructive — confirm-gated, primary guard)
// =============================================================================

const deleteCalendarInputSchema = z.object({
  calendar_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteCalendarInput = z.input<typeof deleteCalendarInputSchema>;
type DeleteCalendarParsed = z.infer<typeof deleteCalendarInputSchema>;
type DeleteCalendarOutput = { deleted: true };

const PRIMARY_GUARD_MSG =
  "Cannot delete the primary calendar. Use clear_primary_calendar to wipe its events instead.";

function readPrimaryFlag(entry: unknown): boolean {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return (entry as { primary?: unknown }).primary === true;
  }
  return false;
}

function readSummary(entry: unknown): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const s = (entry as { summary?: unknown }).summary;
    if (typeof s === "string") return s;
  }
  return "";
}

export const deleteCalendarTool = defineTool<
  DeleteCalendarInput,
  DeleteCalendarOutput,
  CalendarContext
>({
  name: "delete_calendar",
  description: "Delete a secondary calendar permanently",
  // Cast required because `confirm` has `.optional().default(...)`.
  inputSchema:
    deleteCalendarInputSchema as unknown as z.ZodType<DeleteCalendarInput>,
  handler: async (input, ctx) => {
    const parsed = input as DeleteCalendarParsed;

    // Cheap up-front guard: literal "primary" never resolves to anything else.
    if (parsed.calendar_id === "primary") {
      throw new ValidationError(PRIMARY_GUARD_MSG);
    }

    // Best-effort lookup so we can both resolve "is this the primary calendar
    // by id?" and build a descriptive preview. Failure here is non-fatal —
    // we fall back to the raw id and skip the resolved-primary guard. If the
    // calendar IS the primary and CalendarList lookup happens to fail,
    // Google's API will refuse the delete with 403 anyway.
    let entry: unknown = null;
    try {
      entry = await ctx.client.getCalendarListEntry(parsed.calendar_id);
    } catch {
      // swallow — preview falls back to id verbatim
    }

    if (entry !== null && readPrimaryFlag(entry)) {
      throw new ValidationError(PRIMARY_GUARD_MSG);
    }

    const summary = readSummary(entry);
    const label = summary.length > 0 ? summary : parsed.calendar_id;
    const preview =
      `Delete calendar '${label}' permanently (id: ${parsed.calendar_id})`;
    guardDestructive({ confirm: parsed.confirm, preview });

    await ctx.client.deleteCalendar({ calendarId: parsed.calendar_id });
    return { deleted: true };
  },
});

// =============================================================================
// clear_primary_calendar (destructive, NUKE option)
// =============================================================================

const clearPrimaryCalendarInputSchema = z.object({
  confirm: z.boolean().optional().default(false),
});

type ClearPrimaryCalendarInput = z.input<
  typeof clearPrimaryCalendarInputSchema
>;
type ClearPrimaryCalendarParsed = z.infer<
  typeof clearPrimaryCalendarInputSchema
>;
type ClearPrimaryCalendarOutput = { cleared: true };

export const clearPrimaryCalendarTool = defineTool<
  ClearPrimaryCalendarInput,
  ClearPrimaryCalendarOutput,
  CalendarContext
>({
  name: "clear_primary_calendar",
  description: "Wipe ALL events from primary calendar",
  // Cast required because `confirm` has `.optional().default(...)`.
  inputSchema:
    clearPrimaryCalendarInputSchema as unknown as z.ZodType<ClearPrimaryCalendarInput>,
  handler: async (input, ctx) => {
    const parsed = input as ClearPrimaryCalendarParsed;
    const preview =
      "Clear ALL events from your primary calendar (irreversible). " +
      "Calendar metadata is preserved.";
    guardDestructive({ confirm: parsed.confirm, preview });
    await ctx.client.clearPrimaryCalendar();
    return { cleared: true };
  },
});
