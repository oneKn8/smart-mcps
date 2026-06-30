import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { TasksContext } from "../context.js";
import { mapTask, toDueTimestamp, type SlimTask } from "../task-mapper.js";
import {
  localDateKey,
  addDaysToDateKey,
  dateKeyToUtcMidnight,
} from "../date-buckets.js";

/**
 * A task surfaced by a bucketing shortcut, tagged with the list it lives in
 * (the shortcuts scan every list by default, so the list id is load-bearing).
 */
export type BucketedTask = {
  task_list_id: string;
  task: SlimTask;
};

/**
 * Resolve the set of task-list ids to scan. When `taskListId` is given we use
 * just that one; otherwise we enumerate every list the user owns, following
 * `nextPageToken` so accounts with more lists than fit on one page are not
 * silently truncated.
 */
async function resolveListIds(
  ctx: TasksContext,
  taskListId: string | undefined,
): Promise<string[]> {
  if (taskListId !== undefined) return [taskListId];
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const result = await ctx.client.listTaskLists(
      pageToken !== undefined ? { pageToken } : {},
    );
    for (const item of result.items) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const id = (item as { id?: unknown }).id;
        if (typeof id === "string" && id.length > 0) ids.push(id);
      }
    }
    pageToken = result.nextPageToken;
  } while (pageToken !== undefined);
  return ids;
}

/** Trim hints + filters for a single-list scan, shared by both shortcuts. */
type ListScanQuery = {
  tasklist: string;
  showCompleted: boolean;
  dueMin?: string;
  dueMax?: string;
};

/**
 * Fetch EVERY task in a list. Google's tasks endpoint caps a page at 20 by
 * default, so a single call silently drops the tail of a longer list; we set a
 * larger page size and follow `nextPageToken` until it is absent. Returns the
 * raw items concatenated across pages (membership filtering happens upstream).
 */
async function listAllTasks(
  ctx: TasksContext,
  query: ListScanQuery,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const result = await ctx.client.listTasks({
      ...query,
      maxResults: 100,
      ...(pageToken !== undefined ? { pageToken } : {}),
    });
    items.push(...result.items);
    pageToken = result.nextPageToken;
  } while (pageToken !== undefined);
  return items;
}

// =============================================================================
// today_tasks
// =============================================================================

const todayTasksInputSchema = z.object({
  /** Limit to one list. Omit to scan every list. */
  task_list_id: z.string().optional(),
});

type TodayTasksInput = z.infer<typeof todayTasksInputSchema>;

type TodayTasksOutput = {
  date: string;
  tasks: BucketedTask[];
};

export const todayTasksTool = defineTool<
  TodayTasksInput,
  TodayTasksOutput,
  TasksContext
>({
  name: "today_tasks",
  description: "Incomplete tasks due today",
  inputSchema: todayTasksInputSchema,
  handler: async (input, ctx) => {
    // "Today" is the user's SYSTEM-LOCAL calendar date. Membership is decided
    // by comparing that date string against each task's date-only `due` — the
    // dueMin/dueMax below only trim the payload, they are NOT the source of
    // truth (a task in a non-UTC zone would off-by-one if we trusted them).
    const today = localDateKey();
    const tomorrow = addDaysToDateKey(today, 1);
    // Widen the lower trim by one day. `dueMin` only trims the payload; if
    // Google treats it as EXCLUSIVE, a value tangent to today's edge would drop
    // every task-due-today before the membership test runs. A looser lower edge
    // is free because the exact `task.due === today` compare below is the real
    // source of truth.
    const dueMin = dateKeyToUtcMidnight(addDaysToDateKey(today, -1));
    const dueMax = dateKeyToUtcMidnight(tomorrow);
    const listIds = await resolveListIds(ctx, input.task_list_id);

    const tasks: BucketedTask[] = [];
    for (const listId of listIds) {
      const items = await listAllTasks(ctx, {
        tasklist: listId,
        showCompleted: false,
        dueMin,
        dueMax,
      });
      for (const item of items) {
        const task = mapTask(item);
        if (
          task.due === today &&
          task.status === "needsAction" &&
          !task.deleted
        ) {
          tasks.push({ task_list_id: listId, task });
        }
      }
    }
    return { date: today, tasks };
  },
});

// =============================================================================
// overdue_tasks
// =============================================================================

const overdueTasksInputSchema = z.object({
  /** Limit to one list. Omit to scan every list. */
  task_list_id: z.string().optional(),
});

type OverdueTasksInput = z.infer<typeof overdueTasksInputSchema>;

type OverdueTasksOutput = {
  date: string;
  tasks: BucketedTask[];
};

export const overdueTasksTool = defineTool<
  OverdueTasksInput,
  OverdueTasksOutput,
  TasksContext
>({
  name: "overdue_tasks",
  description: "Incomplete tasks past their due date",
  inputSchema: overdueTasksInputSchema,
  handler: async (input, ctx) => {
    // Overdue = due date strictly before today AND not completed. `dueMax`
    // trims to past-due payload; `showCompleted: false` keeps already-done
    // tasks out. The authoritative test is the date-string comparison below.
    const today = localDateKey();
    const listIds = await resolveListIds(ctx, input.task_list_id);

    const tasks: BucketedTask[] = [];
    for (const listId of listIds) {
      const items = await listAllTasks(ctx, {
        tasklist: listId,
        showCompleted: false,
        dueMax: dateKeyToUtcMidnight(today),
      });
      for (const item of items) {
        const task = mapTask(item);
        if (
          task.due !== null &&
          task.due < today &&
          task.status === "needsAction" &&
          !task.deleted
        ) {
          tasks.push({ task_list_id: listId, task });
        }
      }
    }
    return { date: today, tasks };
  },
});

// =============================================================================
// quick_add
// =============================================================================

const quickAddInputSchema = z.object({
  task_list_id: z.string().min(1),
  /** Free text title. A trailing ` due:YYYY-MM-DD` sets the due date. */
  text: z.string().min(1),
});

type QuickAddInput = z.infer<typeof quickAddInputSchema>;

type QuickAddOutput = { task: SlimTask };

const DUE_SUFFIX_RE = /\s+due:(\d{4}-\d{2}-\d{2})\s*$/;

export const quickAddTool = defineTool<
  QuickAddInput,
  QuickAddOutput,
  TasksContext
>({
  name: "quick_add",
  description: "Quickly add a task from text",
  inputSchema: quickAddInputSchema,
  handler: async (input, ctx) => {
    // Google Tasks has no natural-language quickAdd endpoint (unlike
    // Calendar), so this is a local convenience: the text becomes the title,
    // and an optional trailing ` due:YYYY-MM-DD` token is lifted into the due
    // date and stripped from the title.
    let title = input.text;
    let due: string | undefined;
    const m = DUE_SUFFIX_RE.exec(input.text);
    if (m) {
      due = m[1];
      title = input.text.slice(0, m.index).trim();
    } else {
      title = input.text.trim();
    }
    if (title.length === 0) {
      throw new ValidationError(
        "quick_add: text has no title after parsing the due date.",
      );
    }
    const body: Record<string, unknown> = { title };
    if (due !== undefined) body.due = toDueTimestamp(due);
    const raw = await ctx.client.insertTask({
      tasklist: input.task_list_id,
      body,
    });
    return { task: mapTask(raw) };
  },
});
