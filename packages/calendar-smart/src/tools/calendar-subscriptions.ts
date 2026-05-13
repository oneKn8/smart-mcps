import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
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

// =============================================================================
// unsubscribe_calendar (destructive — confirm-gated, primary guard)
// =============================================================================

const PRIMARY_UNSUB_GUARD_MSG =
  "Cannot unsubscribe from the primary calendar.";

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

const unsubscribeCalendarInputSchema = z.object({
  calendar_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type UnsubscribeCalendarInput = z.input<typeof unsubscribeCalendarInputSchema>;
type UnsubscribeCalendarParsed = z.infer<
  typeof unsubscribeCalendarInputSchema
>;
type UnsubscribeCalendarOutput = { unsubscribed: true };

export const unsubscribeCalendarTool = defineTool<
  UnsubscribeCalendarInput,
  UnsubscribeCalendarOutput,
  CalendarContext
>({
  name: "unsubscribe_calendar",
  description: "Remove a calendar from your sidebar",
  // Cast required because `confirm` has `.optional().default(...)`.
  inputSchema:
    unsubscribeCalendarInputSchema as unknown as z.ZodType<UnsubscribeCalendarInput>,
  handler: async (input, ctx) => {
    const parsed = input as UnsubscribeCalendarParsed;

    // Cheap up-front guard: literal "primary" never resolves to anything else.
    if (parsed.calendar_id === "primary") {
      throw new ValidationError(PRIMARY_UNSUB_GUARD_MSG);
    }

    // Best-effort lookup so we can both block primary-by-id and build a
    // descriptive preview. Failure here skips the resolved-primary guard
    // (Google rejects on the wire if it really IS the primary).
    let entry: unknown = null;
    try {
      entry = await ctx.client.getCalendarListEntry(parsed.calendar_id);
    } catch {
      // swallow — preview falls back to id verbatim
    }

    if (entry !== null && readPrimaryFlag(entry)) {
      throw new ValidationError(PRIMARY_UNSUB_GUARD_MSG);
    }

    const summary = readSummary(entry);
    const label = summary.length > 0 ? summary : parsed.calendar_id;
    const preview =
      `Unsubscribe from '${label}' (id: ${parsed.calendar_id}). ` +
      `Calendar itself is not deleted; you can re-subscribe later.`;
    guardDestructive({ confirm: parsed.confirm, preview });

    await ctx.client.deleteCalendarListEntry({
      calendarId: parsed.calendar_id,
    });
    return { unsubscribed: true };
  },
});

// =============================================================================
// update_calendar_subscription
// =============================================================================

const reminderMethodSchema = z.enum(["email", "popup"]);
const notificationTypeSchema = z.enum([
  "eventCreation",
  "eventChange",
  "eventCancellation",
  "eventResponse",
  "agenda",
]);
const notificationMethodSchema = z.enum(["email"]);

const updateCalendarSubscriptionInputSchema = z.object({
  calendar_id: z.string().min(1),
  color_id: z.string().optional(),
  background_color: z.string().optional(),
  foreground_color: z.string().optional(),
  summary_override: z.string().optional(),
  selected: z.boolean().optional(),
  hidden: z.boolean().optional(),
  default_reminders: z
    .array(
      z.object({
        method: reminderMethodSchema,
        minutes: z.number().int().min(0),
      }),
    )
    .optional(),
  notification_settings: z
    .array(
      z.object({
        type: notificationTypeSchema,
        method: notificationMethodSchema,
      }),
    )
    .optional(),
});

type UpdateCalendarSubscriptionInput = z.infer<
  typeof updateCalendarSubscriptionInputSchema
>;
type UpdateCalendarSubscriptionOutput = { calendar: SlimCalendar };

export const updateCalendarSubscriptionTool = defineTool<
  UpdateCalendarSubscriptionInput,
  UpdateCalendarSubscriptionOutput,
  CalendarContext
>({
  name: "update_calendar_subscription",
  description: "Change calendar color, label, and notifications",
  inputSchema: updateCalendarSubscriptionInputSchema,
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {};
    if (input.color_id !== undefined) body.colorId = input.color_id;
    if (input.background_color !== undefined) {
      body.backgroundColor = input.background_color;
    }
    if (input.foreground_color !== undefined) {
      body.foregroundColor = input.foreground_color;
    }
    if (input.summary_override !== undefined) {
      body.summaryOverride = input.summary_override;
    }
    if (input.selected !== undefined) body.selected = input.selected;
    if (input.hidden !== undefined) body.hidden = input.hidden;
    if (input.default_reminders !== undefined) {
      body.defaultReminders = input.default_reminders;
    }
    if (input.notification_settings !== undefined) {
      // Google nests notifications under `notificationSettings.notifications`
      // — mapping the friendly snake_case input to the upstream shape here
      // keeps the tool surface simple.
      body.notificationSettings = {
        notifications: input.notification_settings,
      };
    }

    const useRgbFormat =
      input.background_color !== undefined ||
      input.foreground_color !== undefined;

    const opts: {
      calendarId: string;
      body: Record<string, unknown>;
      colorRgbFormat?: boolean;
    } = {
      calendarId: input.calendar_id,
      body,
    };
    if (useRgbFormat) opts.colorRgbFormat = true;

    const raw = await ctx.client.patchCalendarListEntry(opts);
    return { calendar: mapCalendar(raw) };
  },
});
