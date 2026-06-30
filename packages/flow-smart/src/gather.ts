import type { ListTasksOpts, TasksClient } from "tasks-smart/client";

/**
 * Page size for paginated task fetches. Google Tasks pages at 20 items by
 * default and caps `maxResults` at 100, so we ask for the max to keep the
 * round-trip count down while still walking every page.
 */
const TASK_PAGE_SIZE = 100;

/**
 * Fetch EVERY task matching `opts`, following the response `nextPageToken`
 * until the API stops returning one. The doc tools rely on this: a single
 * `listTasks` call returns only the first page (~20 items), silently dropping
 * tasks (overdue ones especially) for any list longer than one page. We pass
 * `maxResults: 100` and accumulate `items` across pages; `pageToken` is omitted
 * on the first request and carried forward thereafter.
 */
export async function listAllTasks(
  tasks: TasksClient,
  opts: Omit<ListTasksOpts, "maxResults" | "pageToken">,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const page = await tasks.listTasks({
      ...opts,
      maxResults: TASK_PAGE_SIZE,
      ...(pageToken !== undefined ? { pageToken } : {}),
    });
    items.push(...page.items);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return items;
}

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
