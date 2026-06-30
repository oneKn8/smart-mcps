import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { FlowContext } from "../context.js";
import { FlowProgress } from "../flow-error.js";
import { clamp, readEvent, readTask } from "../extract.js";
import { addMinutesIso, parseClock, tzWallClockIso } from "../time.js";

// =============================================================================
// task_to_calendar_block — reserve a timed calendar event for a task
// =============================================================================
//
// Glue: TasksClient.getTask to read the task, CalendarClient.ensureTimeZone +
// insertEvent to drop a timed block on the chosen day. Start defaults to 09:00
// local; duration defaults to 60 minutes.

const taskToCalendarBlockInputSchema = z.object({
  task_id: z.string().min(1),
  /** The day to block, `YYYY-MM-DD`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  /** Task list the task lives in. `@default` is the user's primary list. */
  tasklist: z.string().min(1).optional().default("@default"),
  /** Block start wall-clock `HH:MM` (24h) in the calendar's zone. */
  start_time: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/, "start_time must be HH:MM")
    .optional()
    .default("09:00"),
  duration_minutes: z.number().int().min(5).max(1440).optional().default(60),
  calendar_id: z.string().min(1).optional().default("primary"),
});

type TaskToCalendarBlockInput = z.input<typeof taskToCalendarBlockInputSchema>;
type TaskToCalendarBlockParsed = z.infer<typeof taskToCalendarBlockInputSchema>;

type TaskToCalendarBlockOutput = {
  event_id: string;
  calendar_id: string;
  task_id: string;
  title: string;
  start: string;
  end: string;
  html_link: string | null;
};

export const taskToCalendarBlockTool = defineTool<
  TaskToCalendarBlockInput,
  TaskToCalendarBlockOutput,
  FlowContext
>({
  name: "task_to_calendar_block",
  description: "Block calendar time for a task",
  // Cast required: the schema has `.optional().default(...)` fields.
  inputSchema:
    taskToCalendarBlockInputSchema as unknown as z.ZodType<TaskToCalendarBlockInput>,
  handler: async (input, ctx) => {
    const parsed = input as TaskToCalendarBlockParsed;
    const progress = new FlowProgress();

    // Step 1: read the task (title + notes feed the event).
    const task = await progress.run("read_task", async () => {
      const raw = await ctx.tasks.getTask({
        tasklist: parsed.tasklist,
        task: parsed.task_id,
      });
      return readTask(raw);
    });
    const title = task.title.length > 0 ? task.title : "Task";
    progress.note(`read task "${clamp(title, 80)}"`);

    // Step 2: resolve the zone and create the timed block.
    const result = await progress.run("create_block", async () => {
      const tz = await ctx.calendar.ensureTimeZone();
      const { hour, minute } = parseClock(parsed.start_time);
      const startIso = tzWallClockIso(parsed.date, hour, minute, tz);
      const endIso = addMinutesIso(startIso, parsed.duration_minutes, tz);
      const description =
        task.notes && task.notes.length > 0
          ? `${task.notes}\n\n(from Google Task ${task.id})`
          : `(from Google Task ${task.id})`;
      const raw = await ctx.calendar.insertEvent({
        calendarId: parsed.calendar_id,
        body: {
          summary: `Task: ${title}`,
          description,
          start: { dateTime: startIso, timeZone: tz },
          end: { dateTime: endIso, timeZone: tz },
        },
      });
      return { event: readEvent(raw), startIso, endIso };
    });

    if (result.event.id.length === 0) {
      throw new ValidationError(
        "create_block: Calendar API returned an event with no id.",
      );
    }

    return {
      event_id: result.event.id,
      calendar_id: parsed.calendar_id,
      task_id: parsed.task_id,
      title,
      start: result.event.start ?? result.startIso,
      end: result.event.end ?? result.endIso,
      html_link: result.event.htmlLink,
    };
  },
});
