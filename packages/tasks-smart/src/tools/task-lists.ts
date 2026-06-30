import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { TasksContext } from "../context.js";
import { mapTaskList, type SlimTaskList } from "../tasklist-mapper.js";

// =============================================================================
// list_task_lists
// =============================================================================

const listTaskListsInputSchema = z.object({});

type ListTaskListsInput = z.infer<typeof listTaskListsInputSchema>;

type ListTaskListsOutput = {
  task_lists: SlimTaskList[];
};

export const listTaskListsTool = defineTool<
  ListTaskListsInput,
  ListTaskListsOutput,
  TasksContext
>({
  name: "list_task_lists",
  description: "List all your task lists",
  inputSchema: listTaskListsInputSchema,
  handler: async (_input, ctx) => {
    const { items } = await ctx.client.listTaskLists();
    return { task_lists: items.map((item) => mapTaskList(item)) };
  },
});

// =============================================================================
// get_task_list
// =============================================================================

const getTaskListInputSchema = z.object({
  task_list_id: z.string().min(1),
});

type GetTaskListInput = z.infer<typeof getTaskListInputSchema>;

type GetTaskListOutput = {
  task_list: SlimTaskList;
};

export const getTaskListTool = defineTool<
  GetTaskListInput,
  GetTaskListOutput,
  TasksContext
>({
  name: "get_task_list",
  description: "Get one task list's details",
  inputSchema: getTaskListInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.getTaskList(input.task_list_id);
    return { task_list: mapTaskList(raw) };
  },
});

// =============================================================================
// create_task_list
// =============================================================================

const createTaskListInputSchema = z.object({
  title: z.string().min(1),
});

type CreateTaskListInput = z.infer<typeof createTaskListInputSchema>;

type CreateTaskListOutput = {
  task_list: SlimTaskList;
};

export const createTaskListTool = defineTool<
  CreateTaskListInput,
  CreateTaskListOutput,
  TasksContext
>({
  name: "create_task_list",
  description: "Create a new task list",
  inputSchema: createTaskListInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.insertTaskList({ title: input.title });
    return { task_list: mapTaskList(raw) };
  },
});

// =============================================================================
// update_task_list
// =============================================================================

const updateTaskListInputSchema = z.object({
  task_list_id: z.string().min(1),
  title: z.string().min(1),
});

type UpdateTaskListInput = z.infer<typeof updateTaskListInputSchema>;

type UpdateTaskListOutput = {
  task_list: SlimTaskList;
};

export const updateTaskListTool = defineTool<
  UpdateTaskListInput,
  UpdateTaskListOutput,
  TasksContext
>({
  name: "update_task_list",
  description: "Rename a task list",
  inputSchema: updateTaskListInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.patchTaskList({
      tasklist: input.task_list_id,
      body: { title: input.title },
    });
    return { task_list: mapTaskList(raw) };
  },
});

// =============================================================================
// delete_task_list (destructive — confirm-gated)
// =============================================================================

const deleteTaskListInputSchema = z.object({
  task_list_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteTaskListInput = z.input<typeof deleteTaskListInputSchema>;
type DeleteTaskListParsed = z.infer<typeof deleteTaskListInputSchema>;
type DeleteTaskListOutput = { deleted: true };

function readTitle(entry: unknown): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const t = (entry as { title?: unknown }).title;
    if (typeof t === "string") return t;
  }
  return "";
}

export const deleteTaskListTool = defineTool<
  DeleteTaskListInput,
  DeleteTaskListOutput,
  TasksContext
>({
  name: "delete_task_list",
  description: "Delete a task list and its tasks",
  // Cast required because `confirm` has `.optional().default(...)`.
  inputSchema:
    deleteTaskListInputSchema as unknown as z.ZodType<DeleteTaskListInput>,
  handler: async (input, ctx) => {
    const parsed = input as DeleteTaskListParsed;

    // Best-effort lookup so the preview can name the list. A failed lookup is
    // non-fatal — the preview falls back to the raw id.
    let entry: unknown = null;
    try {
      entry = await ctx.client.getTaskList(parsed.task_list_id);
    } catch {
      // swallow — preview falls back to id verbatim
    }
    const title = readTitle(entry);
    const label = title.length > 0 ? title : parsed.task_list_id;
    const preview =
      `Delete task list '${label}' and ALL its tasks permanently ` +
      `(id: ${parsed.task_list_id})`;
    guardDestructive({ confirm: parsed.confirm, preview });

    await ctx.client.deleteTaskList({ tasklist: parsed.task_list_id });
    return { deleted: true };
  },
});
