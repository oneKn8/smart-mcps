import { loadCreds, fetchJson, AuthError, NotFoundError } from "smart-mcp-core";

export type RunpodCreds = {
  RUNPOD_API_KEY: string;
  RUNPOD_DEFAULT_GPU?: string;
};

type RunpodCredsRecord = Record<"RUNPOD_API_KEY" | "RUNPOD_DEFAULT_GPU", string>;

// Pod creation body. The Runpod REST API accepts many optional fields
// (see https://rest.runpod.io/v1/openapi.json#/POST /pods). We keep this
// type open so the tool layer can construct the precise wire shape without
// the client having to mirror every field.
export type PodCreateBody = Record<string, unknown>;

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

// Template shape mirrors a useful subset of fields documented in the Runpod
// OpenAPI spec (https://rest.runpod.io/v1/openapi.json#/components/schemas/Template).
// Additional upstream fields (env, dockerEntrypoint, readme, earned, etc.)
// are preserved via the open record extension for forward compatibility.
export type Template = Record<string, unknown> & {
  id: string;
  name?: string;
  imageName?: string;
  containerDiskInGb?: number;
  volumeInGb?: number;
  isServerless?: boolean;
  isPublic?: boolean;
  category?: string;
};

export interface ListTemplatesResponse {
  templates: Template[];
}

// Endpoint shape mirrors a useful subset of fields documented in the Runpod
// OpenAPI spec (https://rest.runpod.io/v1/openapi.json#/components/schemas/Endpoint).
// Additional upstream fields (env, gpuTypeIds, dataCenterIds, networkVolumeId,
// scaler config, workers count, etc.) are preserved via the open record
// extension for forward compatibility.
export type Endpoint = Record<string, unknown> & {
  id: string;
  name?: string;
  templateId?: string;
  workersMin?: number;
  workersMax?: number;
  idleTimeout?: number;
  createdAt?: string;
};

export interface ListEndpointsResponse {
  endpoints: Endpoint[];
}

// Billing record shape per Runpod OpenAPI (BillingRecords, NetworkVolumeBillingRecords).
// `amount` is always denominated in USD. The `podId` / `endpointId` /
// `gpuTypeId` / `time` / `timeBilledMs` / `diskSpaceBilledGb` fields appear
// conditionally based on the resource and `grouping` query param. We expose
// them as an open Record because callers (cost_audit, daily_status) only need
// `amount` + `podId`/`endpointId` keys, and the billing API may add fields
// going forward.
export type BillingRecord = Record<string, unknown> & {
  amount?: number;
  podId?: string;
  endpointId?: string;
  gpuTypeId?: string;
  time?: string;
  timeBilledMs?: number;
  diskSpaceBilledGb?: number;
};

export interface BillingPodsResponse {
  records: BillingRecord[];
}

export interface BillingEndpointsResponse {
  records: BillingRecord[];
}

export interface BillingNetworkVolumesResponse {
  records: BillingRecord[];
}

// Billing window options. Runpod's REST API uses startTime / endTime as ISO
// 8601 date-time query params, but we accept them under more familiar
// `from` / `to` keys at the client surface.
export interface BillingWindow {
  from?: string;
  to?: string;
}

export class RunpodClient {
  private readonly creds: RunpodCreds;

  constructor(creds?: RunpodCreds) {
    this.creds =
      creds ??
      (loadCreds<RunpodCredsRecord>({
        serviceName: "runpod-smart",
        required: ["RUNPOD_API_KEY"],
        optional: ["RUNPOD_DEFAULT_GPU"],
      }) as RunpodCreds);
  }

  // The optional default GPU id used when callers don't specify one.
  // Resolution order in tools is: explicit input → this getter → hardcoded
  // fallback constant. Exposed as a getter (rather than the full creds
  // record) so the API key never leaks out of the client.
  get defaultGpu(): string | undefined {
    return this.creds.RUNPOD_DEFAULT_GPU;
  }

  // ---------- Pod listing ----------

