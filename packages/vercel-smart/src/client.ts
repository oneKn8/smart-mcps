import {
  loadCreds,
  fetchJson,
  AuthError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  UpstreamError,
  ValidationError,
  AmbiguousMatchError,
} from "smart-mcp-core";
import { assertTeamWritable } from "./safety.js";

export type VercelCreds = {
  VERCEL_TOKEN: string;
  VERCEL_TEAM_ID?: string;
};

type VercelCredsRecord = Record<"VERCEL_TOKEN" | "VERCEL_TEAM_ID", string>;

export type TeamScope =
  | { kind: "personal" }
  | { kind: "team"; id: string; slug: string };

export interface VercelTeam {
  id: string;
  slug: string;
  name: string;
}

export interface ListTeamsResponse {
  teams: VercelTeam[];
  pagination?: { count?: number; next?: string | null };
}

export interface ListProjectsResponse {
  projects: Array<Record<string, unknown>>;
  pagination: { count: number; next: string | null };
}

export type VercelProject = Record<string, unknown> & {
  id: string;
  name: string;
};

export type TaggedProject = VercelProject & { team: string };

export interface ListAllProjectsResponse {
  projects: TaggedProject[];
  count: number;
}

export interface ListProjectsOptions {
  limit?: number;
  until?: number;
}

export interface ProjectDomain {
  name: string;
  apexName: string;
  projectId: string;
  redirect: string | null;
  redirectStatusCode: number | null;
  verified: boolean;
  gitBranch?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ListProjectDomainsResponse {
  domains: ProjectDomain[];
  pagination?: { count: number; next: string | null };
}

export interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  state:
    | "READY"
    | "ERROR"
    | "BUILDING"
    | "CANCELED"
    | "QUEUED"
    | "INITIALIZING"
    | string;
  createdAt: number;
  target: "production" | "staging" | null | string;
}

export interface UpdateProjectDomainBody {
  redirect?: string | null;
  redirectStatusCode?: 301 | 302 | 307 | 308 | null;
  gitBranch?: string | null;
}

export interface AddProjectDomainBody {
  name: string;
  gitBranch?: string | null;
  redirect?: string | null;
  redirectStatusCode?: 301 | 302 | 307 | 308 | null;
}

export type EnvTarget = "production" | "preview" | "development";
export type EnvType = "encrypted" | "plain" | "sensitive" | "secret" | "system";

