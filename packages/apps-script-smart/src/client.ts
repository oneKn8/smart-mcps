import {
  AuthError,
  NotFoundError,
  PermissionError,
  UpstreamError,
  ValidationError,
  fetchJson,
  GoogleOAuthClient,
} from "smart-mcp-core";

const APPS_SCRIPT_API_BASE = "https://script.googleapis.com/v1";
const APPS_SCRIPT_TOKEN_FILE_SUFFIX = ".script.json";
const APPS_SCRIPT_REQUIRED_SCOPE =
  "https://www.googleapis.com/auth/script.projects";

/**
 * Build the per-account re-auth hint shown inside any AuthError surfaced
 * by this client. Mirrors the CLI users actually run:
 *   `node packages/apps-script-smart/dist/bin/apps-script-smart-auth.js <account>`
 */
function reauthHintFor(account: string): string {
  return `node packages/apps-script-smart/dist/bin/apps-script-smart-auth.js ${account}`;
}

export type AppsScriptClientOpts = {
  /**
   * Override for the user home directory. When unset, the inner OAuth
   * client resolves `process.env.HOME` lazily on first use. Tests pass a
   * tmpdir.
   */
  home?: string;
  /**
   * Pre-built OAuth client for tests. Production code omits this; the
   * client builds one against the apps-script token-jar slot
   * (`<account>.script.json`) on construction.
   */
  oauthClient?: GoogleOAuthClient;
};

/** A single writable file in an `updateContent` request. */
export type ContentFile = {
  name: string;
  type: string;
  source: string;
};

/** The `DeploymentConfig` body fields a create/update deployment accepts. */
export type DeploymentConfigInput = {
  versionNumber?: number;
  manifestFileName?: string;
  description?: string;
};

/** Filters for `processes.list` / `processes.listScriptProcesses`. */
export type ListProcessesOpts = {
  scriptId?: string;
  deploymentId?: string;
  functionName?: string;
  statuses?: string[];
  types?: string[];
  startTime?: string;
  endTime?: string;
  pageSize?: number;
  pageToken?: string;
};

/** Arguments for a `scripts.run` call. */
export type RunFunctionOpts = {
  /**
   * The `{scriptId}` path segment. In the new IDE this MUST be the API
   * Executable DeploymentID; the classic editor accepts a bare script ID.
   * The tool layer prefers the deployment id and falls back to script id.
   */
  id: string;
  functionName: string;
  parameters: unknown[];
  devMode: boolean;
};

/** Result of a successful `scripts.run` — the function's return value. */
export type RunFunctionResult = {
  done: true;
  result: unknown;
};

/**
 * The painful one-time setup `scripts.run` needs, surfaced verbatim when a
 * 401/403 comes back. Points at the README rather than swallowing it as a
 * generic auth failure.
 */
function runSetupError(account: string, cause: unknown): AuthError {
  return new AuthError(
    "scripts.run is not set up for this token/script. It needs a one-time setup " +
      "the API cannot do for you: (1) a STANDARD Google Cloud project SHARED between " +
      "the script and your OAuth client — the auto-created default project will NOT " +
      "work; (2) an API Executable deployment of the script (create_deployment with an " +
      "executionApi manifest entry); and (3) an OAuth token carrying EVERY scope the " +
      "script itself uses, not just the called function's. See the 'scripts.run one-time " +
      `setup' section of the apps-script-smart README. (account: ${account})`,
    { cause },
  );
}

/**
 * REST client for Google Apps Script API v1. Constructor builds (but does
 * not read) the OAuth client; the token file is opened lazily on the first
 * method call.
 *
 * The token carries the `script.projects`, `script.deployments`,
 * `script.processes`, and `script.metrics` scopes (plus the runtime scopes
 * a deployed script declares when `scripts.run` is used); `requiredScope`
 * records the primary `script.projects` scope.
 */
