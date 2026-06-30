import {
  AuthError,
  NotFoundError,
  ValidationError,
  fetchJson,
  GoogleOAuthClient,
} from "smart-mcp-core";

const TASKS_API_BASE = "https://tasks.googleapis.com/tasks/v1";
const TASKS_TOKEN_FILE_SUFFIX = ".tasks.json";
const TASKS_REQUIRED_SCOPE = "https://www.googleapis.com/auth/tasks";

/**
 * Build the per-account re-auth hint shown inside any AuthError surfaced
 * by this client. Mirrors the CLI users actually run:
 *   `node packages/tasks-smart/dist/bin/tasks-smart-auth.js <account>`
 */
function reauthHintFor(account: string): string {
  return `node packages/tasks-smart/dist/bin/tasks-smart-auth.js ${account}`;
}

export type TasksClientOpts = {
  /**
   * Override for the user home directory. When unset, the inner OAuth
   * client resolves `process.env.HOME` lazily on first use. Tests pass a
   * tmpdir.
   */
  home?: string;
  /**
   * Pre-built OAuth client for tests. Production code omits this; the
   * client builds one against the tasks token-jar slot
   * (`<account>.tasks.json`) on construction.
   */
  oauthClient?: GoogleOAuthClient;
};

/** Query options for `listTaskLists`. */
export type ListTaskListsOpts = {
  maxResults?: number;
  pageToken?: string;
};

/** Query options for `listTasks`. */
export type ListTasksOpts = {
  tasklist: string;
  showCompleted?: boolean;
  showHidden?: boolean;
  showDeleted?: boolean;
  showAssigned?: boolean;
  dueMin?: string;
  dueMax?: string;
  completedMin?: string;
  completedMax?: string;
  updatedMin?: string;
  maxResults?: number;
  pageToken?: string;
};

/** Shared `{ items, nextPageToken? }` envelope returned by the list methods. */
export type ListResult = {
  items: unknown[];
  nextPageToken?: string;
};

/**
 * REST client for Google Tasks API v1. Constructor builds (but does not
 * read) the OAuth client; the token file is opened lazily on the first
 * method call.
 *
 * Two resources: `tasklists` (rooted at `/users/@me/lists`) and `tasks`
 * (rooted at `/lists/{tasklist}/tasks`). `@me` is the literal token for the
 * authenticated user. The `clear` method is the one path inconsistency:
 * `/lists/{tasklist}/clear`, NOT under `/tasks`.
 */
export class TasksClient {
  static readonly TOKEN_FILE_SUFFIX = TASKS_TOKEN_FILE_SUFFIX;
  static readonly REQUIRED_SCOPE = TASKS_REQUIRED_SCOPE;
  static readonly API_BASE = TASKS_API_BASE;

  private readonly oauthClient: GoogleOAuthClient;

  constructor(
    private readonly account: string,
    opts: TasksClientOpts = {},
  ) {
    this.oauthClient =
      opts.oauthClient ??
      new GoogleOAuthClient(account, {
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        fileSuffix: TASKS_TOKEN_FILE_SUFFIX,
        reauthHint: reauthHintFor(account),
        requiredScope: TASKS_REQUIRED_SCOPE,
      });
  }

  /**
   * Account identifier this client is bound to. Mirrors the basename of
   * the token file under `~/.santo-agent/oauth/`. Read-only — used by
   * tools that surface the account in error messages.
   */
  getAccount(): string {
    return this.account;
  }

  // ===========================================================================
  // tasklists resource — /users/@me/lists
  // ===========================================================================

