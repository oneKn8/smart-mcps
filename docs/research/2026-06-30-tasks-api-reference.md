# Google Tasks API (tasks/v1) — Verified Implementation Reference

**Researched:** 2026-06-30
**Source authority:** All facts below come from official `developers.google.com` Tasks API pages (REST reference, auth, limits, release notes). Source URLs are cited per section. Nothing here is inferred or guessed.

---

## 1. Base URL / Service Endpoint

| Item | Value |
|------|-------|
| REST service root | `https://tasks.googleapis.com` |
| API version | `v1` |
| Path prefix | `https://tasks.googleapis.com/tasks/v1` |
| Discovery document | `https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest` |

Two resources exist: **tasklists** (rooted at `/users/@me/lists`) and **tasks** (rooted at `/lists/{tasklist}/tasks`). `@me` is the literal token for the authenticated user.

Source: <https://developers.google.com/tasks/reference/rest>

---

## 2. Complete Method Reference

### 2a. `tasklists` resource

Base collection: `https://tasks.googleapis.com/tasks/v1/users/@me/lists`

| Method | Verb + Path | Path params | Query params | Body | Returns |
|--------|-------------|-------------|--------------|------|---------|
| `tasklists.list` | `GET /users/@me/lists` | — | `maxResults` (int, **default 1000, max 1000**), `pageToken` (string) | empty | `{ kind:"tasks#taskLists", etag, nextPageToken, items[] }` |
| `tasklists.get` | `GET /users/@me/lists/{tasklist}` | `tasklist` | — | empty | `TaskList` |
| `tasklists.insert` | `POST /users/@me/lists` | — | — | `TaskList` (title) | created `TaskList` |
| `tasklists.update` | `PUT /users/@me/lists/{tasklist}` | `tasklist` | — | `TaskList` (full replace) | `TaskList` |
| `tasklists.patch` | `PATCH /users/@me/lists/{tasklist}` | `tasklist` | — | `TaskList` (patch semantics, partial) | `TaskList` |
| `tasklists.delete` | `DELETE /users/@me/lists/{tasklist}` | `tasklist` | — | empty | empty |

Notes:
- A user may have **at most 2000 task lists** (stated on the `tasklists.insert` page).
- Deleting a list that contains assigned tasks also deletes the assigned tasks and their originals in the assignment surface (Docs / Chat Spaces).

Sources: <https://developers.google.com/tasks/reference/rest/v1/tasklists>, `/list`, `/get`, `/insert`, `/update`, `/patch`, `/delete`.

### 2b. `tasks` resource

Base collection: `https://tasks.googleapis.com/tasks/v1/lists/{tasklist}/tasks`

| Method | Verb + Path | Path params | Query params | Body | Returns |
|--------|-------------|-------------|--------------|------|---------|
| `tasks.list` | `GET /lists/{tasklist}/tasks` | `tasklist` | see table 2c | empty | `{ kind:"tasks#tasks", etag, nextPageToken, items[] }` |
| `tasks.get` | `GET /lists/{tasklist}/tasks/{task}` | `tasklist`, `task` | — | empty | `Task` |
| `tasks.insert` | `POST /lists/{tasklist}/tasks` | `tasklist` | `parent` (string, opt), `previous` (string, opt) | `Task` | created `Task` |
| `tasks.update` | `PUT /lists/{tasklist}/tasks/{task}` | `tasklist`, `task` | — | `Task` (full replace) | `Task` |
| `tasks.patch` | `PATCH /lists/{tasklist}/tasks/{task}` | `tasklist`, `task` | — | `Task` (patch semantics, partial) | `Task` |
| `tasks.delete` | `DELETE /lists/{tasklist}/tasks/{task}` | `tasklist`, `task` | — | empty | empty |
| `tasks.move` | `POST /lists/{tasklist}/tasks/{task}/move` | `tasklist`, `task` | `parent`, `previous`, `destinationTasklist` (all opt) | empty | `Task` |
| `tasks.clear` | `POST /lists/{tasklist}/clear` | `tasklist` | — | empty | empty |