export class AppsScriptClient {
  static readonly TOKEN_FILE_SUFFIX = APPS_SCRIPT_TOKEN_FILE_SUFFIX;
  static readonly REQUIRED_SCOPE = APPS_SCRIPT_REQUIRED_SCOPE;
  static readonly API_BASE = APPS_SCRIPT_API_BASE;

  private readonly oauthClient: GoogleOAuthClient;

  constructor(
    private readonly account: string,
    opts: AppsScriptClientOpts = {},
  ) {
    this.oauthClient =
      opts.oauthClient ??
      new GoogleOAuthClient(account, {
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        fileSuffix: APPS_SCRIPT_TOKEN_FILE_SUFFIX,
        reauthHint: reauthHintFor(account),
        requiredScope: APPS_SCRIPT_REQUIRED_SCOPE,
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
  // projects
  // ===========================================================================

  /**
   * POST /projects — create a new script project. `parentId` (when set)
   * binds the script to a container doc/sheet/form; omit it for a
   * standalone script. Returns the raw `Project` resource.
   */
  async createProject(body: {
    title: string;
    parentId?: string;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const payload: Record<string, unknown> = { title: body.title };
    if (body.parentId !== undefined) payload.parentId = body.parentId;
    try {
      return await fetchJson<unknown>(`${APPS_SCRIPT_API_BASE}/projects`, {
        method: "POST",
        token,
        body: payload,
      });
    } catch (err) {
      throw mapAppsScriptAuthError(err, this.account);
    }
  }

  /** GET /projects/{scriptId} — project metadata. 404 → NotFoundError. */
  async getProject(scriptId: string): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}`,
        { token },
      );
    } catch (err) {
      throw mapProjectNotFound(err, scriptId, this.account);
    }
  }

  /**
   * GET /projects/{scriptId}/content — the project's files (and manifest).
   * `versionNumber` omitted = HEAD (the live, editable code). Returns the
   * raw `Content` resource so `push_file` can read-modify-write it.
   */
  async getContent(
    scriptId: string,
    versionNumber?: number,
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (versionNumber !== undefined) searchParams.versionNumber = versionNumber;
    try {
      return await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/content`,
        {
          token,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      throw mapProjectNotFound(err, scriptId, this.account);
    }
  }

  /**
   * PUT /projects/{scriptId}/content — FULL OVERWRITE of the file set. Any
   * file not present in `files` is DELETED; exactly one file must be the
   * `appsscript` JSON manifest. Callers (the `update_content` tool and
   * `push_file`) own assembling the complete `files[]`. Returns the raw
   * `Content` resource.
   */
  async updateContent(
    scriptId: string,
    files: ContentFile[],
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/content`,
        { method: "PUT", token, body: { files } },
      );
    } catch (err) {
      throw mapProjectNotFound(err, scriptId, this.account);
    }
  }

  /**
   * GET /projects/{scriptId}/metrics — execution metrics. `metricsGranularity`
   * is required (`DAILY` or `WEEKLY`; `UNSPECIFIED_GRANULARITY` returns
   * nothing and is not exposed). `deploymentId` narrows to one deployment.
   * Returns the raw `Metrics` resource.
   */
  async getMetrics(opts: {
    scriptId: string;
    metricsGranularity: "DAILY" | "WEEKLY";
    deploymentId?: string;
  }): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      { metricsGranularity: opts.metricsGranularity };
    if (opts.deploymentId !== undefined) {
      searchParams["metricsFilter.deploymentId"] = opts.deploymentId;
    }
    try {
      return await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(opts.scriptId)}/metrics`,
        { token, searchParams },
      );
    } catch (err) {
      throw mapProjectNotFound(err, opts.scriptId, this.account);
    }
  }

  // ===========================================================================
  // projects.versions
  // ===========================================================================

