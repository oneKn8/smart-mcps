import { loadCreds, fetchJson, AuthError } from "smart-mcp-core";

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
}
