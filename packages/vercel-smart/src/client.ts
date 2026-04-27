import { loadCreds, fetchJson, AuthError, NotFoundError } from "smart-mcp-core";

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

export class VercelClient {
  private readonly creds: VercelCreds;
  private teamsCache: VercelTeam[] | null = null;
  private scopesCache: TeamScope[] | null = null;
  private projectScopeMap: Map<string, { project: VercelProject; scope: TeamScope }> | null = null;

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

  private async populateProjectMap(): Promise<void> {
    const scopes = await this.discoverScopes();
    const map = new Map<string, { project: VercelProject; scope: TeamScope }>();
    for (const scope of scopes) {
      const { projects } = await this.listProjectsRaw(scope, { limit: 100 });
      for (const raw of projects) {
        const p = raw as VercelProject;
        const entry = { project: p, scope };
        if (typeof p.id === "string" && !map.has(p.id)) {
          map.set(p.id, entry);
        }
        if (typeof p.name === "string" && !map.has(p.name)) {
          map.set(p.name, entry);
        }
      }
    }
    this.projectScopeMap = map;
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
        "https://api.vercel.com/v6/deployments",
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
}
