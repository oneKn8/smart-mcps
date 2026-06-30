import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { TasksContext } from "../context.js";
import { mapTask, type SlimTask } from "../task-mapper.js";

// =============================================================================
// move_task
// =============================================================================

const moveTaskInputSchema = z.object({
  task_list_id: z.string().min(1),
  task_id: z.string().min(1),
  /** New parent task id. Omit to move to the top level. */
  parent: z.string().optional(),
  /** New previous sibling task id. Omit to move to the first position. */
  previous: z.string().optional(),
  /** Destination list id for a cross-list move. */
  destination_task_list_id: z.string().optional(),
});

type MoveTaskInput = z.infer<typeof moveTaskInputSchema>;

type MoveTaskOutput = { task: SlimTask };

/**
 * A task is "assigned" when it carries `assignmentInfo` (assigned from a
 * Google Doc or Chat Space). Assigned tasks cannot act as, or have, a parent.
 */
function isAssigned(raw: unknown): boolean {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const info = (raw as { assignmentInfo?: unknown }).assignmentInfo;
    return info !== undefined && info !== null;
  }
  return false;
}

/**
 * Best-effort recurring detection. The documented `Task` schema does not
 * expose a recurrence field, so this only fires when the raw resource carries
 * a `recurrence` array or a `recurringTaskId`. When recurrence is NOT visible,
 * the API's own 400 on an impossible move is the backstop. Documented
 * constraints: recurring tasks cannot move between lists, nor be nested.
 */
function isRecurring(raw: unknown): boolean {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as { recurrence?: unknown; recurringTaskId?: unknown };
    if (Array.isArray(o.recurrence) && o.recurrence.length > 0) return true;
    if (typeof o.recurringTaskId === "string" && o.recurringTaskId.length > 0) {
      return true;
    }
  }
  return false;
}

export const moveTaskTool = defineTool<
  MoveTaskInput,
  MoveTaskOutput,
  TasksContext
>({
  name: "move_task",
  description: "Move, reparent, or reorder a task",
  inputSchema: moveTaskInputSchema,
  handler: async (input, ctx) => {
    const crossList = input.destination_task_list_id !== undefined;
    const nesting = input.parent !== undefined;

    // Validate documented-impossible moves up front and reject them with a
    // clear message rather than letting the API 400. We only fetch the task(s)
    // when a move could plausibly violate a constraint (cross-list or nesting).
    if (crossList || nesting) {
      const moving = await ctx.client.getTask({
        tasklist: input.task_list_id,
        task: input.task_id,
      });
      if (crossList && isRecurring(moving)) {
        throw new ValidationError(
          `Task \`${input.task_id}\` is recurring and cannot be moved ` +
            `between lists.`,
        );
      }
      if (nesting) {
        if (isAssigned(moving)) {
          throw new ValidationError(
            `Task \`${input.task_id}\` is an assigned task and cannot ` +
              `become a subtask.`,
          );
        }
        if (isRecurring(moving)) {
          throw new ValidationError(
            `Task \`${input.task_id}\` is recurring and cannot become a ` +
              `subtask.`,
          );
        }
        // The named parent must itself be nestable. Validate against the list
        // the parent will live in (the destination when moving across lists).
        const parentList = input.destination_task_list_id ?? input.task_list_id;
        const parentTask = await ctx.client.getTask({
          tasklist: parentList,
          task: input.parent as string,
        });
        if (isAssigned(parentTask)) {
          throw new ValidationError(
            `Parent task \`${input.parent}\` is an assigned task and ` +
              `cannot have subtasks.`,
          );
        }
        if (isRecurring(parentTask)) {
          throw new ValidationError(
            `Parent task \`${input.parent}\` is recurring and cannot have ` +
              `subtasks.`,
          );
        }
      }
    }

    const raw = await ctx.client.moveTask({
      tasklist: input.task_list_id,
      task: input.task_id,
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
      ...(input.previous !== undefined ? { previous: input.previous } : {}),
      ...(input.destination_task_list_id !== undefined
        ? { destinationTasklist: input.destination_task_list_id }
        : {}),
    });
    return { task: mapTask(raw) };
  },
});

// =============================================================================
// clear_completed (destructive — HIDES completed tasks; confirm-gated)
// =============================================================================

const clearCompletedInputSchema = z.object({
  task_list_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type ClearCompletedInput = z.input<typeof clearCompletedInputSchema>;
type ClearCompletedParsed = z.infer<typeof clearCompletedInputSchema>;
type ClearCompletedOutput = { cleared: true };

export const clearCompletedTool = defineTool<
  ClearCompletedInput,
  ClearCompletedOutput,
  TasksContext
>({
  name: "clear_completed",
  // Tasks are HIDDEN, not deleted — they reappear with show_hidden.
  description: "Hide completed tasks in a list",
  // Cast required because `confirm` has `.optional().default(...)`.
  inputSchema:
    clearCompletedInputSchema as unknown as z.ZodType<ClearCompletedInput>,
  handler: async (input, ctx) => {
    const parsed = input as ClearCompletedParsed;
    const preview =
      `Hide all completed tasks in list '${parsed.task_list_id}'. ` +
      `They are not deleted; re-list with show_hidden=true to see them.`;
    guardDestructive({ confirm: parsed.confirm, preview });
    await ctx.client.clearTasks({ tasklist: parsed.task_list_id });
    return { cleared: true };
  },
});