> Note the path inconsistency for `clear`: it is `/lists/{tasklist}/clear`, **not** under `/tasks`.

Sources: <https://developers.google.com/tasks/reference/rest/v1/tasks>, `/list`, `/get`, `/insert`, `/update`, `/patch`, `/delete`, `/move`, `/clear`.

### 2c. `tasks.list` query parameters (full)

| Param | Type | Description | Default | Max |
|-------|------|-------------|---------|-----|
| `completedMax` | string (RFC 3339) | Upper bound for a task's completion date | no filter | — |
| `completedMin` | string (RFC 3339) | Lower bound for a task's completion date | no filter | — |
| `dueMax` | string (RFC 3339) | Upper bound for a task's due date | no filter | — |
| `dueMin` | string (RFC 3339) | Lower bound for a task's due date | no filter | — |
| `updatedMin` | string (RFC 3339) | Lower bound for a task's last modification time | no filter | — |
| `maxResults` | integer | Max tasks per page | **20** | **100** |
| `pageToken` | string | Page token for next page | — | — |
| `showCompleted` | boolean | Include completed tasks | **true** | — |
| `showDeleted` | boolean | Include deleted tasks | false | — |
| `showHidden` | boolean | Include hidden tasks | false | — |
| `showAssigned` | boolean | Include tasks assigned to the current user (from Docs / Chat) | false | — |

Important interactions:
- `completedMin`/`completedMax`/`showHidden` only matter in combination with `showCompleted`. To list *completed* items you generally need `showCompleted=true` (it is true by default) and, because clearing hides completed tasks, often `showHidden=true` to surface previously-cleared ones.
- Assigned tasks are **not** returned unless `showAssigned=true`.

Source: <https://developers.google.com/tasks/reference/rest/v1/tasks/list>

### 2d. `tasks.move` parameters (reparenting / cross-list move) — verbatim

- **`parent`**: "New parent task identifier. If the task is moved to the top level, this parameter is omitted."
- **`previous`**: "New previous sibling task identifier. If the task is moved to the first position among its siblings, this parameter is omitted."
- **`destinationTasklist`**: "Destination task list identifier. If set, the task is moved from `tasklist` to the `destinationTasklist` list."

Documented move constraints:
- Assigned and repeating/recurring tasks cannot be parents nor become subtasks.
- Tasks that are both completed and hidden cannot be nested (`parent` must be empty) and can only move to position 0.
- Recurrent tasks cannot be moved between lists.
- Maximum **2000 subtasks** per task.

Source: <https://developers.google.com/tasks/reference/rest/v1/tasks/move>

### 2e. `tasks.insert` positioning params — verbatim

- **`parent`**: "Parent task identifier. If the task is created at the top level, this parameter is omitted. An assigned task cannot be a parent task, nor can it have a parent."
- **`previous`**: "Previous sibling task identifier. If the task is created at the first position among its siblings, this parameter is omitted."

Source: <https://developers.google.com/tasks/reference/rest/v1/tasks/insert>

### 2f. `tasks.clear` behavior — verbatim

"Clears all completed tasks from the specified task list. The affected tasks will be marked as 'hidden' and no longer be returned by default when retrieving all tasks for a task list." It **hides** completed tasks (does not delete them). Path: `POST /lists/{tasklist}/clear`.

Source: <https://developers.google.com/tasks/reference/rest/v1/tasks/clear>

---

## 3. OAuth 2.0 Scopes (exact strings)

| Scope (exact) | Access | Consent description (verbatim) |
|---------------|--------|--------------------------------|
| `https://www.googleapis.com/auth/tasks` | Read-write (full) | "Create, edit, organize, and delete all your tasks." |
| `https://www.googleapis.com/auth/tasks.readonly` | Read-only | "View your tasks." |

- All read methods (`*.list`, `*.get`) accept **either** scope.
- All mutating methods (`insert`, `update`, `patch`, `delete`, `move`, `clear`) require the full `https://www.googleapis.com/auth/tasks` scope.

Sources: <https://developers.google.com/workspace/tasks/auth>, and the "Authorization Scopes" block on each REST method page.

