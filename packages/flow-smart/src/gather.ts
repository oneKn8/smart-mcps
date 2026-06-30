import type { TasksClient } from "tasks-smart/client";

/**
 * Resolve which task-list ids a report should scan. When `tasklist` is given
 * we use just that one; otherwise we enumerate every list the user owns (the
 * genuinely-complete behavior for review/brief docs). Mirrors the
 * `resolveListIds` pattern in tasks-smart's own shortcut tools, but reads only
 * the `id` field off the raw list resources the client returns.
 */
export async function resolveTaskListIds(
  tasks: TasksClient,
  tasklist: string | undefined,
): Promise<string[]> {
  if (tasklist !== undefined) return [tasklist];
  const { items } = await tasks.listTaskLists();
  const ids: string[] = [];
  for (const item of items) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return ids;
}
