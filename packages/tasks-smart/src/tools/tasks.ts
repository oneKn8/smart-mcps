import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { TasksContext } from "../context.js";
import { mapTask, toDueTimestamp, type SlimTask } from "../task-mapper.js";

// =============================================================================
// list_tasks
// =============================================================================

const listTasksInputSchema = z.object({
  task_list_id: z.string().min(1),
  show_completed: z.boolean().optional().default(true),
  show_hidden: z.boolean().optional().default(false),
  show_deleted: z.boolean().optional().default(false),
  show_assigned: z.boolean().optional().default(false),
  due_min: z.string().optional(),
  due_max: z.string().optional(),
  max_results: z.number().int().min(1).max(100).optional(),
  page_token: z.string().optional(),
});

type ListTasksInput = z.input<typeof listTasksInputSchema>;
type ListTasksParsed = z.infer<typeof listTasksInputSchema>;

type ListTasksOutput = {
  tasks: SlimTask[];
  next_page_token?: string;
};

export const listTasksTool = defineTool<
  ListTasksInput,
  ListTasksOutput,
  TasksContext
>({
  name: "list_tasks",
  description: "List tasks in a task list",
  // Cast required: show_* fields have `.optional().default(...)`.
  inputSchema: listTasksInputSchema as unknown as z.ZodType<ListTasksInput>,
  handler: async (input, ctx) => {
    const parsed = input as ListTasksParsed;
    const result = await ctx.client.listTasks({
      tasklist: parsed.task_list_id,
      showCompleted: parsed.show_completed,
      showHidden: parsed.show_hidden,
      showDeleted: parsed.show_deleted,
      showAssigned: parsed.show_assigned,
      ...(parsed.due_min !== undefined ? { dueMin: parsed.due_min } : {}),
      ...(parsed.due_max !== undefined ? { dueMax: parsed.due_max } : {}),
      ...(parsed.max_results !== undefined
        ? { maxResults: parsed.max_results }
        : {}),
      ...(parsed.page_token !== undefined
        ? { pageToken: parsed.page_token }
        : {}),
    });
    return {
      tasks: result.items.map((item) => mapTask(item)),
      ...(result.nextPageToken !== undefined
        ? { next_page_token: result.nextPageToken }
        : {}),
    };
  },
});

// =============================================================================
// get_task
// =============================================================================

const getTaskInputSchema = z.object({
  task_list_id: z.string().min(1),
  task_id: z.string().min(1),
});

type GetTaskInput = z.infer<typeof getTaskInputSchema>;

type GetTaskOutput = { task: SlimTask };

export const getTaskTool = defineTool<GetTaskInput, GetTaskOutput, TasksContext>(
  {
    name: "get_task",
    description: "Get one task's details",
    inputSchema: getTaskInputSchema,
    handler: async (input, ctx) => {
      const raw = await ctx.client.getTask({
        tasklist: input.task_list_id,
        task: input.task_id,
      });
      return { task: mapTask(raw) };
    },
  },
);

// =============================================================================
// create_task
// =============================================================================

const createTaskInputSchema = z.object({
  task_list_id: z.string().min(1),
  title: z.string().min(1),
  notes: z.string().optional(),
  /** Date-only `YYYY-MM-DD`. The API stores UTC midnight; time is discarded. */
  due: z.string().optional(),
  /** Nest under this parent task id. */
  parent: z.string().optional(),
  /** Order after this sibling task id (omit = first position). */
  previous: z.string().optional(),
});

type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

type CreateTaskOutput = { task: SlimTask };

export const createTaskTool = defineTool<
  CreateTaskInput,
  CreateTaskOutput,
  TasksContext
>({
  name: "create_task",
  description: "Create a task in a list",
  inputSchema: createTaskInputSchema,
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = { title: input.title };
    if (input.notes !== undefined) body.notes = input.notes;
    if (input.due !== undefined) body.due = toDueTimestamp(input.due);
    const raw = await ctx.client.insertTask({
      tasklist: input.task_list_id,
      body,
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
      ...(input.previous !== undefined ? { previous: input.previous } : {}),
    });
    return { task: mapTask(raw) };
  },
});