---

## 4. Pagination Model

- Cursor-based via `nextPageToken` in the response; pass it back as the `pageToken` query param to fetch the next page.
- `tasks.list`: `maxResults` default **20**, max **100** per page.
- `tasklists.list`: `maxResults` default **1000**, max **1000** per page.
- There is no offset/limit; iterate until `nextPageToken` is absent.

Sources: `/tasks/list`, `/tasklists/list`.

---

## 5. Resource Schemas

### 5a. `Task` resource

```json
{
  "kind": "tasks#task",        // Output only
  "id": "string",
  "etag": "string",
  "title": "string",           // max 1024 chars
  "updated": "string",         // RFC 3339, output only (last modification)
  "selfLink": "string",        // output only
  "parent": "string",          // output only; parent task id (omitted at top level)
  "position": "string",        // output only; sort key among siblings
  "notes": "string",           // max 8192 chars
  "status": "string",          // "needsAction" | "completed"
  "due": "string",             // RFC 3339; DATE-ONLY (see below)
  "completed": "string",       // RFC 3339; omitted if not completed
  "deleted": false,            // boolean, default false
  "hidden": false,             // boolean, default false (true after a clear)
  "links": [
    { "type": "string", "description": "string", "link": "string" }
  ],
  "webViewLink": "string",     // absolute link to the task in Google Tasks web UI
  "assignmentInfo": { ... }    // present only for assigned tasks (see 5c)
}
```

Field notes (verbatim from docs):
- `status`: "Status of the task. This is either 'needsAction' or 'completed'."
- `completed`: "Completion date of the task (as a RFC 3339 timestamp). This field is omitted if the task has not been completed."
- `position`: "String indicating the position of the task among its sibling tasks under the same parent task or at the top level." (It is a string sort key, not a numeric index. Set position via `move`/`insert` `previous`, not by writing this field.)
- `hidden`: "Flag indicating whether the task is hidden. This is the case if the task had been marked completed when the task list was last cleared. The default is False."
- `deleted`: "Flag indicating whether the task has been deleted ... The default is False."
- `links[].type`: "Type of the link, e.g. 'email', 'generic', 'chat_message', 'keep_note'." (`links` is output only.)

Source: <https://developers.google.com/tasks/reference/rest/v1/tasks>

### 5b. The `due` field — date-only (CONFIRMED)

Verbatim from the docs:
> "The due date only records date information; the time portion of the timestamp is discarded when setting the due date."
> "It isn't possible to read or write the time that a task is due via the API."

Practical meaning:
- The wire format is still a full RFC 3339 timestamp (e.g. `2026-06-30T00:00:00.000Z`), but only the **calendar date** is meaningful. The time-of-day you send is dropped server-side; reads come back with a zeroed/normalized time (commonly `T00:00:00.000Z`).
- There is **no** API-visible "due time." Time-specific reminders set in the Google Tasks UI are not exposed here.

Source: <https://developers.google.com/tasks/reference/rest/v1/tasks>

### 5c. `AssignmentInfo` (assigned tasks, output only)

Present only on tasks assigned from Google Docs or Chat Spaces:
- `linkToTask` — absolute link to the original assigned task.
- `surfaceType` — enum: `DOCUMENT` or `SPACE` (the context the task was assigned from).
- union `surface_info`: either `driveResourceInfo` (Docs) or `spaceInfo` (Chat).

Assigned tasks cannot be created via the API and cannot act as, or have, parents.

Source: <https://developers.google.com/tasks/reference/rest/v1/tasks>

### 5d. `TaskList` resource

```json
{
  "kind": "tasks#taskList",   // Output only
  "id": "string",
  "etag": "string",
  "title": "string",          // max 1024 chars
  "updated": "string",        // RFC 3339, output only
  "selfLink": "string"        // output only
}
```

Source: <https://developers.google.com/tasks/reference/rest/v1/tasklists>

---

## 6. Rate Limits / Quotas

