import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import { renderMarkdownToNewDoc } from "docs-smart/render";
import type { FlowContext } from "../context.js";
import { FlowProgress } from "../flow-error.js";
import { clamp, eventTimeLabel, mdInline, readEvent, readTask } from "../extract.js";
import { listAllTasks, resolveTaskListIds } from "../gather.js";
import { addDays, dateKeyInTz, tzMidnightIso } from "../time.js";

// =============================================================================
// daily_brief_doc — today's agenda + due/overdue tasks -> a one-page Doc
// =============================================================================
//
// Glue: CalendarClient (today's events), TasksClient (due-today + overdue), then
// `renderMarkdownToNewDoc`. Task `due` is date-only, so bucketing is a pure
// lexicographic compare of `YYYY-MM-DD` keys (no zone math needed for tasks).

const dailyBriefDocInputSchema = z.object({
  /** The day to brief, `YYYY-MM-DD`. Defaults to today in the calendar zone. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  /** Limit tasks to one list. Omit to scan every list. */
  tasklist: z.string().min(1).optional(),
  calendar_id: z.string().min(1).optional().default("primary"),
  title: z.string().min(1).optional(),
});

type DailyBriefDocInput = z.input<typeof dailyBriefDocInputSchema>;
type DailyBriefDocParsed = z.infer<typeof dailyBriefDocInputSchema>;

type DailyBriefDocOutput = {
  document_id: string;
  url: string;
  title: string;
  date: string;
  event_count: number;
  due_today_count: number;
  overdue_count: number;
};

const EVENT_PAGE_SIZE = 250;

export const dailyBriefDocTool = defineTool<
  DailyBriefDocInput,
  DailyBriefDocOutput,
  FlowContext
>({
  name: "daily_brief_doc",
  description: "Today's agenda and tasks one-page doc",
  // Cast required: the schema has an `.optional().default(...)` field.
  inputSchema:
    dailyBriefDocInputSchema as unknown as z.ZodType<DailyBriefDocInput>,
  handler: async (input, ctx) => {
    const parsed = input as DailyBriefDocParsed;
    const progress = new FlowProgress();

    const tz = await progress.run("resolve_timezone", () =>
      ctx.calendar.ensureTimeZone(),
    );
    const date = parsed.date ?? dateKeyInTz(tz);
    const nextDay = addDays(date, 1);

    // Step: today's agenda.
    const events = await progress.run("gather_events", async () => {
      const { items } = await ctx.calendar.listEvents({
        calendarId: parsed.calendar_id,
        timeMin: tzMidnightIso(date, tz),
        timeMax: tzMidnightIso(nextDay, tz),
        maxResults: EVENT_PAGE_SIZE,
      });
      return items.map((e) => readEvent(e));
    });
    progress.note(`gathered ${events.length} events`);

    // Step: due-today + overdue tasks (date-only lexicographic bucketing).
    const taskData = await progress.run("gather_tasks", async () => {
      const listIds = await resolveTaskListIds(ctx.tasks, parsed.tasklist);
      const dueToday: string[] = [];
      const overdue: { title: string; due: string }[] = [];
      for (const listId of listIds) {
        const items = await listAllTasks(ctx.tasks, {
          tasklist: listId,
          showCompleted: false,
          dueMax: `${nextDay}T00:00:00.000Z`,
        });
        for (const item of items) {
          const t = readTask(item);
          if (t.deleted || t.status !== "needsAction" || t.due === null) continue;
          if (t.due === date) dueToday.push(t.title);
          else if (t.due < date) overdue.push({ title: t.title, due: t.due });
        }
      }
      return { dueToday, overdue };
    });
    progress.note(
      `gathered ${taskData.dueToday.length} due + ${taskData.overdue.length} overdue tasks`,
    );

    // Build the Markdown string.
    const docTitle = parsed.title ?? `Daily Brief — ${date}`;
    const lines: string[] = [];
    lines.push(`# ${mdInline(docTitle)}`, "");
    lines.push(`Agenda and tasks for **${date}** (${tz}).`, "");

    lines.push(`## Agenda (${events.length})`, "");
    if (events.length === 0) {
      lines.push("No events scheduled.", "");
    } else {
      for (const e of events) {
        const at = eventTimeLabel(e);
        const prefix = at.length > 0 ? `**${at}** ` : "";
        lines.push(`- ${prefix}${mdInline(clamp(e.summary, 120))}`);
      }
      lines.push("");
    }

    lines.push(`## Due Today (${taskData.dueToday.length})`, "");
    if (taskData.dueToday.length === 0) {
      lines.push("Nothing due today.", "");
    } else {
      for (const t of taskData.dueToday) {
        lines.push(`- ${mdInline(t || "(untitled)")}`);
      }
      lines.push("");
    }

    lines.push(`## Overdue (${taskData.overdue.length})`, "");
    if (taskData.overdue.length === 0) {
      lines.push("Nothing overdue.", "");
    } else {
      for (const t of taskData.overdue) {
        lines.push(`- ${mdInline(t.title || "(untitled)")} (due ${t.due})`);
      }
      lines.push("");
    }

    const rendered = await progress.run("render_doc", () =>
      renderMarkdownToNewDoc(ctx.docs, {
        title: docTitle,
        markdown: lines.join("\n"),
      }),
    );

    return {
      document_id: rendered.document_id,
      url: rendered.url,
      title: rendered.title,
      date,
      event_count: events.length,
      due_today_count: taskData.dueToday.length,
      overdue_count: taskData.overdue.length,
    };
  },
});
