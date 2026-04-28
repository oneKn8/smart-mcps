import { loadCreds, fetchJson, AuthError } from "smart-mcp-core";

export type RunpodCreds = {
  RUNPOD_API_KEY: string;
};

type RunpodCredsRecord = Record<"RUNPOD_API_KEY", string>;

// Pod shape mirrors a useful subset of fields documented in the Runpod
// OpenAPI spec (https://rest.runpod.io/v1/openapi.json). The wire payload may
// carry additional properties, so we keep an open `Record<string, unknown>`
// extension for forward compatibility.
export type Pod = Record<string, unknown> & {
  id: string;
  name?: string;
  image?: string;
  desiredStatus?: string;
  costPerHr?: number;
  adjustedCostPerHr?: number;
  gpu?: { displayName?: string } & Record<string, unknown>;
  lastStartedAt?: string;
};

export interface ListPodsResponse {
  pods: Pod[];
}

export interface ListPodsOptions {
  desiredStatus?: string;
}

export class RunpodClient {
  private readonly creds: RunpodCreds;

  constructor(creds?: RunpodCreds) {
    this.creds =
      creds ??
      (loadCreds<RunpodCredsRecord>({
        serviceName: "runpod-smart",
        required: ["RUNPOD_API_KEY"],
      }) as RunpodCreds);
  }

  // ---------- Pod listing ----------

  async listPods(opts: ListPodsOptions = {}): Promise<ListPodsResponse> {
    const searchParams: Record<string, string | number | undefined> = {
      desiredStatus: opts.desiredStatus,
    };

    try {
      // Runpod's GET /v1/pods returns a bare Pod[] array per OpenAPI spec.
      // We normalize to { pods: Pod[] } so tools can rely on a stable shape.
      const body = await fetchJson<Pod[] | ListPodsResponse>(
        "https://rest.runpod.io/v1/pods",
        {
          token: this.creds.RUNPOD_API_KEY,
          searchParams,
        },
      );
      if (Array.isArray(body)) return { pods: body };
      return body;
    } catch (err) {
      if (err instanceof AuthError) {
        throw new AuthError(
          "Runpod rejected the API key. Check RUNPOD_API_KEY.",
          { detail: err.detail, cause: err },
        );
      }
      throw err;
    }
  }
}