| Limit | Value |
|-------|-------|
| Courtesy limit | **50,000 queries per day** (per project) |
| Per-minute / per-user limits | Not documented on the limits page |
| Task lists per user | 2000 |
| Subtasks per task | 2000 |

Quota increases can be requested in the Cloud console "Quotas & System Limits" page (approval not guaranteed). Standard Google APIs `429`/`403 rateLimitExceeded` backoff applies, but the docs only publish the 50k/day courtesy figure.

Source: <https://developers.google.com/workspace/tasks/limits>

---

## 7. 2025–2026 Changes & Gotchas

- **Assigned tasks (July 23, 2024):** You can now get, edit, and delete tasks assigned from Google Docs / Chat Spaces via the API. This added `assignmentInfo` to the `Task` schema and the `showAssigned` param to `tasks.list`. The official release-notes page lists no entries dated 2025 or 2026 as of this research (latest entry July 2024; GA was June 28, 2018). Source: <https://developers.google.com/workspace/tasks/release-notes>
- Assigned tasks are **hidden from `tasks.list` unless `showAssigned=true`**, and cannot be inserted, parented, or used as a parent.
- `tasks.clear` hides (not deletes) completed tasks; cleared tasks reappear only with `showHidden=true`.
- `position` is a server-managed string sort key. To reorder, use `tasks.move` with `previous`/`parent`, not by writing `position` directly.
- `etag` supports conditional requests, but there is no documented bulk/batch endpoint specific to Tasks (use the generic Google global HTTP batch endpoint if needed; Tasks itself exposes only the per-resource methods above).
- Docs host moved under the `developers.google.com/workspace/tasks/...` path; the older `developers.google.com/tasks/reference/...` REST pages still resolve and are authoritative.

---

## 8. "Smart Shortcut" Feasibility — Due-Date / Today / Overdue Filtering

**Question: can today's / overdue tasks be fetched purely via params, or must filtering be client-side?**

Answer: **partially server-side, but it is a trap — prefer client-side filtering for correctness.**

- `tasks.list` *does* expose `dueMin` and `dueMax` (RFC 3339), so a bounded due-date window request is possible at the API level, e.g. overdue = `dueMax=<today 00:00Z>` + `showCompleted=false`, today = `dueMin=<today 00:00Z>&dueMax=<tomorrow 00:00Z>`.
- **Gotcha 1 (date-only due):** because `due` carries no time, all due timestamps are normalized to midnight UTC. So "today" must be computed in **UTC calendar terms**, and your `dueMin`/`dueMax` boundaries must align to UTC midnight or you will off-by-one tasks for users in non-UTC time zones. Build day windows from the user's local date converted to the UTC midnight the API stores, not from "now".
- **Gotcha 2 (no due-date filter on tasks without due dates):** `dueMin`/`dueMax` only constrain tasks that *have* a due date; behavior of these filters is not strongly documented, so treat them as best-effort.
- **Gotcha 3 (overdue needs status too):** overdue = past due **and** not completed. `dueMax` alone returns completed-past-due tasks unless you also set `showCompleted=false`.
- **Recommendation for MCP tool design:** fetch the list (optionally narrowed with `dueMin`/`dueMax` to cut payload), then do final "is it today / is it overdue" bucketing **client-side** against the date-only `due` and `status` fields. Server params are an optimization, not a substitute for client logic.

Sources: <https://developers.google.com/tasks/reference/rest/v1/tasks/list>, <https://developers.google.com/tasks/reference/rest/v1/tasks>

---

## Appendix — Source URLs (all official)

- REST overview: <https://developers.google.com/tasks/reference/rest>
- tasklists resource + methods: <https://developers.google.com/tasks/reference/rest/v1/tasklists> (+ `/list /get /insert /update /patch /delete`)
- tasks resource + methods: <https://developers.google.com/tasks/reference/rest/v1/tasks> (+ `/list /get /insert /update /patch /delete /move /clear`)
- OAuth scopes: <https://developers.google.com/workspace/tasks/auth>
- Quotas/limits: <https://developers.google.com/workspace/tasks/limits>
- Release notes: <https://developers.google.com/workspace/tasks/release-notes>
