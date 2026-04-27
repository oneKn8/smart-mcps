import { loadCreds, fetchJson, AuthError, NotFoundError } from "smart-mcp-core";

export type VercelCreds = {
  VERCEL_TOKEN: string;
  VERCEL_TEAM_ID?: string;
};

type VercelCredsRecord = Record<"VERCEL_TOKEN" | "VERCEL_TEAM_ID", string>;

export interface ListProjectsResponse {
  projects: Array<Record<string, unknown>>;
  pagination: { count: number; next: string | null };
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

export class VercelClient {
  private readonly creds: VercelCreds;

  constructor(creds?: VercelCreds) {
    this.creds =
      creds ??
      (loadCreds<VercelCredsRecord>({
        serviceName: "vercel-smart",
        required: ["VERCEL_TOKEN"],
        optional: ["VERCEL_TEAM_ID"],
      }) as VercelCreds);
  }

  async listProjects(opts: ListProjectsOptions = {}): Promise<ListProjectsResponse> {
    const searchParams: Record<string, string | number | undefined> = {
      limit: opts.limit,
    };
    if (this.creds.VERCEL_TEAM_ID) {
      searchParams.teamId = this.creds.VERCEL_TEAM_ID;
    }

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

  async listProjectDomains(idOrName: string): Promise<ListProjectDomainsResponse> {
    const searchParams: Record<string, string | number | undefined> = {};
    if (this.creds.VERCEL_TEAM_ID) {
      searchParams.teamId = this.creds.VERCEL_TEAM_ID;
    }

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
}
