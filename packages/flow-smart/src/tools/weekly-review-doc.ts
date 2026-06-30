import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import { renderMarkdownToNewDoc } from "docs-smart/render";
import type { FlowContext } from "../context.js";
import { FlowProgress } from "../flow-error.js";
import { clamp, eventTimeLabel, mdInline, readEvent, readTask } from "../extract.js";
import { listAllTasks, resolveTaskListIds } from "../gather.js";
import { dateKeyInTz, mondayWeek, tzMidnightIso } from "../time.js";

// =============================================================================
// weekly_review_doc — this week's tasks + calendar -> a rendered Google Doc
// =============================================================================
//
// FLAGSHIP. Glue: TasksClient (open + recently-completed tasks across the
// week), CalendarClient (this week's events), then `renderMarkdownToNewDoc`
// (the docs-smart renderer, reused verbatim) to lay it out. Builds a Markdown
// STRING from the gathered data — it does NOT touch the Docs batchUpdate model
// directly.

const weeklyReviewDocInputSchema = z.object({
  /** Any day inside the target Mon-Sun week, `YYYY-MM-DD`. Defaults to today. */
  week_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "week_of must be YYYY-MM-DD")
    .optional(),
  /** Limit tasks to one list. Omit to scan every list. */
  tasklist: z.string().min(1).optional(),
  calendar_id: z.string().min(1).optional().default("primary"),
  title: z.string().min(1).optional(),
});

type WeeklyReviewDocInput = z.input<typeof weeklyReviewDocInputSchema>;
type WeeklyReviewDocParsed = z.infer<typeof weeklyReviewDocInputSchema>;

type WeeklyReviewDocOutput = {
  document_id: string;
  url: string;
  title: string;
  week_start: string;
  week_end: string;
  open_task_count: number;
  completed_task_count: number;
  event_count: number;
};

const EVENT_PAGE_SIZE = 250;

export const weeklyReviewDocTool = defineTool<
  WeeklyReviewDocInput,
  WeeklyReviewDocOutput,
  FlowContext
>({
  name: "weekly_review_doc",
  description: "Weekly tasks and calendar review doc",
  // Cast required: the schema has an `.optional().default(...)` field.
  inputSchema:
    weeklyReviewDocInputSchema as unknown as z.ZodType<WeeklyReviewDocInput>,
  handler: async (input, ctx) => {
    const parsed = input as WeeklyReviewDocParsed;
    const progress = new FlowProgress();

    const tz = await progress.run("resolve_timezone", () =>
      ctx.calendar.ensureTimeZone(),
    );
    const weekOf = parsed.week_of ?? dateKeyInTz(tz);
    const week = mondayWeek(weekOf);
    // Half-open completion window [weekStart, weekEndExclusive) in real time.
    // The upper bound matters when reviewing a PAST week: without it, anything
    // completed at/after that week's start (including later weeks) over-counts.
    const weekStartInstant = new Date(tzMidnightIso(week.start, tz)).getTime();
    const weekEndInstant = new Date(
      tzMidnightIso(week.endExclusive, tz),
    ).getTime();

    // Step: gather tasks (open + completed-this-week) across the chosen lists.
    const taskData = await progress.run("gather_tasks", async () => {
      const listIds = await resolveTaskListIds(ctx.tasks, parsed.tasklist);
      const open: { list: string; title: string; due: string | null }[] = [];
      const completed: { list: string; title: string; on: string | null }[] = [];
      for (const listId of listIds) {
        const items = await listAllTasks(ctx.tasks, {
          tasklist: listId,
          showCompleted: true,
          showHidden: true,
        });
        for (const item of items) {
          const t = readTask(item);
          if (t.deleted) continue;
          if (t.status === "needsAction") {
            open.push({ list: listId, title: t.title, due: t.due });
          } else if (t.completed !== null) {
            const at = new Date(t.completed).getTime();
            if (at >= weekStartInstant && at < weekEndInstant) {
              completed.push({ list: listId, title: t.title, on: t.completed });
            }
          }
        }
      }
      return { open, completed };
    });
    progress.note(
      `gathered ${taskData.open.length} open + ${taskData.completed.length} completed tasks`,
    );

    // Step: gather this week's calendar events.
    const events = await progress.run("gather_events", async () => {
      const { items } = await ctx.calendar.listEvents({
        calendarId: parsed.calendar_id,
        timeMin: tzMidnightIso(week.start, tz),
        timeMax: tzMidnightIso(week.endExclusive, tz),
        maxResults: EVENT_PAGE_SIZE,
      });
      return items.map((e) => readEvent(e));
    });
    progress.note(`gathered ${events.length} events`);

    // Build the Markdown string.
    const docTitle = parsed.title ?? `Weekly Review — ${week.start} to ${week.endInclusive}`;
    const lines: string[] = [];
    lines.push(`# ${mdInline(docTitle)}`, "");
    lines.push(`Week of **${week.start}** to **${week.endInclusive}** (${tz}).`, "");

    lines.push(`## Open Tasks (${taskData.open.length})`, "");
    if (taskData.open.length === 0) {
      lines.push("No open tasks.", "");
    } else {
      for (const t of taskData.open) {
        const due = t.due ? ` (due ${t.due})` : "";
        lines.push(`- ${mdInline(t.title || "(untitled)")}${due}`);
      }
      lines.push("");
    }

    lines.push(`## Completed This Week (${taskData.completed.length})`, "");
    if (taskData.completed.length === 0) {
      lines.push("Nothing completed yet this week.", "");
    } else {
      for (const t of taskData.completed) {
        const on = t.on ? ` (${t.on.slice(0, 10)})` : "";
        lines.push(`- ${mdInline(t.title || "(untitled)")}${on}`);
      }
      lines.push("");
    }

    lines.push(`## Calendar (${events.length} events)`, "");
    if (events.length === 0) {
      lines.push("No events this week.", "");
    } else {
      for (const e of events) {
        const day = (e.start ?? "").slice(0, 10);
        const at = eventTimeLabel(e);
        const when = [day, at].filter((s) => s.length > 0).join(" ");
        lines.push(`- **${when}** — ${mdInline(clamp(e.summary, 120))}`);
      }
      lines.push("");
    }

    // Step: render the doc through the shared docs renderer.
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
      week_start: week.start,
      week_end: week.endInclusive,
      open_task_count: taskData.open.length,
      completed_task_count: taskData.completed.length,
      event_count: events.length,
    };
  },
});