export interface ProjectEnv {
  id: string;
  key: string;
  value?: string;
  type: EnvType | string;
  target?: EnvTarget[] | string;
  gitBranch?: string | null;
  configurationId?: string | null;
  comment?: string;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface ListProjectEnvResponse {
  envs: ProjectEnv[];
  pagination?: { count: number; next: number | null; prev: number | null };
  hiddenProductionEnvCount?: number;
}

export interface ListProjectEnvOptions {
  decrypt?: boolean;
  gitBranch?: string;
}

export interface UpsertProjectEnvBody {
  key: string;
  value: string;
  type?: EnvType;
  target?: EnvTarget[] | EnvTarget;
  gitBranch?: string | null;
  comment?: string;
}

export type UpdateProjectEnvBody = Partial<UpsertProjectEnvBody>;

export interface CreateDeploymentBody {
  name: string;
  deploymentId?: string;
  target?: "production" | "staging" | "preview" | string;
  [key: string]: unknown;
}

export interface ListDeploymentsResponse {
  deployments: VercelDeployment[];
  pagination?: { count?: number; next?: string | null };
}

export interface ListDeploymentsOptions {
  projectId?: string;
  limit?: number;
}

function scopeLabel(scope: TeamScope): string {
  return scope.kind === "personal" ? "personal" : scope.slug;
}

function scopeTeamId(scope: TeamScope): string | undefined {
  return scope.kind === "team" ? scope.id : undefined;
}

// Local query-string builder for the no-body request path (see requestNoBody);
// mirrors core's internal appendSearch, which fetchJson does not export.
function withSearch(
  url: string,
  params?: Record<string, string | number | undefined>,
): string {
  if (!params) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export class VercelClient {
  private readonly creds: VercelCreds;
  private teamsCache: VercelTeam[] | null = null;
  private scopesCache: TeamScope[] | null = null;
  private projectScopeMap: Map<string, { project: VercelProject; scope: TeamScope }> | null = null;
  private projectIdScopeMap: Map<string, { project: VercelProject; scope: TeamScope }> | null = null;
  private projectNameScopeMap: Map<
    string,
    Array<{ project: VercelProject; scope: TeamScope }>
  > | null = null;

  constructor(creds?: VercelCreds) {
    this.creds =
      creds ??
      (loadCreds<VercelCredsRecord>({
        serviceName: "vercel-smart",
        required: ["VERCEL_TOKEN"],
        optional: ["VERCEL_TEAM_ID"],
      }) as VercelCreds);
  }

  // ---------- Team / scope discovery ----------

  async listTeams(): Promise<ListTeamsResponse> {
    try {
      return await fetchJson<ListTeamsResponse>(
        "https://api.vercel.com/v2/teams",
        {
          token: this.creds.VERCEL_TOKEN,
        },
      );
    } catch (err) {
      if (err instanceof AuthError) {
        throw new AuthError(
          "Vercel rejected the token. Check VERCEL_TOKEN.",
          { detail: err.detail, cause: err },
        );
      }
      throw err;
    }
  }

  private async getTeams(): Promise<VercelTeam[]> {
    if (this.teamsCache !== null) return this.teamsCache;
    const res = await this.listTeams();
    this.teamsCache = res.teams ?? [];
    return this.teamsCache;
  }

  async discoverScopes(): Promise<TeamScope[]> {
    if (this.scopesCache !== null) return this.scopesCache;
    const override = this.creds.VERCEL_TEAM_ID;
    if (override) {
      // Try to resolve slug from /v2/teams; fall back to id-as-slug if absent.
      let slug = override;
      try {
        const teams = await this.getTeams();
        const found = teams.find((t) => t.id === override);
        if (found) slug = found.slug;
      } catch {
        // Non-fatal: keep id as slug.
      }
      this.scopesCache = [{ kind: "team", id: override, slug }];
      return this.scopesCache;
    }
    const teams = await this.getTeams();
    this.scopesCache = [
      { kind: "personal" },
      ...teams.map<TeamScope>((t) => ({
        kind: "team",
        id: t.id,
        slug: t.slug,
      })),
    ];
    return this.scopesCache;
  }

  // ---------- Project listing ----------

  async listProjectsRaw(
    scope: TeamScope,
    opts: ListProjectsOptions = {},
  ): Promise<ListProjectsResponse> {
    const searchParams: Record<string, string | number | undefined> = {
      limit: opts.limit,
      until: opts.until,
    };
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;

    try {
      return await fetchJson<ListProjectsResponse>(
        "https://api.vercel.com/v9/projects",
        {
          token: this.creds.VERCEL_TOKEN,
          searchParams,
        },
      );
    } catch (err) {
      if (err instanceof AuthError) {
        throw new AuthError(
          "Vercel rejected the token. Check VERCEL_TOKEN.",
          { detail: err.detail, cause: err },
        );
      }
      throw err;
    }
  }

  async listAllProjects(
    opts: ListProjectsOptions = {},
  ): Promise<ListAllProjectsResponse> {
    const scopes = await this.discoverScopes();
    const seen = new Set<string>();
    const tagged: TaggedProject[] = [];
    for (const scope of scopes) {
      const { projects } = await this.listProjectsRaw(scope, opts);
      const team = scopeLabel(scope);
      for (const raw of projects) {
        const p = raw as VercelProject;
        const id = p.id;
        if (typeof id === "string" && seen.has(id)) continue;
        if (typeof id === "string") seen.add(id);
        tagged.push({ ...p, team });
      }
    }
    return { projects: tagged, count: tagged.length };
  }

  // Back-compat: the same shape as before, but `projects` entries now also
  // carry a `team` field. Tools call this method.
  async listProjects(
    opts: ListProjectsOptions = {},
  ): Promise<ListAllProjectsResponse> {
    return this.listAllProjects(opts);
  }

  // ---------- Project resolution (name/id -> scope) ----------

  // Paginate a single scope fully so project resolution is not truncated at the
  // first 100. Vercel's /v9/projects pagination returns `next` as a timestamp to
  // pass back as `until`; a page cap guards against a pathological loop.
  private async collectProjectsForScope(
    scope: TeamScope,
  ): Promise<VercelProject[]> {
    const out: VercelProject[] = [];
    let until: number | undefined;
    for (let page = 0; page < 25; page++) {
      const res = await this.listProjectsRaw(scope, { limit: 100, until });
      for (const raw of res.projects) out.push(raw as VercelProject);
      const next = res.pagination?.next;
      if (next === null || next === undefined) break;
      const asNum = typeof next === "number" ? next : Number(next);
      if (!Number.isFinite(asNum)) break;
      until = asNum;
    }
    return out;
  }

  private async populateProjectMap(): Promise<void> {
    const scopes = await this.discoverScopes();
    const map = new Map<string, { project: VercelProject; scope: TeamScope }>();
    const idMap = new Map<string, { project: VercelProject; scope: TeamScope }>();
    const nameScopes = new Map<
      string,
      Array<{ project: VercelProject; scope: TeamScope }>
    >();
    for (const scope of scopes) {
      const projects = await this.collectProjectsForScope(scope);
      for (const p of projects) {
        const entry = { project: p, scope };
        if (typeof p.id === "string") {
          if (!idMap.has(p.id)) idMap.set(p.id, entry);
          if (!map.has(p.id)) map.set(p.id, entry);
        }
        if (typeof p.name === "string") {
          if (!map.has(p.name)) map.set(p.name, entry);
          const arr = nameScopes.get(p.name);
          if (arr) arr.push(entry);
          else nameScopes.set(p.name, [entry]);
        }
      }
    }
    this.projectScopeMap = map;
    this.projectIdScopeMap = idMap;
    this.projectNameScopeMap = nameScopes;
  }

  async resolveProject(
    idOrName: string,
  ): Promise<{ project: VercelProject; scope: TeamScope }> {
    if (this.projectScopeMap === null) {
      await this.populateProjectMap();
    }
    let hit = this.projectScopeMap!.get(idOrName);
    if (hit) return hit;

    // Refresh once: maybe a newly-created project.
    await this.populateProjectMap();
    hit = this.projectScopeMap!.get(idOrName);
    if (hit) return hit;

    throw new NotFoundError(
      `Project not found across all teams: ${idOrName}`,
    );
  }

  /**
   * Strict resolver for writes (M5). An exact project-id match is globally unique
   * and always safe. A NAME that matches projects in more than one scope throws
   * AmbiguousMatchError listing the candidate teams, so a mutation never silently
   * hits the wrong team — the caller must pass the unique id to disambiguate.
   */
  async resolveProjectStrict(
    idOrName: string,
  ): Promise<{ project: VercelProject; scope: TeamScope }> {
    if (this.projectScopeMap === null) {
      await this.populateProjectMap();
    }
    const byId = this.projectIdScopeMap!.get(idOrName);
    if (byId) return byId;

    let entries = this.projectNameScopeMap!.get(idOrName);
    if (!entries || entries.length === 0) {
      // Refresh once: maybe a newly-created project.
      await this.populateProjectMap();
      const refreshedById = this.projectIdScopeMap!.get(idOrName);
      if (refreshedById) return refreshedById;
      entries = this.projectNameScopeMap!.get(idOrName);
    }

    if (!entries || entries.length === 0) {
      throw new NotFoundError(
        `Project not found across all teams: ${idOrName}`,
      );
    }
    if (entries.length > 1) {
      throw new AmbiguousMatchError(
        `Project name '${idOrName}' exists in ${entries.length} teams — pass the unique project id to disambiguate this write.`,
        {
          candidates: entries.map((e) => ({
            score: 1,
            label: `${idOrName} in ${scopeLabel(e.scope)}`,
            id: typeof e.project.id === "string" ? e.project.id : undefined,
          })),
        },
      );
    }
    return entries[0]!;
  }

  /**
   * Resolve a project for a WRITE: strict resolution (M5 — refuses ambiguous
   * cross-team names) plus a team deny-list check so no mutation ever lands on a
   * protected team's project (default: example-denied-team). Read paths keep using
   * resolveProjectStrict directly, so reads of a denied team still work.
   */
  async resolveProjectStrictForWrite(
    idOrName: string,
  ): Promise<{ project: VercelProject; scope: TeamScope }> {
    const resolved = await this.resolveProjectStrict(idOrName);
    const slug = resolved.scope.kind === "team" ? resolved.scope.slug : null;
    assertTeamWritable(slug, idOrName);
    return resolved;
  }

  /**
   * Issues a mutation whose successful response carries NO body — Vercel returns
   * an empty 200/201/202 for pause / unpause / promote. Core's fetchJson always
   * calls response.json(), which throws on an empty body (it only special-cases
   * 204), so those endpoints cannot go through it. This mirrors fetchJson's auth
   * and error mapping but treats any 2xx as success and never retries (a 5xx that
   * actually succeeded must not be replayed into a duplicate prod mutation, M2).
   */
  private async requestNoBody(
    url: string,
    opts: {
      method: "POST";
      searchParams?: Record<string, string | number | undefined>;
    },
  ): Promise<void> {
    const finalUrl = withSearch(url, opts.searchParams);
    let res: Response;
    try {
      res = await fetch(finalUrl, {
        method: opts.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.creds.VERCEL_TOKEN}`,
        },
      });
    } catch (err) {
      throw new UpstreamError(
        `Network failure: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (res.ok) return;
    const detail = await res.text().catch(() => "");
    const message = `${opts.method} ${finalUrl} → ${res.status}`;
    switch (res.status) {
      case 400:
        throw new ValidationError(message, { detail });
      case 401:
        throw new AuthError("Vercel rejected the token. Check VERCEL_TOKEN.", {
          detail,
        });
      case 403:
        throw new PermissionError(message, { detail });
      case 404:
        throw new NotFoundError(message, { detail });
      case 429:
        throw new RateLimitError(message, { detail });
      default:
        throw new UpstreamError(message, { detail });
    }
  }

  // ---------- Domain ops ----------

  async listProjectDomains(
    idOrName: string,
  ): Promise<ListProjectDomainsResponse> {
    const { scope } = await this.resolveProject(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;

    try {
      return await fetchJson<ListProjectDomainsResponse>(
        `https://api.vercel.com/v9/projects/${encodeURIComponent(idOrName)}/domains`,
        {
          token: this.creds.VERCEL_TOKEN,
          searchParams,
        },
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(`Project not found: ${idOrName}`, {
          detail: err.detail,
          cause: err,
        });
      }
      throw err;
    }
  }

  async updateProjectDomain(
    idOrName: string,
    domain: string,
    body: UpdateProjectDomainBody,
  ): Promise<ProjectDomain> {
    const { scope } = await this.resolveProject(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<ProjectDomain>(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(idOrName)}/domains/${encodeURIComponent(domain)}`,
      {
        method: "PATCH",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
        body,
      },
    );
  }

  // ---------- Deployments ----------

  async listDeployments(
    opts: ListDeploymentsOptions = {},
  ): Promise<ListDeploymentsResponse> {
    const searchParams: Record<string, string | number | undefined> = {
      projectId: opts.projectId,
      limit: opts.limit,
    };

    let teamId: string | undefined;
    if (opts.projectId) {
      // Look up project to determine scope. If it can't be resolved we fall
      // back to the override (if any) so callers that pass an unknown id
      // still get a sensible request shape.
      try {
        const { scope } = await this.resolveProject(opts.projectId);
        teamId = scopeTeamId(scope);
      } catch {
        teamId = this.creds.VERCEL_TEAM_ID;
      }
    } else if (this.creds.VERCEL_TEAM_ID) {
      teamId = this.creds.VERCEL_TEAM_ID;
    }

    if (teamId) searchParams.teamId = teamId;

    try {
      return await fetchJson<ListDeploymentsResponse>(
        "https://api.vercel.com/v7/deployments",
        {
          token: this.creds.VERCEL_TOKEN,
          searchParams,
        },
      );
    } catch (err) {
      if (err instanceof AuthError) {
        throw new AuthError(
          "Vercel rejected the token. Check VERCEL_TOKEN.",
          { detail: err.detail, cause: err },
        );
      }
      throw err;
    }
  }

  // ---------- Env vars ----------

  async listProjectEnv(
    idOrName: string,
    opts: ListProjectEnvOptions = {},
  ): Promise<ListProjectEnvResponse> {
    const { scope } = await this.resolveProjectStrict(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    if (opts.decrypt) searchParams.decrypt = "true";
    if (opts.gitBranch) searchParams.gitBranch = opts.gitBranch;
    return await fetchJson<ListProjectEnvResponse>(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(idOrName)}/env`,
      {
        token: this.creds.VERCEL_TOKEN,
        searchParams,
      },
    );
  }

  async revealProjectEnv(
    idOrName: string,
    envId: string,
  ): Promise<ProjectEnv> {
    const { scope } = await this.resolveProjectStrict(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<ProjectEnv>(
      `https://api.vercel.com/v1/projects/${encodeURIComponent(idOrName)}/env/${encodeURIComponent(envId)}`,
      {
        token: this.creds.VERCEL_TOKEN,
        searchParams,
      },
    );
  }

  async upsertProjectEnv(
    idOrName: string,
    body: UpsertProjectEnvBody | UpsertProjectEnvBody[],
  ): Promise<Record<string, unknown>> {
    const { scope } = await this.resolveProjectStrictForWrite(idOrName);
    const searchParams: Record<string, string | number | undefined> = {
      upsert: "true",
    };
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<Record<string, unknown>>(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(idOrName)}/env`,
      {
        method: "POST",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
        body,
        retries: 0,
      },
    );
  }

  async updateProjectEnv(
    idOrName: string,
    envId: string,
    body: UpdateProjectEnvBody,
  ): Promise<ProjectEnv> {
    const { scope } = await this.resolveProjectStrictForWrite(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<ProjectEnv>(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(idOrName)}/env/${encodeURIComponent(envId)}`,
      {
        method: "PATCH",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
        body,
      },
    );
  }

  async deleteProjectEnv(
    idOrName: string,
    envId: string,
  ): Promise<unknown> {
    const { scope } = await this.resolveProjectStrictForWrite(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<unknown>(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(idOrName)}/env/${encodeURIComponent(envId)}`,
      {
        method: "DELETE",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
      },
    );
  }

  // ---------- Domains (mutations) ----------

  async addProjectDomain(
    idOrName: string,
    body: AddProjectDomainBody,
  ): Promise<ProjectDomain> {
    const { scope } = await this.resolveProjectStrictForWrite(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<ProjectDomain>(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(idOrName)}/domains`,
      {
        method: "POST",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
        body,
        retries: 0,
      },
    );
  }

  async verifyProjectDomain(
    idOrName: string,
    domain: string,
  ): Promise<Record<string, unknown>> {
    const { scope } = await this.resolveProjectStrictForWrite(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<Record<string, unknown>>(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(idOrName)}/domains/${encodeURIComponent(domain)}/verify`,
      {
        method: "POST",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
      },
    );
  }

  async removeProjectDomain(
    idOrName: string,
    domain: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const { scope } = await this.resolveProjectStrictForWrite(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<unknown>(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(idOrName)}/domains/${encodeURIComponent(domain)}`,
      {
        method: "DELETE",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
        body,
      },
    );
  }

  // ---------- Deployments (get / logs / lifecycle) ----------

  // Deployment-scoped reads take an explicit project so the correct teamId is
  // derived via strict resolution (M5); a deployment id alone can't tell us the
  // team.
  async getDeployment(
    idOrUrl: string,
    opts: { project: string },
  ): Promise<Record<string, unknown>> {
    const { scope } = await this.resolveProjectStrict(opts.project);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<Record<string, unknown>>(
      `https://api.vercel.com/v13/deployments/${encodeURIComponent(idOrUrl)}`,
      {
        token: this.creds.VERCEL_TOKEN,
        searchParams,
      },
    );
  }

  async getDeploymentEvents(
    idOrUrl: string,
    opts: { project: string },
  ): Promise<unknown> {
    const { scope } = await this.resolveProjectStrict(opts.project);
    const searchParams: Record<string, string | number | undefined> = {
      follow: 0,
    };
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<unknown>(
      `https://api.vercel.com/v3/deployments/${encodeURIComponent(idOrUrl)}/events`,
      {
        token: this.creds.VERCEL_TOKEN,
        searchParams,
      },
    );
  }

  // Non-idempotent create — retries:0 so a 5xx-that-succeeded is never replayed
  // into a duplicate deployment (M2). The caller resolves the project strictly
  // and passes the derived teamId.
  async createDeployment(
    body: CreateDeploymentBody,
    opts: { teamId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const searchParams: Record<string, string | number | undefined> = {};
    if (opts.teamId) searchParams.teamId = opts.teamId;
    return await fetchJson<Record<string, unknown>>(
      "https://api.vercel.com/v13/deployments",
      {
        method: "POST",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
        body,
        retries: 0,
      },
    );
  }

  // Empty 201/202 body -> requestNoBody; non-idempotent -> never retried (M2).
  async promoteDeployment(
    projectId: string,
    deploymentId: string,
  ): Promise<void> {
    const { scope } = await this.resolveProjectStrictForWrite(projectId);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    await this.requestNoBody(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`,
      { method: "POST", searchParams },
    );
  }

  async cancelDeployment(
    id: string,
    opts: { teamId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const searchParams: Record<string, string | number | undefined> = {};
    if (opts.teamId) searchParams.teamId = opts.teamId;
    return await fetchJson<Record<string, unknown>>(
      `https://api.vercel.com/v12/deployments/${encodeURIComponent(id)}/cancel`,
      {
        method: "PATCH",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
      },
    );
  }

  async deleteDeployment(
    id: string,
    opts: { teamId?: string } = {},
  ): Promise<unknown> {
    const searchParams: Record<string, string | number | undefined> = {};
    if (opts.teamId) searchParams.teamId = opts.teamId;
    return await fetchJson<unknown>(
      `https://api.vercel.com/v13/deployments/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
      },
    );
  }

  // ---------- Project lifecycle ----------

  async updateProject(
    idOrName: string,
    body: Record<string, unknown>,
  ): Promise<VercelProject> {
    const { scope } = await this.resolveProjectStrictForWrite(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<VercelProject>(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(idOrName)}`,
      {
        method: "PATCH",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
        body,
      },
    );
  }

  async deleteProject(idOrName: string): Promise<unknown> {
    const { scope } = await this.resolveProjectStrictForWrite(idOrName);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    return await fetchJson<unknown>(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(idOrName)}`,
      {
        method: "DELETE",
        token: this.creds.VERCEL_TOKEN,
        searchParams,
      },
    );
  }

  // Empty 200 body -> requestNoBody.
  async pauseProject(projectId: string): Promise<void> {
    const { scope } = await this.resolveProjectStrictForWrite(projectId);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    await this.requestNoBody(
      `https://api.vercel.com/v1/projects/${encodeURIComponent(projectId)}/pause`,
      { method: "POST", searchParams },
    );
  }

  async unpauseProject(projectId: string): Promise<void> {
    const { scope } = await this.resolveProjectStrictForWrite(projectId);
    const searchParams: Record<string, string | number | undefined> = {};
    const teamId = scopeTeamId(scope);
    if (teamId) searchParams.teamId = teamId;
    await this.requestNoBody(
      `https://api.vercel.com/v1/projects/${encodeURIComponent(projectId)}/unpause`,
      { method: "POST", searchParams },
    );
  }
}
