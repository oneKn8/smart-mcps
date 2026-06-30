# Google Apps Script API (script/v1) — Verified Implementation Reference

Researched 2026-06-30. Every claim is sourced to an official `developers.google.com`
page or the live API discovery document. Where a small-model page fetch and the
discovery document disagreed, the **discovery document is treated as authoritative**
(noted inline).

- API name: **Apps Script API**, service `script.googleapis.com`, version **v1**.
- Discovery doc (authoritative source of truth): `https://script.googleapis.com/$discovery/rest?version=v1`
- Overview/concepts: https://developers.google.com/apps-script/api/concepts
- REST reference root: https://developers.google.com/apps-script/api/reference/rest

> **Hard constraint that shapes every tool:** The Apps Script API **does not work with
> service accounts.** ("The Apps Script API doesn't work with service accounts." —
> https://developers.google.com/apps-script/api/concepts). Every call needs a
> **3‑legged user OAuth token**. No domain-wide delegation shortcut. This is the single
> biggest design fact for an MCP wrapper.

---

## 0. Base URL and request conventions

- Base URL: `https://script.googleapis.com`
- All paths below are appended to that base. JSON over HTTPS.
- Auth: `Authorization: Bearer <access_token>` (user OAuth token; never a service account).
- Timestamps are RFC3339 UTC ("Zulu"), e.g. `2026-06-30T12:00:00.000Z`.

---

## 1. Methods — verb, path, params, response

### 1.1 `projects` resource
Reference: https://developers.google.com/apps-script/api/reference/rest/v1/projects

| Method | Verb | Path | Notes |
|---|---|---|---|
| `projects.create` | POST | `/v1/projects` | Body = `Project` ({ `title`, optional `parentId` }). Returns `Project`. |
| `projects.get` | GET | `/v1/projects/{scriptId}` | Returns `Project`. |
| `projects.getContent` | GET | `/v1/projects/{scriptId}/content` | Query: `versionNumber` (int, optional; omit = HEAD). Returns `Content`. |
| `projects.updateContent` | PUT | `/v1/projects/{scriptId}/content` | Body = `Content` ({ `files[]` }). Returns `Content`. **Full overwrite** (see §2). |
| `projects.getMetrics` | GET | `/v1/projects/{scriptId}/metrics` | Query: `metricsGranularity` (enum, required), `metricsFilter.deploymentId` (optional). Returns `Metrics`. |

**`Project` resource fields**
- `scriptId` (string) — the script project's Drive file ID.
- `title` (string) — project title.
- `parentId` (string) — Drive ID of the container doc/sheet/form/site for a **bound**
  (container-bound) script; absent for a **standalone** script.
- `createTime`, `updateTime` (RFC3339 timestamps).
- `creator`, `lastModifyUser` — `User` objects (`domain`, `email`, `name`, `photoUrl`).

**`projects.create` body example**
```json
{ "title": "My Project", "parentId": "" }
```
- `parentId` omitted/empty → **standalone** script (a Drive file of MIME type
  `application/vnd.google-apps.script`). Setting `parentId` to a Doc/Sheet/Form ID
  attempts to create a bound script. Source: projects reference (above).

**`projects.getMetrics`**
Reference: https://developers.google.com/apps-script/api/reference/rest/v1/projects/getMetrics
- `metricsGranularity` enum: `UNSPECIFIED_GRANULARITY` (returns no metrics — do not use),
  `WEEKLY`, `DAILY` (daily over a 7‑day period).
- Response `Metrics`: `activeUsers[]`, `totalExecutions[]`, `failedExecutions[]`, each a
  `MetricsValue` = `{ "value": string, "startTime": timestamp, "endTime": timestamp }`.
- Scope: `https://www.googleapis.com/auth/script.metrics`.

### 1.2 `projects.versions` resource
Reference: https://developers.google.com/apps-script/api/reference/rest/v1/projects.versions

A version is an immutable, read-only snapshot of project content.

| Method | Verb | Path | Notes |
|---|---|---|---|
| `versions.create` | POST | `/v1/projects/{scriptId}/versions` | Body = `Version` ({ optional `description` }). Returns `Version` with system-assigned `versionNumber`. |
| `versions.get` | GET | `/v1/projects/{scriptId}/versions/{versionNumber}` | Returns `Version`. |
| `versions.list` | GET | `/v1/projects/{scriptId}/versions` | Query: `pageSize`, `pageToken`. Returns `{ versions[]: Version, nextPageToken }`. |

**`Version` resource fields**
- `scriptId` (string)
- `versionNumber` (integer) — "system assigned number and is immutable once created", auto-incremented.
- `description` (string)
- `createTime` (RFC3339 timestamp)

### 1.3 `projects.deployments` resource
Reference: https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments

> NOTE: deployment paths use the **same `{scriptId}`** as the project (the page calls the
> path placeholder `projectId`, but it is the script's Drive ID — i.e. `scriptId`).

| Method | Verb | Path | Notes |
|---|---|---|---|
| `deployments.create` | POST | `/v1/projects/{scriptId}/deployments` | Body = `DeploymentConfig`. Returns `Deployment`. |
| `deployments.list` | GET | `/v1/projects/{scriptId}/deployments` | Query: `pageSize`, `pageToken`. Returns `{ deployments[]: Deployment, nextPageToken }`. |
| `deployments.get` | GET | `/v1/projects/{scriptId}/deployments/{deploymentId}` | Returns `Deployment`. |
| `deployments.update` | PUT | `/v1/projects/{scriptId}/deployments/{deploymentId}` | Body = `{ "deploymentConfig": DeploymentConfig }`. Returns `Deployment`. |
| `deployments.delete` | DELETE | `/v1/projects/{scriptId}/deployments/{deploymentId}` | Returns empty `{}`. |

**`Deployment` resource fields**
- `deploymentId` (string)
- `deploymentConfig` (`DeploymentConfig`)
- `updateTime` (RFC3339 timestamp)
- `entryPoints[]` (`EntryPoint[]`)

**`DeploymentConfig` fields**
- `scriptId` (string)
- `versionNumber` (integer) — the version this deployment is based on. **Omit/leave null to
  deploy HEAD** (the "@HEAD"/last-saved code, used for a dev/test deployment).
- `manifestFileName` (string) — usually `"appsscript"`.
- `description` (string)

**`EntryPoint` + `entryPointType` enum**
- `entryPointType`: `WEB_APP`, `EXECUTION_API`, `ADD_ON` (plus `ENTRY_POINT_TYPE_UNSPECIFIED`).
- Sub-objects depending on type:
  - `WEB_APP` → `webApp` = `{ url, entryPointConfig: { access, executeAs } }`
  - `EXECUTION_API` → `executionApi` = `{ entryPointConfig: { access } }`  ← **this is the "API Executable"**
  - `ADD_ON` → `addOn` = `{ addOnType, title, description, helpUrl, reportIssueUrl, postInstallTipUrl }`

### 1.4 `processes` resource (execution monitoring)
Reference: https://developers.google.com/apps-script/api/reference/rest/v1/processes/list
and https://developers.google.com/apps-script/api/reference/rest/v1/processes/listScriptProcesses

| Method | Verb | Path | Notes |
|---|---|---|---|
| `processes.list` | GET | `/v1/processes` | Lists processes for **all** the caller's scripts. |
| `processes.listScriptProcesses` | GET | `/v1/processes:listScriptProcesses` | Lists processes for **one** script (`scriptId` query param required). |

**`processes.list` query params**
- `pageSize` (int, default 50), `pageToken` (string)
- `userProcessFilter` (object) → `ListUserProcessesFilter`:
  `scriptId`, `deploymentId`, `projectName` (substring match), `functionName`,
  `startTime`, `endTime` (RFC3339), `types[]` (`ProcessType`), `statuses[]` (`ProcessStatus`),
  `userAccessLevels[]` (`UserAccessLevel`).

**`processes.listScriptProcesses` query params**
- `scriptId` (string) — required.
- `scriptProcessFilter` (object) → `ListScriptProcessesFilter`: `deploymentId`,
  `functionName`, `startTime`, `endTime`, `types[]`, `statuses[]`, `userAccessLevels[]`.
- `pageSize`, `pageToken`.
- (Filter params are passed flattened, e.g. `scriptProcessFilter.functionName=foo`.)

**Response (both):** `{ "processes": [Process], "nextPageToken": string }`

**`Process` fields:** `projectName`, `functionName`, `processType`, `processStatus`,
`userAccessLevel`, `startTime`, `duration`, `runtimeVersion`.
- `ProcessType` enum: `PROCESS_TYPE_UNSPECIFIED`, `ADD_ON`, `EXECUTION_API`, `TIME_DRIVEN`,
  `TRIGGER`, `WEBAPP`, `EDITOR`, `SIMPLE_TRIGGER`, `MENU`, `BATCH_TASK`.
- `ProcessStatus` enum: `PROCESS_STATUS_UNSPECIFIED`, `RUNNING`, `PAUSED`, `COMPLETED`,
  `CANCELED`, `FAILED`, `TIMED_OUT`, `UNKNOWN`, `DELAYED`, `EXECUTING`.
- `UserAccessLevel` enum: `USER_ACCESS_LEVEL_UNSPECIFIED`, `NONE`, `READ`, `WRITE`, `OWNER`.
- Scope: `https://www.googleapis.com/auth/script.processes`.

### 1.5 `scripts.run` — remote function execution
See **§3** for the full, careful treatment. Summary line:
- **POST** `https://script.googleapis.com/v1/scripts/{scriptId}:run`

---

## 2. Project content model (`getContent` / `updateContent`)

Source: https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent
and .../projects/getContent

A `Content` resource:
```json
{
  "scriptId": "string",
  "files": [ { File }, ... ]
}
```

**`File` fields**
- `name` (string) — filename **without extension** (e.g. `Code`, `index`, `appsscript`).
- `type` (`FileType` enum): `ENUM_TYPE_UNSPECIFIED`, `SERVER_JS` (a `.gs` server script),
  `HTML`, `JSON`.
- `source` (string) — the full text content of the file.
- `lastModifyUser` (`User`), `createTime`, `updateTime`, `functionSet` (`{ values[]: {name} }`)
  — **read-only**, returned by `getContent`, ignored on write.

**Rules (critical for a "create/deploy script" tool):**
1. Exactly **one** file must be the manifest: `name` = `"appsscript"`, `type` = `JSON`,
   `source` = the `appsscript.json` text. Required on **every** `updateContent` call.
   ("One of the files is a script manifest; it must be named 'appsscript', must have type
   of JSON, and include the manifest configurations for the project.")
2. `updateContent` is a **full replacement** of the file set, not a patch. Any file you omit
   is **deleted**. Always send the complete project (manifest + all code/HTML files) every time.
3. Server code uses `type: "SERVER_JS"` (these are the `.gs` files). HTML templating/web-app
   pages use `type: "HTML"`.

**Minimal `updateContent` body — a `Code.gs` + manifest:**
```json
{
  "files": [
    {
      "name": "Code",
      "type": "SERVER_JS",
      "source": "function doGet() {\n  return ContentService.createTextOutput('hello');\n}\n\nfunction myFunc(name) {\n  return 'hi ' + name;\n}\n"
    },
    {
      "name": "appsscript",
      "type": "JSON",
      "source": "{\n  \"timeZone\": \"America/Chicago\",\n  \"runtimeVersion\": \"V8\",\n  \"exceptionLogging\": \"STACKDRIVER\",\n  \"oauthScopes\": []\n}"
    }
  ]
}
```
Note `source` is a **JSON string** for the manifest (escaped), not a nested object.

---

## 3. `scripts.run` — full requirements (the risky tool)

Reference (method): https://developers.google.com/apps-script/api/reference/rest/v1/scripts/run
Reference (guide): https://developers.google.com/apps-script/api/how-tos/execute

### 3.1 Endpoint and the scriptId-vs-deploymentId subtlety
From the **discovery document** (authoritative):
- `path` = `"v1/scripts/{scriptId}:run"`, verb **POST**.
- The URL placeholder is literally named **`scriptId`**, BUT its own description says:
  > "The script ID of the script to be executed. Find the script ID on the **Project
  > settings** page under 'IDs.' As multiple executable APIs can be deployed in new IDE for
  > same script, this field should be populated with **DeploymentID** generated while
  > deploying in new IDE instead of script ID."

  So: classic editor → script ID works; **new IDE → pass the API Executable Deployment ID**
  in that same `{scriptId}` slot. The rendered reference page even prints the placeholder as
  `{deploymentId}`. **MCP guidance:** accept a deployment ID (preferred) and fall back to
  script ID; treat them as the same path segment.

### 3.2 Preconditions (all required)
1. **API Executable deployment.** The script must be deployed with an `EXECUTION_API` entry
   point (Deploy → New deployment → type **API Executable**). You can create this via
   `deployments.create` with the manifest's `executionApi.access` set (see §5).
2. **Shared standard Google Cloud project.** The script and the calling app's OAuth client
   must share **one standard GCP project**. Quoted: *"Ensure that the script and the calling
   application's OAuth2 client share a common Google Cloud project. The Cloud project must be
   a standard Cloud project; default projects created for Apps Script projects are
   insufficient."* The auto-created "default" GCP project behind every script will **not**
   work — a 403 results otherwise. Setup: create/choose a standard GCP project, enable the
   Apps Script API on it, build the OAuth client there, then in the script's **Project
   Settings → Google Cloud Platform (GCP) Project → Change project**, paste that project's
   number. (Settings page: `https://script.google.com/home/projects/<scriptId>/settings`.)
3. **Token carries every scope the script uses.** Quoted: *"This OAuth token must cover all
   the scopes used by the script, not just the ones used by the called function."* Read the
   complete list from the script's Overview → **Project OAuth Scopes** and request all of
   them. Missing any → authorization error.
4. **Caller is authorized on the script** (owner or has been shared/has run rights).

### 3.3 Request body (`ExecutionRequest`)
```json
{
  "function": "myFunc",
  "parameters": ["Santo"],
  "devMode": false,
  "sessionState": ""
}
```
- `function` (string, required) — bare function name, no parens/args.
- `parameters[]` (array, optional) — **primitives only**: string, number, boolean, array,
  object. Apps Script-specific objects (Document, Blob, Calendar, Drive File, etc.) cannot
  be passed or returned.
- `devMode` (boolean, optional) — if `true` **and caller owns the script**, runs the latest
  **saved** (HEAD) code instead of the deployed version. Great for iterating without
  redeploying; useless for non-owners.
- `sessionState` (string, optional) — **deprecated**, Android add-ons only.

### 3.4 Response shape (READ THIS — it lies about HTTP status)
`scripts.run` returns **HTTP 200 even when the script throws.** You must inspect the body.

The body is an `Operation`:
- **Success:**
```json
{
  "done": true,
  "response": {
    "@type": "type.googleapis.com/google.apps.script.v1.ExecutionResponse",
    "result": <the function's return value>
  }
}
```
- **Script-side error (still HTTP 200):**
```json
{
  "done": true,
  "error": {
    "code": 3,
    "message": "ScriptError",
    "details": [
      {
        "@type": "type.googleapis.com/google.apps.script.v1.ExecutionError",
        "errorType": "ReferenceError",
        "errorMessage": "foo is not defined",
        "scriptStackTraceElements": [
          { "function": "myFunc", "lineNumber": 12 }
        ]
      }
    ]
  }
}
```
- **In progress:** `{ "done": false }` (no `response`/`error`).
- `error.code` values seen: `3` invalid argument / script error, `10` execution timeout
  (6‑min cap), `1` cancellation. Transport-level failures (bad scope, wrong GCP project,
  missing API Executable) **do** come back as real HTTP 4xx (401/403/404) — those are
  distinct from the in-body script `error`.

**MCP rule:** branch on `body.error` presence first, then `body.response.result`. Never
treat HTTP 200 as success.

### 3.5 Accepted authorization scopes for `scripts.run`
The method accepts **at least one** of the following (you typically pass the union of these
that the target script actually uses — see §3.2.3). Full list per the method reference:
```
https://apps-apis.google.com/a/feeds
https://apps-apis.google.com/a/feeds/alias/
https://apps-apis.google.com/a/feeds/groups/
https://mail.google.com/
https://sites.google.com/feeds
https://www.google.com/calendar/feeds
https://www.google.com/m8/feeds
https://www.googleapis.com/auth/admin.directory.group
https://www.googleapis.com/auth/admin.directory.user
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/documents.currentonly
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/forms
https://www.googleapis.com/auth/forms.currentonly
https://www.googleapis.com/auth/groups
https://www.googleapis.com/auth/script.cpanel
https://www.googleapis.com/auth/script.external_request
https://www.googleapis.com/auth/script.scriptapp
https://www.googleapis.com/auth/script.send_mail
https://www.googleapis.com/auth/script.storage
https://www.googleapis.com/auth/script.webapp.deploy
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/spreadsheets.currentonly
https://www.googleapis.com/auth/sqlservice
https://www.googleapis.com/auth/userinfo.email
```
Note: these are **product/runtime** scopes (Gmail, Sheets, Drive, etc.) — the script's own
scopes — NOT the `script.projects`/`script.deployments` management scopes. `scripts.run`
deliberately does **not** require granting management access to your project.

---

## 4. OAuth scope strings (full)

### 4.1 Apps Script API **management** scopes
Source: https://developers.google.com/identity/protocols/oauth2/scopes (Apps Script API section)

| Scope | Grants |
|---|---|
| `https://www.googleapis.com/auth/script.projects` | Create and update Apps Script projects (`projects.create/get/getContent/updateContent`, `versions.*`). |
| `https://www.googleapis.com/auth/script.projects.readonly` | Read-only: view projects / `getContent` / list versions. |
| `https://www.googleapis.com/auth/script.deployments` | Create and update deployments (`deployments.create/update/delete`). |
| `https://www.googleapis.com/auth/script.deployments.readonly` | View deployments (`deployments.get/list`). |
| `https://www.googleapis.com/auth/script.metrics` | View a project's metrics (`projects.getMetrics`). |
| `https://www.googleapis.com/auth/script.processes` | View processes (`processes.list`, `listScriptProcesses`). |

### 4.2 Common script **runtime** scopes (used inside scripts, and in `scripts.run` tokens)
| Scope | Grants |
|---|---|
| `https://www.googleapis.com/auth/script.scriptapp` | Manage the script's own **installable triggers** (`ScriptApp.newTrigger`). |
| `https://www.googleapis.com/auth/script.external_request` | Outbound `UrlFetchApp` HTTP requests. |
| `https://www.googleapis.com/auth/script.send_mail` | Send email as the user (`MailApp`/`GmailApp` send). |
| `https://www.googleapis.com/auth/script.storage` | `PropertiesService` / script storage. |
| `https://www.googleapis.com/auth/script.webapp.deploy` | Publish/deploy web apps. |
| `https://www.googleapis.com/auth/script.cpanel` | Script control-panel access. |
| (+ product scopes: `.../auth/spreadsheets`, `.../auth/drive`, `https://mail.google.com/`, `.../auth/documents`, `.../auth/forms`, `.../auth/calendar`, `.../auth/userinfo.email`, etc.) | Access the corresponding Google product the script touches. |

### 4.3 How a script's required scopes are determined
- Apps Script **auto-scans** the code and infers scopes from the built-in services used
  (`SpreadsheetApp`, `GmailApp`, `UrlFetchApp`, etc.). The current set is shown on the
  script's Overview → **Project OAuth Scopes**.
- You can **override/pin** them via the manifest `oauthScopes` array in `appsscript.json`:
  *"Replace the contents of the `oauthScopes` array with the scopes you want the project to
  use."* (Source: https://developers.google.com/apps-script/concepts/scopes)
- For `scripts.run`, the **calling** token must be a superset of this full set (see §3.2.3).

---

## 5. Deployment model (versions vs deployments, entry points)

- **Version** = immutable snapshot of content (`versions.create` → integer `versionNumber`).
  HEAD = the live, editable, last-saved code (no version number).
- **Deployment** = a published, externally-reachable instance bound to a version (or HEAD for
  test deployments) with one or more **entry points**.
- `DeploymentConfig` = `{ scriptId, versionNumber, manifestFileName, description }`.
  - Set `versionNumber` to pin a release; omit it for a HEAD/dev deployment.
  - `manifestFileName` is normally `"appsscript"`.
- The **entry point type** is governed by what the manifest declares:
  - `webapp` block in manifest → `WEB_APP` entry point (`access`: `MYSELF` | `DOMAIN` |
    `ANYONE` | `ANYONE_ANONYMOUS`; `executeAs`: `USER_ACCESSING` | `USER_DEPLOYING`).
  - `executionApi` block → `EXECUTION_API` entry point (the **API Executable**; `access`:
    `MYSELF` | `DOMAIN` | `ANYONE`). **Required for `scripts.run`.**
  - `addOns` block → `ADD_ON` entry point.
- Typical create-and-publish flow via the API:
  1. `updateContent` (manifest must include `executionApi` and/or `webapp`).
  2. `versions.create`.
  3. `deployments.create` with that `versionNumber`.
  4. Read `deployment.entryPoints[]` for the web-app `url` and/or use the `deploymentId`
     with `scripts.run`.

---

## 6. Running on a schedule WITHOUT `scripts.run` (triggers)

You generally do **not** need `scripts.run` to make a script run on a timer. Instead:

1. `updateContent` writing your function(s) + a manifest. **Time-driven triggers are NOT in
   the manifest** — quoted: *"Time-driven triggers are not configured in the manifest."*
   (https://developers.google.com/apps-script/manifest)
2. The script **installs its own trigger at runtime** via `ScriptApp.newTrigger("fn")...`
   (e.g. `.timeBased().everyHours(1).create()`). So your project includes a one-time setup
   function (e.g. `createTriggers()`).
3. You then **call that setup function once** to register the trigger. Two ways:
   - via `scripts.run` (API Executable, one-shot), or
   - manually run it once in the editor / wire it as an install step.
4. Thereafter the installed trigger fires the target function on Google's schedule with **no
   further API calls**. These show up in `processes.list` as `TIME_DRIVEN`/`TRIGGER` types.

**Can the REST API create triggers directly? No.** The Apps Script API has **no trigger
resource**. Quoted limitation from the execute guide: *"The API cannot create Apps Script
triggers."* Installable triggers are created **only** from inside the script (`ScriptApp`) or
via the editor's Triggers UI. The manifest cannot declare time-driven triggers either. So the
only programmatic path is: API writes code that calls `ScriptApp.newTrigger`, then that code
is executed once (the trigger then self-perpetuates). Requires the
`https://www.googleapis.com/auth/script.scriptapp` scope.

Trigger event types (created in-script): time-driven/clock (down to every minute), `onOpen`,
`onEdit`, `onChange`, `onFormSubmit`, `onCalendarEvent` (installable);
`onOpen`/`onEdit`/`onSelectionChange` also exist as automatic **simple** triggers.

---

## 7. Quotas, limits, and 2025-2026 notes

Sources: https://developers.google.com/apps-script/guides/services/quotas (Apps Script
runtime quotas, last updated 2026) and the method references above.

- **The API call itself**: the Apps Script API has a standard Google Cloud per-project /
  per-user request quota visible/adjustable in the GCP console (APIs & Services → Apps Script
  API → Quotas). It is a normal Cloud API quota; tune there if you hit 429.
- **`scripts.run` inherits Apps Script runtime quotas**, since it actually executes Apps
  Script: **6‑minute** max execution time per call; daily script-runtime budget and per-call
  service quotas apply (e.g. `UrlFetchApp` ~**20,000** calls/day on consumer Gmail vs
  ~**100,000**/day on Google Workspace; email/Trigger/etc. each have their own daily caps).
  Quotas are **per user, per 24h rolling window**, and are materially higher on paid
  Workspace accounts than free `@gmail.com`.
- **No service accounts** (restated): the whole API is unusable with a service-account token;
  must be an interactive-user token (concepts page).
- **Ownership move kills API Executables**: *"API executables cease responding to
  `scripts.run` requests if their script project changes ownership to either a shared drive or
  to an outside domain account."* (execute guide).
- **2025-2026 status**: `script/v1` remains the current/only version; no deprecation of the
  REST API. Notable ongoing changes: `sessionState` long-deprecated; legacy `STABLE`/Rhino
  runtime is being retired in favor of **V8** (new projects default to `runtimeVersion: "V8"`).
  Docs reviewed were current as of April-2026 revisions. No new deployment/version method
  signatures changed.

---

## 8. MCP tool-design + safety checklist (derived gotchas)

| # | Gotcha | Tool-design / safety implication |
|---|---|---|
| 1 | **No service accounts.** | Must implement 3‑legged OAuth (installed-app/loopback flow) and store a refresh token. No headless service-account path exists. |
| 2 | **Per-user API toggle.** Each user must turn ON "Google Apps Script API" at `https://script.google.com/home/usersettings` before **project-management** methods work (create/get/content/versions/deployments). `scripts.run` does **not** need it. | Detect the resulting 403 and surface a clear "enable at usersettings" message rather than a generic error. |
| 3 | **`updateContent` is a full overwrite.** | Tools must read-modify-write: `getContent` first, mutate the `files[]`, always re-include the `appsscript` manifest, then `updateContent`. Never send a partial file set — omitted files are deleted. |
| 4 | **`scripts.run` returns HTTP 200 on script errors.** | Parse `body.error` before `body.response.result`. Map in-body `ExecutionError` (`errorType`/`errorMessage`/`scriptStackTraceElements`) to a tool error; distinguish from transport 4xx. |
| 5 | **`scripts.run` needs a shared standard GCP project** (default project fails) **+ an API Executable deployment + a token carrying every script scope.** | This is a heavy, one-time, mostly-manual setup. The MCP cannot fully automate it (console + script-settings UI steps). Gate `scripts.run` behind an explicit, pre-verified config; fail fast with actionable setup guidance. |
| 6 | **`scriptId` slot wants the Deployment ID in the new IDE.** | Accept a deployment ID for `scripts.run`; document that bare script ID only works for classic-editor single-API deployments. |
| 7 | **Arbitrary code execution.** `updateContent` + deploy + `scripts.run` = remote code exec running as the user with broad Google scopes. | Treat these as **high-risk, confirmation-gated** tools. Validate/inspect `source` payloads, never auto-run untrusted function names, log every run, and keep run/write tools off any auto-approve list. |
| 8 | **Can't create triggers via API.** | A "schedule this script" tool must inject `ScriptApp.newTrigger` code and run a one-time setup function; it cannot call a trigger endpoint. Requires `script.scriptapp` scope. |
| 9 | **Primitives only across `scripts.run`.** | Validate params/return are JSON-primitive; reject attempts to pass Drive/Doc/Blob objects. |
| 10 | **6‑min cap + daily quotas.** | Long jobs will TIMED_OUT (`error.code` 10). Surface quota/timeout distinctly; consider `processes.list` polling for long-running async patterns. |

---

### Source URLs (all official)
- Concepts: https://developers.google.com/apps-script/api/concepts
- Projects: https://developers.google.com/apps-script/api/reference/rest/v1/projects
- getContent / updateContent: https://developers.google.com/apps-script/api/reference/rest/v1/projects/getContent · /updateContent
- getMetrics: https://developers.google.com/apps-script/api/reference/rest/v1/projects/getMetrics
- Versions: https://developers.google.com/apps-script/api/reference/rest/v1/projects.versions
- Deployments: https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments
- Processes: https://developers.google.com/apps-script/api/reference/rest/v1/processes/list · /listScriptProcesses
- scripts.run (method): https://developers.google.com/apps-script/api/reference/rest/v1/scripts/run
- scripts.run (guide): https://developers.google.com/apps-script/api/how-tos/execute
- Enable / access: https://developers.google.com/apps-script/api/how-tos/enable
- Scopes registry: https://developers.google.com/identity/protocols/oauth2/scopes
- Scopes concept: https://developers.google.com/apps-script/concepts/scopes
- Manifest: https://developers.google.com/apps-script/manifest
- Installable triggers: https://developers.google.com/apps-script/guides/triggers/installable
- Quotas: https://developers.google.com/apps-script/guides/services/quotas
- Discovery doc (authoritative): https://script.googleapis.com/$discovery/rest?version=v1