// =============================================================================
// update_task
// =============================================================================

const updateTaskInputSchema = z.object({
  task_list_id: z.string().min(1),
  task_id: z.string().min(1),
  title: z.string().optional(),
  notes: z.string().optional(),
  /** Date-only `YYYY-MM-DD`. The API stores UTC midnight; time is discarded. */
  due: z.string().optional(),
  status: z.enum(["needsAction", "completed"]).optional(),
});

type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

type UpdateTaskOutput = { task: SlimTask };

export const updateTaskTool = defineTool<
  UpdateTaskInput,
  UpdateTaskOutput,
  TasksContext
>({
  name: "update_task",
  description: "Update a task's fields",
  inputSchema: updateTaskInputSchema,
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.notes !== undefined) body.notes = input.notes;
    if (input.due !== undefined) body.due = toDueTimestamp(input.due);
    if (input.status !== undefined) body.status = input.status;
    const raw = await ctx.client.patchTask({
      tasklist: input.task_list_id,
      task: input.task_id,
      body,
    });
    return { task: mapTask(raw) };
  },
});

// =============================================================================
// complete_task
// =============================================================================

const completeTaskInputSchema = z.object({
  task_list_id: z.string().min(1),
  task_id: z.string().min(1),
  /** Set false to re-open a completed task. */
  completed: z.boolean().optional().default(true),
});

type CompleteTaskInput = z.input<typeof completeTaskInputSchema>;
type CompleteTaskParsed = z.infer<typeof completeTaskInputSchema>;

type CompleteTaskOutput = { task: SlimTask };

export const completeTaskTool = defineTool<
  CompleteTaskInput,
  CompleteTaskOutput,
  TasksContext
>({
  name: "complete_task",
  description: "Mark a task complete or reopen it",
  // Cast required because `completed` has `.optional().default(...)`.
  inputSchema:
    completeTaskInputSchema as unknown as z.ZodType<CompleteTaskInput>,
  handler: async (input, ctx) => {
    const parsed = input as CompleteTaskParsed;
    // Reopening: clear the server-set completion timestamp alongside the
    // status so the task is fully reset to actionable.
    const body: Record<string, unknown> = parsed.completed
      ? { status: "completed" }
      : { status: "needsAction", completed: null };
    const raw = await ctx.client.patchTask({
      tasklist: parsed.task_list_id,
      task: parsed.task_id,
      body,
    });
    return { task: mapTask(raw) };
  },
});

// =============================================================================
// delete_task (destructive — confirm-gated)
// =============================================================================

const deleteTaskInputSchema = z.object({
  task_list_id: z.string().min(1),
  task_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteTaskInput = z.input<typeof deleteTaskInputSchema>;
type DeleteTaskParsed = z.infer<typeof deleteTaskInputSchema>;
type DeleteTaskOutput = { deleted: true };

function readTaskTitle(entry: unknown): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const t = (entry as { title?: unknown }).title;
    if (typeof t === "string") return t;
  }
  return "";
}

export const deleteTaskTool = defineTool<
  DeleteTaskInput,
  DeleteTaskOutput,
  TasksContext
>({
  name: "delete_task",
  description: "Delete a task permanently",
  // Cast required because `confirm` has `.optional().default(...)`.
  inputSchema: deleteTaskInputSchema as unknown as z.ZodType<DeleteTaskInput>,
  handler: async (input, ctx) => {
    const parsed = input as DeleteTaskParsed;

    // Best-effort lookup so the preview can name the task.
    let entry: unknown = null;
    try {
      entry = await ctx.client.getTask({
        tasklist: parsed.task_list_id,
        task: parsed.task_id,
      });
    } catch {
      // swallow — preview falls back to id verbatim
    }
    const title = readTaskTitle(entry);
    const label = title.length > 0 ? title : parsed.task_id;
    const preview = `Delete task '${label}' permanently (id: ${parsed.task_id})`;
    guardDestructive({ confirm: parsed.confirm, preview });

    await ctx.client.deleteTask({
      tasklist: parsed.task_list_id,
      task: parsed.task_id,
    });
    return { deleted: true };
  },
});