  /**
   * GET /users/@me/lists — every task list the user owns. `items` is
   * normalized to `[]`. `maxResults` defaults to Google's 1000 (also the max)
   * when unset, so a single page covers all but the largest accounts.
   */
  async listTaskLists(opts: ListTaskListsOpts = {}): Promise<ListResult> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.maxResults !== undefined) searchParams.maxResults = opts.maxResults;
    if (opts.pageToken !== undefined) searchParams.pageToken = opts.pageToken;
    let raw: { items?: unknown[]; nextPageToken?: string };
    try {
      raw = await fetchJson<{ items?: unknown[]; nextPageToken?: string }>(
        `${TASKS_API_BASE}/users/@me/lists`,
        {
          token,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      throw mapTasksAuthError(err, this.account);
    }
    return {
      items: raw.items ?? [],
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
    };
  }

  /**
   * GET /users/@me/lists/{tasklist} — a single task list. A 404 is rewritten
   * into a NotFoundError naming the list id.
   */
  async getTaskList(tasklist: string): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${TASKS_API_BASE}/users/@me/lists/${encodeURIComponent(tasklist)}`,
        { token },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`Task list \`${tasklist}\` not found.`, {
          cause: err,
        });
      }
      throw mapTasksAuthError(err, this.account);
    }
  }

  /**
   * POST /users/@me/lists — create a task list. The body carries `title`.
   * Returns the created `TaskList` resource raw.
   */
  async insertTaskList(body: Record<string, unknown>): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(`${TASKS_API_BASE}/users/@me/lists`, {
        method: "POST",
        token,
        body,
      });
    } catch (err) {
      throw mapTasksAuthError(err, this.account);
    }
  }

  /**
   * PATCH /users/@me/lists/{tasklist} — partial update (patch semantics).
   * Only fields present in `body` are touched. 404 → NotFoundError.
   */
  async patchTaskList(opts: {
    tasklist: string;
    body: Record<string, unknown>;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${TASKS_API_BASE}/users/@me/lists/${encodeURIComponent(opts.tasklist)}`,
        { method: "PATCH", token, body: opts.body },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`Task list \`${opts.tasklist}\` not found.`, {
          cause: err,
        });
      }
      throw mapTasksAuthError(err, this.account);
    }
  }

  /**
   * DELETE /users/@me/lists/{tasklist} — delete a task list (and the tasks in
   * it). Returns 204; the resolved promise carries no value. 404 →
   * NotFoundError.
   */
  async deleteTaskList(opts: { tasklist: string }): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${TASKS_API_BASE}/users/@me/lists/${encodeURIComponent(opts.tasklist)}`,
        { method: "DELETE", token },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`Task list \`${opts.tasklist}\` not found.`, {
          cause: err,
        });
      }
      throw mapTasksAuthError(err, this.account);
    }
  }

  // ===========================================================================
  // tasks resource — /lists/{tasklist}/tasks
  // ===========================================================================

  /**
   * GET /lists/{tasklist}/tasks — tasks in a list. Returns `items` (normalized
   * to `[]`) plus `nextPageToken`. All documented query filters are forwarded
   * verbatim; `dueMin`/`dueMax` only constrain tasks that HAVE a due date and
   * are best-effort per the API docs.
   */
  async listTasks(opts: ListTasksOpts): Promise<ListResult> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.showCompleted !== undefined) {
      searchParams.showCompleted = opts.showCompleted;
    }
    if (opts.showHidden !== undefined) searchParams.showHidden = opts.showHidden;
    if (opts.showDeleted !== undefined) {
      searchParams.showDeleted = opts.showDeleted;
    }
    if (opts.showAssigned !== undefined) {
      searchParams.showAssigned = opts.showAssigned;
    }
    if (opts.dueMin !== undefined) searchParams.dueMin = opts.dueMin;
    if (opts.dueMax !== undefined) searchParams.dueMax = opts.dueMax;
    if (opts.completedMin !== undefined) {
      searchParams.completedMin = opts.completedMin;
    }
    if (opts.completedMax !== undefined) {
      searchParams.completedMax = opts.completedMax;
    }
    if (opts.updatedMin !== undefined) searchParams.updatedMin = opts.updatedMin;
    if (opts.maxResults !== undefined) searchParams.maxResults = opts.maxResults;
    if (opts.pageToken !== undefined) searchParams.pageToken = opts.pageToken;
    let raw: { items?: unknown[]; nextPageToken?: string };
    try {
      raw = await fetchJson<{ items?: unknown[]; nextPageToken?: string }>(
        `${TASKS_API_BASE}/lists/${encodeURIComponent(opts.tasklist)}/tasks`,
        {
          token,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`Task list \`${opts.tasklist}\` not found.`, {
          cause: err,
        });
      }
      throw mapTasksAuthError(err, this.account);
    }
    return {
      items: raw.items ?? [],
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
    };
  }

  /**
   * GET /lists/{tasklist}/tasks/{task} — a single task. A 404 is rewritten
   * into a NotFoundError naming both the task id and the list id.
   */
  async getTask(opts: { tasklist: string; task: string }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${TASKS_API_BASE}/lists/${encodeURIComponent(opts.tasklist)}` +
          `/tasks/${encodeURIComponent(opts.task)}`,
        { token },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Task \`${opts.task}\` not found in list \`${opts.tasklist}\`.`,
          { cause: err },
        );
      }
      throw mapTasksAuthError(err, this.account);
    }
  }

  /**
   * POST /lists/{tasklist}/tasks — create a task. Optional `parent` (nest
   * under a task) and `previous` (sibling ordering) ride as query params.
   * Returns the created `Task` resource raw.
   */
  async insertTask(opts: {
    tasklist: string;
    body: Record<string, unknown>;
    parent?: string;
    previous?: string;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.parent !== undefined) searchParams.parent = opts.parent;
    if (opts.previous !== undefined) searchParams.previous = opts.previous;
    try {
      return await fetchJson<unknown>(
        `${TASKS_API_BASE}/lists/${encodeURIComponent(opts.tasklist)}/tasks`,
        {
          method: "POST",
          token,
          body: opts.body,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`Task list \`${opts.tasklist}\` not found.`, {
          cause: err,
        });
      }
      throw mapTasksAuthError(err, this.account);
    }
  }

  /**
   * PATCH /lists/{tasklist}/tasks/{task} — partial update (patch semantics).
   * Only fields present in `body` are touched. Used by `update_task` and
   * `complete_task`. A 404 is rewritten into a NotFoundError naming the task.
   */
  async patchTask(opts: {
    tasklist: string;
    task: string;
    body: Record<string, unknown>;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${TASKS_API_BASE}/lists/${encodeURIComponent(opts.tasklist)}` +
          `/tasks/${encodeURIComponent(opts.task)}`,
        { method: "PATCH", token, body: opts.body },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Task \`${opts.task}\` not found in list \`${opts.tasklist}\`.`,
          { cause: err },
        );
      }
      throw mapTasksAuthError(err, this.account);
    }
  }

  /**
   * DELETE /lists/{tasklist}/tasks/{task} — delete a task. Returns 204; the
   * resolved promise carries no value. 404 → NotFoundError naming the task.
   */
  async deleteTask(opts: { tasklist: string; task: string }): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${TASKS_API_BASE}/lists/${encodeURIComponent(opts.tasklist)}` +
          `/tasks/${encodeURIComponent(opts.task)}`,
        { method: "DELETE", token },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Task \`${opts.task}\` not found in list \`${opts.tasklist}\`.`,
          { cause: err },
        );
      }
      throw mapTasksAuthError(err, this.account);
    }
  }

  /**
   * POST /lists/{tasklist}/tasks/{task}/move — reparent / reorder / cross-list
   * move. `parent` omitted = top level; `previous` omitted = first sibling;
   * `destinationTasklist` set = move to another list. `position` is NOT
   * writable — ordering is expressed via `previous`. Returns the moved `Task`.
   * A 404 is rewritten into a NotFoundError naming the task.
   */
  async moveTask(opts: {
    tasklist: string;
    task: string;
    parent?: string;
    previous?: string;
    destinationTasklist?: string;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.parent !== undefined) searchParams.parent = opts.parent;
    if (opts.previous !== undefined) searchParams.previous = opts.previous;
    if (opts.destinationTasklist !== undefined) {
      searchParams.destinationTasklist = opts.destinationTasklist;
    }
    try {
      return await fetchJson<unknown>(
        `${TASKS_API_BASE}/lists/${encodeURIComponent(opts.tasklist)}` +
          `/tasks/${encodeURIComponent(opts.task)}/move`,
        {
          method: "POST",
          token,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Task \`${opts.task}\` not found in list \`${opts.tasklist}\`.`,
          { cause: err },
        );
      }
      throw mapTasksAuthError(err, this.account);
    }
  }

  /**
   * POST /lists/{tasklist}/clear — HIDE all completed tasks in a list. Note
   * the path inconsistency: `/lists/{tasklist}/clear`, NOT under `/tasks`.
   * This does NOT delete the tasks; they are marked hidden and reappear only
   * when listed with `showHidden=true`. Returns 204; resolves with no value.
   * 404 → NotFoundError naming the list.
   */
  async clearTasks(opts: { tasklist: string }): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${TASKS_API_BASE}/lists/${encodeURIComponent(opts.tasklist)}/clear`,
        { method: "POST", token },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`Task list \`${opts.tasklist}\` not found.`, {
          cause: err,
        });
      }
      throw mapTasksAuthError(err, this.account);
    }
  }
}