  async listPods(opts: ListPodsOptions = {}): Promise<ListPodsResponse> {
    const searchParams: Record<string, string | number | undefined> = {
      desiredStatus: opts.desiredStatus,
    };

    try {
      // Runpod's GET /pods returns a bare array; we wrap to {pods} for
      // ergonomic downstream consumption.
      const body = await fetchJson<Pod[]>(
        "https://rest.runpod.io/v1/pods",
        {
          token: this.creds.RUNPOD_API_KEY,
          searchParams,
        },
      );
      return { pods: body };
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

  // ---------- Template + endpoint listing ----------

  async listTemplates(): Promise<ListTemplatesResponse> {
    try {
      // Runpod's GET /templates returns a bare array; wrap to {templates}
      // for consistency with listPods/listEndpoints.
      const body = await fetchJson<Template[]>(
        "https://rest.runpod.io/v1/templates",
        { token: this.creds.RUNPOD_API_KEY },
      );
      return { templates: body };
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

  async listEndpoints(): Promise<ListEndpointsResponse> {
    try {
      // Runpod's GET /endpoints returns a bare array; wrap to {endpoints}
      // for consistency with listPods/listTemplates.
      const body = await fetchJson<Endpoint[]>(
        "https://rest.runpod.io/v1/endpoints",
        { token: this.creds.RUNPOD_API_KEY },
      );
      return { endpoints: body };
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

  // ---------- Billing ----------
  //
  // All three endpoints return a bare array of BillingRecord per the Runpod
  // OpenAPI spec. We wrap as { records } for symmetry with other listing
  // methods. `from`/`to` map to `startTime`/`endTime` query params.

  async getBillingPods(window: BillingWindow = {}): Promise<BillingPodsResponse> {
    return this.fetchBilling(
      "https://rest.runpod.io/v1/billing/pods",
      window,
    );
  }

  async getBillingEndpoints(
    window: BillingWindow = {},
  ): Promise<BillingEndpointsResponse> {
    return this.fetchBilling(
      "https://rest.runpod.io/v1/billing/endpoints",
      window,
    );
  }

  async getBillingNetworkVolumes(
    window: BillingWindow = {},
  ): Promise<BillingNetworkVolumesResponse> {
    return this.fetchBilling(
      "https://rest.runpod.io/v1/billing/networkvolumes",
      window,
    );
  }

  private async fetchBilling(
    url: string,
    window: BillingWindow,
  ): Promise<{ records: BillingRecord[] }> {
    const searchParams: Record<string, string | number | undefined> = {
      startTime: window.from,
      endTime: window.to,
    };
    try {
      const body = await fetchJson<BillingRecord[]>(url, {
        token: this.creds.RUNPOD_API_KEY,
        searchParams,
      });
      return { records: body };
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

  // ---------- Pod creation ----------

  async createPod(body: PodCreateBody): Promise<Pod> {
    try {
      return await fetchJson<Pod>("https://rest.runpod.io/v1/pods", {
        method: "POST",
        token: this.creds.RUNPOD_API_KEY,
        body,
      });
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

  // ---------- Single-pod operations ----------

  async getPod(podId: string): Promise<Pod> {
    const url = `https://rest.runpod.io/v1/pods/${encodeURIComponent(podId)}`;
    try {
      return await fetchJson<Pod>(url, {
        token: this.creds.RUNPOD_API_KEY,
      });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  async startPod(podId: string): Promise<Pod> {
    const url = `https://rest.runpod.io/v1/pods/${encodeURIComponent(podId)}/start`;
    try {
      return await fetchJson<Pod>(url, {
        method: "POST",
        token: this.creds.RUNPOD_API_KEY,
      });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  async stopPod(podId: string): Promise<Pod> {
    const url = `https://rest.runpod.io/v1/pods/${encodeURIComponent(podId)}/stop`;
    try {
      return await fetchJson<Pod>(url, {
        method: "POST",
        token: this.creds.RUNPOD_API_KEY,
      });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  async terminatePod(podId: string): Promise<void> {
    const url = `https://rest.runpod.io/v1/pods/${encodeURIComponent(podId)}`;
    try {
      // Runpod returns 204 No Content on successful delete; fetchJson maps
      // 204 to `undefined`. We explicitly drop the body either way.
      await fetchJson<unknown>(url, {
        method: "DELETE",
        token: this.creds.RUNPOD_API_KEY,
      });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  // Wraps fetchJson errors raised by single-pod endpoints into our public
  // contract: 404 → NotFoundError("Pod not found: <id>"), 401/403 → AuthError
  // hinting at RUNPOD_API_KEY. All other errors pass through unchanged.
  private mapPodError(err: unknown, podId: string): unknown {
    if (err instanceof NotFoundError) {
      return new NotFoundError(`Pod not found: ${podId}`, {
        detail: err.detail,
        cause: err,
      });
    }
    if (err instanceof AuthError) {
      return new AuthError(
        "Runpod rejected the API key. Check RUNPOD_API_KEY.",
        { detail: err.detail, cause: err },
      );
    }
    return err;
  }
}