  /**
   * POST /projects/{scriptId}/versions — snapshot the current HEAD content
   * into a new immutable version. `description` is optional. Returns the
   * raw `Version` with its system-assigned `versionNumber`.
   */
  async createVersion(
    scriptId: string,
    description?: string,
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    const body: Record<string, unknown> = {};
    if (description !== undefined) body.description = description;
    try {
      return await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/versions`,
        { method: "POST", token, body },
      );
    } catch (err) {
      throw mapProjectNotFound(err, scriptId, this.account);
    }
  }

  /**
   * GET /projects/{scriptId}/versions — list versions. Returns the raw
   * `{ versions[], nextPageToken }` envelope; `versions` is normalized to
   * `[]` when Google omits it.
   */
  async listVersions(opts: {
    scriptId: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<{ items: unknown[]; nextPageToken?: string }> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.pageSize !== undefined) searchParams.pageSize = opts.pageSize;
    if (opts.pageToken !== undefined) searchParams.pageToken = opts.pageToken;
    let raw: { versions?: unknown[]; nextPageToken?: string };
    try {
      raw = await fetchJson<{ versions?: unknown[]; nextPageToken?: string }>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(opts.scriptId)}/versions`,
        {
          token,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      throw mapProjectNotFound(err, opts.scriptId, this.account);
    }
    return {
      items: raw.versions ?? [],
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
    };
  }

  /** GET /projects/{scriptId}/versions/{versionNumber}. 404 → NotFoundError. */
  async getVersion(
    scriptId: string,
    versionNumber: number,
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/versions/${versionNumber}`,
        { token },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `Version \`${versionNumber}\` not found in project \`${scriptId}\`.`,
          { cause: err },
        );
      }
      throw mapAppsScriptAuthError(err, this.account);
    }
  }

  // ===========================================================================
  // projects.deployments
  // ===========================================================================

  /**
   * POST /projects/{scriptId}/deployments — create a deployment. The body is
   * the `DeploymentConfig` directly. Omit `versionNumber` to deploy HEAD (a
   * dev/test deployment). Returns the raw `Deployment`.
   */
  async createDeployment(
    scriptId: string,
    config: DeploymentConfigInput,
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/deployments`,
        { method: "POST", token, body: buildDeploymentConfig(config) },
      );
    } catch (err) {
      throw mapProjectNotFound(err, scriptId, this.account);
    }
  }

  /**
   * GET /projects/{scriptId}/deployments — list deployments. Returns the raw
   * `{ deployments[], nextPageToken }` envelope; `deployments` is normalized
   * to `[]` when omitted.
   */
  async listDeployments(opts: {
    scriptId: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<{ items: unknown[]; nextPageToken?: string }> {
    const token = await this.oauthClient.getAccessToken();
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (opts.pageSize !== undefined) searchParams.pageSize = opts.pageSize;
    if (opts.pageToken !== undefined) searchParams.pageToken = opts.pageToken;
    let raw: { deployments?: unknown[]; nextPageToken?: string };
    try {
      raw = await fetchJson<{
        deployments?: unknown[];
        nextPageToken?: string;
      }>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(opts.scriptId)}/deployments`,
        {
          token,
          ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        },
      );
    } catch (err) {
      throw mapProjectNotFound(err, opts.scriptId, this.account);
    }
    return {
      items: raw.deployments ?? [],
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
    };
  }

  /** GET /projects/{scriptId}/deployments/{deploymentId}. 404 → NotFoundError. */
  async getDeployment(
    scriptId: string,
    deploymentId: string,
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}` +
          `/deployments/${encodeURIComponent(deploymentId)}`,
        { token },
      );
    } catch (err) {
      throw mapDeploymentNotFound(err, scriptId, deploymentId, this.account);
    }
  }

  /**
   * PUT /projects/{scriptId}/deployments/{deploymentId} — replace a
   * deployment's config. Per the API the body is wrapped:
   * `{ deploymentConfig: DeploymentConfig }` (distinct from create, which
   * sends the config bare). Returns the raw `Deployment`.
   */
  async updateDeployment(
    scriptId: string,
    deploymentId: string,
    config: DeploymentConfigInput,
  ): Promise<unknown> {
    const token = await this.oauthClient.getAccessToken();
    try {
      return await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}` +
          `/deployments/${encodeURIComponent(deploymentId)}`,
        {
          method: "PUT",
          token,
          body: { deploymentConfig: buildDeploymentConfig(config) },
        },
      );
    } catch (err) {
      throw mapDeploymentNotFound(err, scriptId, deploymentId, this.account);
    }
  }

  /**
   * DELETE /projects/{scriptId}/deployments/{deploymentId} — delete a
   * deployment. Returns an empty body; the resolved promise carries no
   * value. 404 → NotFoundError.
   */
  async deleteDeployment(
    scriptId: string,
    deploymentId: string,
  ): Promise<void> {
    const token = await this.oauthClient.getAccessToken();
    try {
      await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}` +
          `/deployments/${encodeURIComponent(deploymentId)}`,
        { method: "DELETE", token },
      );
    } catch (err) {
      throw mapDeploymentNotFound(err, scriptId, deploymentId, this.account);
    }
  }

  // ===========================================================================
  // processes
  // ===========================================================================

  /**
   * List execution processes. When `scriptId` is set, hits
   * `/processes:listScriptProcesses` (one script, `scriptProcessFilter.*`);
   * otherwise `/processes` (all the caller's scripts, `userProcessFilter.*`).
   * Filter params are passed flattened. Returns the raw `processes[]` plus
   * `nextPageToken`; `processes` is normalized to `[]`.
   */
  async listProcesses(
    opts: ListProcessesOpts = {},
  ): Promise<{ items: unknown[]; nextPageToken?: string }> {
    const token = await this.oauthClient.getAccessToken();
    const perScript = opts.scriptId !== undefined;
    const prefix = perScript ? "scriptProcessFilter" : "userProcessFilter";
    const searchParams: Record<string, string | number | boolean | undefined> =
      {};
    if (perScript) searchParams.scriptId = opts.scriptId;
    if (opts.deploymentId !== undefined) {
      searchParams[`${prefix}.deploymentId`] = opts.deploymentId;
    }
    if (opts.functionName !== undefined) {
      searchParams[`${prefix}.functionName`] = opts.functionName;
    }
    if (opts.startTime !== undefined) {
      searchParams[`${prefix}.startTime`] = opts.startTime;
    }
    if (opts.endTime !== undefined) {
      searchParams[`${prefix}.endTime`] = opts.endTime;
    }
    if (opts.pageSize !== undefined) searchParams.pageSize = opts.pageSize;
    if (opts.pageToken !== undefined) searchParams.pageToken = opts.pageToken;

    // statuses[]/types[] repeat in the query string; build the URL by hand so
    // duplicates survive (the shared appendSearch uses .set and would clobber).
    const path = perScript
      ? `${APPS_SCRIPT_API_BASE}/processes:listScriptProcesses`
      : `${APPS_SCRIPT_API_BASE}/processes`;
    const url = new URL(path);
    for (const [k, v] of Object.entries(searchParams)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    for (const s of opts.statuses ?? []) {
      url.searchParams.append(`${prefix}.statuses`, s);
    }
    for (const t of opts.types ?? []) {
      url.searchParams.append(`${prefix}.types`, t);
    }

    let raw: { processes?: unknown[]; nextPageToken?: string };
    try {
      raw = await fetchJson<{
        processes?: unknown[];
        nextPageToken?: string;
      }>(url.toString(), { token });
    } catch (err) {
      throw mapAppsScriptAuthError(err, this.account);
    }
    return {
      items: raw.processes ?? [],
      ...(raw.nextPageToken !== undefined
        ? { nextPageToken: raw.nextPageToken }
        : {}),
    };
  }

  // ===========================================================================
  // scripts.run — the loaded gun
  // ===========================================================================

  /**
   * POST /scripts/{id}:run — execute a function in a deployed script AS THE
   * USER. Two hard facts shape this method:
   *
   *  1. It returns HTTP 200 EVEN WHEN THE SCRIPT THROWS. The script-side
   *     failure rides in `body.error` (an `ExecutionError` with `errorType`,
   *     `errorMessage`, `scriptStackTraceElements`). We inspect `body.error`
   *     BEFORE `body.response.result` and surface the script's stack trace as
   *     an UpstreamError. HTTP 200 is never treated as success on its own.
   *
   *  2. Missing setup (no shared standard GCP project, no API Executable
   *     deployment, or a token missing a script scope) comes back as a real
   *     401/403. We rewrite those into an actionable setup error pointing at
   *     the README, not a generic auth failure.
   */
  async runFunction(opts: RunFunctionOpts): Promise<RunFunctionResult> {
    const token = await this.oauthClient.getAccessToken();
    let op: unknown;
    try {
      op = await fetchJson<unknown>(
        `${APPS_SCRIPT_API_BASE}/scripts/${encodeURIComponent(opts.id)}:run`,
        {
          method: "POST",
          token,
          body: {
            function: opts.functionName,
            parameters: opts.parameters,
            devMode: opts.devMode,
          },
        },
      );
    } catch (err) {
      // A real transport 401/403 means the one-time setup is missing/broken.
      if (err instanceof AuthError || err instanceof PermissionError) {
        throw runSetupError(this.account, err);
      }
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `scripts.run target \`${opts.id}\` not found. Pass the API Executable ` +
            "DeploymentID (new IDE) or the script ID (classic editor), and confirm " +
            "the script has an API Executable deployment.",
          { cause: err },
        );
      }
      throw mapAppsScriptAuthError(err, this.account);
    }

    // HTTP 200 may still carry a script-side error. Inspect it FIRST.
    const scriptError = extractExecutionError(op);
    if (scriptError) {
      throw new UpstreamError(
        `scripts.run failed inside the script: ${scriptError.errorType}: ${scriptError.errorMessage}`,
        { detail: scriptError },
      );
    }

    // Require POSITIVE success confirmation: `done === true` AND a present
    // `response` object. proto3 omits the default-false `done`, so an
    // incomplete/odd operation (`{}`, `{done:true}`-no-response, an in-progress
    // op) must NOT be mislabeled success — throw and carry the raw body.
    const operation = (op ?? {}) as {
      done?: unknown;
      response?: unknown;
    };
    const response = operation.response;
    if (
      operation.done !== true ||
      typeof response !== "object" ||
      response === null
    ) {
      throw new UpstreamError(
        "scripts.run returned an incomplete or malformed operation " +
          "(expected done=true with a response); the execution did not finish.",
        { detail: op },
      );
    }
    return { done: true, result: (response as { result?: unknown }).result };
  }
}