/**
 * Promote 401/403 from `fetchJson` into AuthError messages that name the
 * account and point at the `tasks-smart-auth` CLI. `fetchJson` already maps
 * both statuses to AuthError generically; we re-throw a friendlier one.
 * NotFoundError passes through untouched; a 400 ValidationError is enriched
 * with Google's per-error reason when present.
 */
function mapTasksAuthError(err: unknown, account: string): unknown {
  if (err instanceof NotFoundError) return err;
  if (err instanceof ValidationError) {
    const detail = (err as { detail?: unknown }).detail;
    const reason = extractGoogleErrorReason(detail);
    if (reason) {
      return new ValidationError(`${err.message} — ${reason}`, {
        detail,
        cause: err,
      });
    }
    return err;
  }
  if (!(err instanceof AuthError)) return err;
  const msg = err.message;
  // The core http layer puts only `METHOD url → 403` in the message and the
  // Google error body in `.detail`, so we scan BOTH for the service-disabled
  // markers (scanning only the message would never match).
  const haystack = `${msg} ${JSON.stringify(
    (err as { detail?: unknown }).detail ?? "",
  )}`;
  if (msg.includes("→ 403")) {
    if (
      haystack.includes("accessNotConfigured") ||
      haystack.includes("SERVICE_DISABLED") ||
      haystack.includes("has not been used in project")
    ) {
      return new AuthError(
        `Google Tasks API is not enabled on your Cloud project. ` +
          `Enable it at https://console.developers.google.com/apis/library/tasks.googleapis.com ` +
          `then wait ~30s for propagation.`,
        { cause: err },
      );
    }
    return new AuthError(
      `tasks token for account ${account} has insufficient scope — ` +
        `re-run ${reauthHintFor(account)} to re-consent with the tasks scope`,
      { cause: err },
    );
  }
  if (msg.includes("→ 401")) {
    return new AuthError(
      `tasks token rejected for account ${account}; ` +
        `re-run ${reauthHintFor(account)}`,
      { cause: err },
    );
  }
  return err;
}

/**
 * Extract Google's human-readable error reason from the parsed body the core
 * http layer attached as `.detail`. Google's standard shape is
 * `{ error: { errors: [{ message, reason }], message, code } }`. Returns the
 * most informative string, or null when nothing useful is found.
 */
function extractGoogleErrorReason(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as { error?: unknown };
  const errBlock = d.error;
  if (typeof errBlock !== "object" || errBlock === null) return null;
  const eb = errBlock as { message?: unknown; errors?: unknown };
  if (Array.isArray(eb.errors) && eb.errors.length > 0) {
    const first = eb.errors[0] as { message?: unknown; reason?: unknown };
    if (typeof first.message === "string" && first.message.length > 0) {
      return first.message;
    }
  }
  if (typeof eb.message === "string" && eb.message.length > 0) {
    return eb.message;
  }
  return null;
}