/** A parsed Apps Script `ExecutionError`. */
type ExecutionError = {
  errorType: string;
  errorMessage: string;
  scriptStackTraceElements: unknown[];
};

/**
 * Pull the `ExecutionError` out of a `scripts.run` Operation body's
 * `error.details[]`, or null when the call succeeded. The error rides at
 * `body.error.details[].@type ==
 * type.googleapis.com/google.apps.script.v1.ExecutionError`.
 */
function extractExecutionError(op: unknown): ExecutionError | null {
  if (typeof op !== "object" || op === null) return null;
  const error = (op as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const eb = error as { message?: unknown; details?: unknown };
  let errorType = "ScriptError";
  let errorMessage =
    typeof eb.message === "string" ? eb.message : "unknown script error";
  let stack: unknown[] = [];
  if (Array.isArray(eb.details) && eb.details.length > 0) {
    const first = eb.details[0] as {
      errorType?: unknown;
      errorMessage?: unknown;
      scriptStackTraceElements?: unknown;
    };
    if (typeof first.errorType === "string") errorType = first.errorType;
    if (typeof first.errorMessage === "string") {
      errorMessage = first.errorMessage;
    }
    if (Array.isArray(first.scriptStackTraceElements)) {
      stack = first.scriptStackTraceElements;
    }
  }
  return {
    errorType,
    errorMessage,
    scriptStackTraceElements: stack,
  };
}

/** Build the wire `DeploymentConfig`, omitting absent fields. */
function buildDeploymentConfig(
  config: DeploymentConfigInput,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (config.versionNumber !== undefined) {
    out.versionNumber = config.versionNumber;
  }
  if (config.manifestFileName !== undefined) {
    out.manifestFileName = config.manifestFileName;
  }
  if (config.description !== undefined) out.description = config.description;
  return out;
}

/** Rewrite a 404 on a project path into a project-naming NotFoundError. */
function mapProjectNotFound(
  err: unknown,
  scriptId: string,
  account: string,
): unknown {
  if (err instanceof NotFoundError) {
    return new NotFoundError(`Script project \`${scriptId}\` not found.`, {
      cause: err,
    });
  }
  return mapAppsScriptAuthError(err, account);
}

/** Rewrite a 404 on a deployment path into a deployment-naming NotFoundError. */
function mapDeploymentNotFound(
  err: unknown,
  scriptId: string,
  deploymentId: string,
  account: string,
): unknown {
  if (err instanceof NotFoundError) {
    return new NotFoundError(
      `Deployment \`${deploymentId}\` not found in project \`${scriptId}\`.`,
      { cause: err },
    );
  }
  return mapAppsScriptAuthError(err, account);
}

/**
 * Promote 401/403 from `fetchJson` into AuthError messages that name the
 * account and point at the right fix. Three 403 shapes get tailored copy:
 *  - Apps Script API disabled on the Cloud project (accessNotConfigured).
 *  - The per-user Apps Script API toggle off (script.google.com/home/usersettings).
 *  - Anything else → insufficient-scope re-consent.
 * Non-auth errors (NotFound, Validation, Upstream) pass through; Validation
 * gets Google's inline reason appended.
 */
function mapAppsScriptAuthError(err: unknown, account: string): unknown {
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
  const detailText = JSON.stringify(
    (err as { detail?: unknown }).detail ?? "",
  ).toLowerCase();
  if (msg.includes("→ 403")) {
    if (
      detailText.includes("accessnotconfigured") ||
      detailText.includes("service_disabled") ||
      detailText.includes("has not been used in project")
    ) {
      return new AuthError(
        "Apps Script API is not enabled on your Cloud project. Enable it at " +
          "https://console.developers.google.com/apis/library/script.googleapis.com " +
          "then wait ~30s for propagation.",
        { cause: err },
      );
    }
    if (
      detailText.includes("usersettings") ||
      detailText.includes("user has not enabled the apps script api") ||
      detailText.includes("not enabled the apps script api")
    ) {
      return new AuthError(
        "Your account has the Apps Script API turned OFF. Turn it ON at " +
          "https://script.google.com/home/usersettings then retry.",
        { cause: err },
      );
    }
    return new AuthError(
      `apps-script token for account ${account} has insufficient scope — ` +
        `re-run ${reauthHintFor(account)} to re-consent with the script scopes`,
      { cause: err },
    );
  }
  if (msg.includes("→ 401")) {
    return new AuthError(
      `apps-script token rejected for account ${account}; ` +
        `re-run ${reauthHintFor(account)}`,
      { cause: err },
    );
  }
  return err;
}

/**
 * Extract Google's human-readable error reason from the parsed body the
 * core http layer attached as `.detail`. Google's standard shape is
 * `{ error: { errors: [{ message, reason }], message, code } }`.
 */
function extractGoogleErrorReason(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as { error?: unknown };
  const errBlock = d.error;
  if (typeof errBlock !== "object" || errBlock === null) return null;
  const eb = errBlock as { message?: unknown; errors?: unknown };
  if (Array.isArray(eb.errors) && eb.errors.length > 0) {
    const first = eb.errors[0] as { message?: unknown };
    if (typeof first.message === "string" && first.message.length > 0) {
      return first.message;
    }
  }
  if (typeof eb.message === "string" && eb.message.length > 0) {
    return eb.message;
  }
  return null;
}
