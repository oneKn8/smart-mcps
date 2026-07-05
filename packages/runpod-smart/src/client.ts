import {
  loadCreds,
  fetchJson,
  AuthError,
  NotFoundError,
  UpstreamError,
} from "smart-mcp-core";

// Runpod exposes three separate hosts, all authenticated with the same
// `Authorization: Bearer ${RUNPOD_API_KEY}`:
//   - REST:      pod/template/endpoint/volume/registry management + billing
//   - INFERENCE: serverless job submission + status (api.runpod.ai/v2/{id}/...)
//   - GRAPHQL:   the only surface exposing GPU pricing + account balance
const REST_BASE = "https://rest.runpod.io/v1";
const INFERENCE_BASE = "https://api.runpod.ai/v2";
const GRAPHQL_URL = "https://api.runpod.io/graphql";

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
export type PodUpdateBody = Record<string, unknown>;

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

export type TemplateBody = Record<string, unknown>;

export interface ListTemplatesResponse {
  templates: Template[];
}

export interface GetTemplateOptions {
  includePublic?: boolean;
  includeRunpod?: boolean;
  includeEndpointBound?: boolean;
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

export type EndpointBody = Record<string, unknown>;

export interface ListEndpointsResponse {
  endpoints: Endpoint[];
}

export interface GetEndpointOptions {
  includeTemplate?: boolean;
  includeWorkers?: boolean;
}

// Network volume shape per Runpod OpenAPI (NetworkVolume schema).
export type NetworkVolume = Record<string, unknown> & {
  id: string;
  name?: string;
  size?: number;
  dataCenterId?: string;
};

export interface ListNetworkVolumesResponse {
  networkVolumes: NetworkVolume[];
}

export interface NetworkVolumeCreateBody {
  name: string;
  size: number;
  dataCenterId: string;
}

export interface NetworkVolumeUpdateBody {
  name?: string;
  size?: number;
}

// Container registry auth. The upstream response deliberately returns only
// `{ id, name }` — the username/password are write-only and never echoed.
export type RegistryAuth = Record<string, unknown> & {
  id: string;
  name?: string;
};

export interface ListRegistryAuthsResponse {
  registryAuths: RegistryAuth[];
}

export interface RegistryAuthCreateBody {
  name: string;
  username: string;
  password: string;
}

// Serverless inference job status (api.runpod.ai/v2/{id}/...). Shapes come
// from the Runpod serverless docs, not the REST OpenAPI spec.
export type JobStatus = Record<string, unknown> & {
  id?: string;
  status?: string;
  output?: unknown;
  delayTime?: number;
  executionTime?: number;
};

export type EndpointHealth = Record<string, unknown> & {
  jobs?: Record<string, number>;
  workers?: Record<string, number>;
};

export interface PurgeQueueResult {
  removed?: number;
  status?: string;
}

export interface RunExtra {
  webhook?: string;
}

// GraphQL-only shapes: pricing + balance.
export interface GpuTypeLowestPrice {
  minimumBidPrice?: number | null;
  uninterruptablePrice?: number | null;
}

export interface GpuType {
  id: string;
  displayName?: string;
  memoryInGb?: number;
  secureCloud?: boolean;
  communityCloud?: boolean;
  securePrice?: number | null;
  communityPrice?: number | null;
  lowestPrice?: GpuTypeLowestPrice | null;
}

export interface Balance {
  id?: string;
  clientBalance?: number;
  currentSpendPerHr?: number;
  spendLimit?: number;
  minBalance?: number;
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

  private get token(): string {
    return this.creds.RUNPOD_API_KEY;
  }

  // Wraps an AuthError with a credential-name-bearing message. Non-auth errors
  // pass through unchanged. Used by list/create methods that have no id.
  private wrapAuth(err: unknown): unknown {
    if (err instanceof AuthError) {
      return new AuthError("Runpod rejected the API key. Check RUNPOD_API_KEY.", {
        detail: err.detail,
        cause: err,
      });
    }
    return err;
  }

  // Wraps fetchJson errors from single-resource endpoints: 404 →
  // NotFoundError("<Kind> not found: <id>"), 401/403 → AuthError hinting at
  // RUNPOD_API_KEY. All other errors pass through unchanged.
  private mapResourceError(err: unknown, kind: string, id: string): unknown {
    if (err instanceof NotFoundError) {
      return new NotFoundError(`${kind} not found: ${id}`, {
        detail: err.detail,
        cause: err,
      });
    }
    return this.wrapAuth(err);
  }

  // Back-compat shim for the original pod-specific mapper.
  private mapPodError(err: unknown, podId: string): unknown {
    return this.mapResourceError(err, "Pod", podId);
  }

  // ---------- Pod listing ----------

  async listPods(opts: ListPodsOptions = {}): Promise<ListPodsResponse> {
    const searchParams: Record<string, string | number | undefined> = {
      desiredStatus: opts.desiredStatus,
    };

    try {
      // Runpod's GET /pods returns a bare array; we wrap to {pods} for
      // ergonomic downstream consumption.
      const body = await fetchJson<Pod[]>(`${REST_BASE}/pods`, {
        token: this.token,
        searchParams,
      });
      return { pods: body };
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  // ---------- Template + endpoint listing ----------

  async listTemplates(): Promise<ListTemplatesResponse> {
    try {
      // Runpod's GET /templates returns a bare array; wrap to {templates}
      // for consistency with listPods/listEndpoints.
      const body = await fetchJson<Template[]>(`${REST_BASE}/templates`, {
        token: this.token,
      });
      return { templates: body };
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  async listEndpoints(): Promise<ListEndpointsResponse> {
    try {
      // Runpod's GET /endpoints returns a bare array; wrap to {endpoints}
      // for consistency with listPods/listTemplates.
      const body = await fetchJson<Endpoint[]>(`${REST_BASE}/endpoints`, {
        token: this.token,
      });
      return { endpoints: body };
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  // ---------- Billing ----------
  //
  // All three endpoints return a bare array of BillingRecord per the Runpod
  // OpenAPI spec. We wrap as { records } for symmetry with other listing
  // methods. `from`/`to` map to `startTime`/`endTime` query params.

  async getBillingPods(window: BillingWindow = {}): Promise<BillingPodsResponse> {
    return this.fetchBilling(`${REST_BASE}/billing/pods`, window);
  }

  async getBillingEndpoints(
    window: BillingWindow = {},
  ): Promise<BillingEndpointsResponse> {
    return this.fetchBilling(`${REST_BASE}/billing/endpoints`, window);
  }

  async getBillingNetworkVolumes(
    window: BillingWindow = {},
  ): Promise<BillingNetworkVolumesResponse> {
    return this.fetchBilling(`${REST_BASE}/billing/networkvolumes`, window);
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
        token: this.token,
        searchParams,
      });
      return { records: body };
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  // ---------- Pod creation + mutation ----------

  async createPod(body: PodCreateBody): Promise<Pod> {
    try {
      return await fetchJson<Pod>(`${REST_BASE}/pods`, {
        method: "POST",
        token: this.token,
        body,
      });
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  async updatePod(podId: string, body: PodUpdateBody): Promise<Pod> {
    const url = `${REST_BASE}/pods/${encodeURIComponent(podId)}`;
    try {
      return await fetchJson<Pod>(url, {
        method: "PATCH",
        token: this.token,
        body,
      });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  // ---------- Single-pod operations ----------

  async getPod(podId: string): Promise<Pod> {
    const url = `${REST_BASE}/pods/${encodeURIComponent(podId)}`;
    try {
      return await fetchJson<Pod>(url, { token: this.token });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  async startPod(podId: string): Promise<Pod> {
    const url = `${REST_BASE}/pods/${encodeURIComponent(podId)}/start`;
    try {
      return await fetchJson<Pod>(url, { method: "POST", token: this.token });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  async stopPod(podId: string): Promise<Pod> {
    const url = `${REST_BASE}/pods/${encodeURIComponent(podId)}/stop`;
    try {
      return await fetchJson<Pod>(url, { method: "POST", token: this.token });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  async restartPod(podId: string): Promise<void> {
    const url = `${REST_BASE}/pods/${encodeURIComponent(podId)}/restart`;
    try {
      await fetchJson<unknown>(url, { method: "POST", token: this.token });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  async resetPod(podId: string): Promise<void> {
    const url = `${REST_BASE}/pods/${encodeURIComponent(podId)}/reset`;
    try {
      await fetchJson<unknown>(url, { method: "POST", token: this.token });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  async terminatePod(podId: string): Promise<void> {
    const url = `${REST_BASE}/pods/${encodeURIComponent(podId)}`;
    try {
      // Runpod returns 204 No Content on successful delete; fetchJson maps
      // 204 to `undefined`. We explicitly drop the body either way.
      await fetchJson<unknown>(url, { method: "DELETE", token: this.token });
    } catch (err) {
      throw this.mapPodError(err, podId);
    }
  }

  // ---------- Templates CRUD ----------

  async createTemplate(body: TemplateBody): Promise<Template> {
    try {
      return await fetchJson<Template>(`${REST_BASE}/templates`, {
        method: "POST",
        token: this.token,
        body,
      });
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  async getTemplate(
    templateId: string,
    opts: GetTemplateOptions = {},
  ): Promise<Template> {
    const url = `${REST_BASE}/templates/${encodeURIComponent(templateId)}`;
    const searchParams: Record<string, boolean | undefined> = {
      includePublicTemplates: opts.includePublic,
      includeRunpodTemplates: opts.includeRunpod,
      includeEndpointBoundTemplates: opts.includeEndpointBound,
    };
    try {
      return await fetchJson<Template>(url, { token: this.token, searchParams });
    } catch (err) {
      throw this.mapResourceError(err, "Template", templateId);
    }
  }

  async updateTemplate(templateId: string, body: TemplateBody): Promise<Template> {
    const url = `${REST_BASE}/templates/${encodeURIComponent(templateId)}`;
    try {
      return await fetchJson<Template>(url, {
        method: "PATCH",
        token: this.token,
        body,
      });
    } catch (err) {
      throw this.mapResourceError(err, "Template", templateId);
    }
  }

  async deleteTemplate(templateId: string): Promise<void> {
    const url = `${REST_BASE}/templates/${encodeURIComponent(templateId)}`;
    try {
      await fetchJson<unknown>(url, { method: "DELETE", token: this.token });
    } catch (err) {
      throw this.mapResourceError(err, "Template", templateId);
    }
  }

  // ---------- Endpoints CRUD ----------

  async createEndpoint(body: EndpointBody): Promise<Endpoint> {
    try {
      return await fetchJson<Endpoint>(`${REST_BASE}/endpoints`, {
        method: "POST",
        token: this.token,
        body,
      });
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  async getEndpoint(
    endpointId: string,
    opts: GetEndpointOptions = {},
  ): Promise<Endpoint> {
    const url = `${REST_BASE}/endpoints/${encodeURIComponent(endpointId)}`;
    const searchParams: Record<string, boolean | undefined> = {
      includeTemplate: opts.includeTemplate,
      includeWorkers: opts.includeWorkers,
    };
    try {
      return await fetchJson<Endpoint>(url, { token: this.token, searchParams });
    } catch (err) {
      throw this.mapResourceError(err, "Endpoint", endpointId);
    }
  }

  async updateEndpoint(endpointId: string, body: EndpointBody): Promise<Endpoint> {
    const url = `${REST_BASE}/endpoints/${encodeURIComponent(endpointId)}`;
    try {
      return await fetchJson<Endpoint>(url, {
        method: "PATCH",
        token: this.token,
        body,
      });
    } catch (err) {
      throw this.mapResourceError(err, "Endpoint", endpointId);
    }
  }

  async deleteEndpoint(endpointId: string): Promise<void> {
    const url = `${REST_BASE}/endpoints/${encodeURIComponent(endpointId)}`;
    try {
      await fetchJson<unknown>(url, { method: "DELETE", token: this.token });
    } catch (err) {
      throw this.mapResourceError(err, "Endpoint", endpointId);
    }
  }

  // ---------- Network volumes CRUD ----------

  async listNetworkVolumes(): Promise<ListNetworkVolumesResponse> {
    try {
      const body = await fetchJson<NetworkVolume[]>(`${REST_BASE}/networkvolumes`, {
        token: this.token,
      });
      return { networkVolumes: body };
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  async createNetworkVolume(body: NetworkVolumeCreateBody): Promise<NetworkVolume> {
    try {
      return await fetchJson<NetworkVolume>(`${REST_BASE}/networkvolumes`, {
        method: "POST",
        token: this.token,
        body,
      });
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  async getNetworkVolume(volumeId: string): Promise<NetworkVolume> {
    const url = `${REST_BASE}/networkvolumes/${encodeURIComponent(volumeId)}`;
    try {
      return await fetchJson<NetworkVolume>(url, { token: this.token });
    } catch (err) {
      throw this.mapResourceError(err, "Network volume", volumeId);
    }
  }

  async updateNetworkVolume(
    volumeId: string,
    body: NetworkVolumeUpdateBody,
  ): Promise<NetworkVolume> {
    const url = `${REST_BASE}/networkvolumes/${encodeURIComponent(volumeId)}`;
    try {
      return await fetchJson<NetworkVolume>(url, {
        method: "PATCH",
        token: this.token,
        body,
      });
    } catch (err) {
      throw this.mapResourceError(err, "Network volume", volumeId);
    }
  }

  async deleteNetworkVolume(volumeId: string): Promise<void> {
    const url = `${REST_BASE}/networkvolumes/${encodeURIComponent(volumeId)}`;
    try {
      await fetchJson<unknown>(url, { method: "DELETE", token: this.token });
    } catch (err) {
      throw this.mapResourceError(err, "Network volume", volumeId);
    }
  }

  // ---------- Container registry auth ----------

  async listRegistryAuths(): Promise<ListRegistryAuthsResponse> {
    try {
      const body = await fetchJson<RegistryAuth[]>(
        `${REST_BASE}/containerregistryauth`,
        { token: this.token },
      );
      return { registryAuths: body };
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  async createRegistryAuth(body: RegistryAuthCreateBody): Promise<RegistryAuth> {
    try {
      return await fetchJson<RegistryAuth>(`${REST_BASE}/containerregistryauth`, {
        method: "POST",
        token: this.token,
        body,
      });
    } catch (err) {
      throw this.wrapAuth(err);
    }
  }

  async getRegistryAuth(authId: string): Promise<RegistryAuth> {
    const url = `${REST_BASE}/containerregistryauth/${encodeURIComponent(authId)}`;
    try {
      return await fetchJson<RegistryAuth>(url, { token: this.token });
    } catch (err) {
      throw this.mapResourceError(err, "Registry auth", authId);
    }
  }

  async deleteRegistryAuth(authId: string): Promise<void> {
    const url = `${REST_BASE}/containerregistryauth/${encodeURIComponent(authId)}`;
    try {
      await fetchJson<unknown>(url, { method: "DELETE", token: this.token });
    } catch (err) {
      throw this.mapResourceError(err, "Registry auth", authId);
    }
  }

  // ---------- Serverless inference (INFERENCE_BASE) ----------

  async runEndpoint(
    endpointId: string,
    input: unknown,
    extra: RunExtra = {},
  ): Promise<JobStatus> {
    const url = `${INFERENCE_BASE}/${encodeURIComponent(endpointId)}/run`;
    try {
      return await fetchJson<JobStatus>(url, {
        method: "POST",
        token: this.token,
        body: { input, ...extra },
      });
    } catch (err) {
      throw this.mapResourceError(err, "Endpoint", endpointId);
    }
  }

  async runEndpointSync(
    endpointId: string,
    input: unknown,
    extra: RunExtra = {},
  ): Promise<JobStatus> {
    const url = `${INFERENCE_BASE}/${encodeURIComponent(endpointId)}/runsync`;
    try {
      return await fetchJson<JobStatus>(url, {
        method: "POST",
        token: this.token,
        body: { input, ...extra },
        // Sync runs block until the job finishes (or the endpoint hands back
        // an IN_PROGRESS handle). Give it more headroom than the 30s default.
        timeoutMs: 120_000,
      });
    } catch (err) {
      throw this.mapResourceError(err, "Endpoint", endpointId);
    }
  }

  async getJobStatus(endpointId: string, jobId: string): Promise<JobStatus> {
    const url = `${INFERENCE_BASE}/${encodeURIComponent(endpointId)}/status/${encodeURIComponent(jobId)}`;
    try {
      return await fetchJson<JobStatus>(url, { token: this.token });
    } catch (err) {
      throw this.mapResourceError(err, "Endpoint", endpointId);
    }
  }

  async cancelJob(endpointId: string, jobId: string): Promise<JobStatus> {
    const url = `${INFERENCE_BASE}/${encodeURIComponent(endpointId)}/cancel/${encodeURIComponent(jobId)}`;
    try {
      return await fetchJson<JobStatus>(url, { method: "POST", token: this.token });
    } catch (err) {
      throw this.mapResourceError(err, "Endpoint", endpointId);
    }
  }

  async endpointHealth(endpointId: string): Promise<EndpointHealth> {
    const url = `${INFERENCE_BASE}/${encodeURIComponent(endpointId)}/health`;
    try {
      return await fetchJson<EndpointHealth>(url, { token: this.token });
    } catch (err) {
      throw this.mapResourceError(err, "Endpoint", endpointId);
    }
  }

  async purgeQueue(endpointId: string): Promise<PurgeQueueResult> {
    const url = `${INFERENCE_BASE}/${encodeURIComponent(endpointId)}/purge-queue`;
    try {
      return await fetchJson<PurgeQueueResult>(url, {
        method: "POST",
        token: this.token,
      });
    } catch (err) {
      throw this.mapResourceError(err, "Endpoint", endpointId);
    }
  }

  // ---------- GraphQL (pricing + balance) ----------
  //
  // The GraphQL endpoint returns HTTP 200 even for query errors, with the
  // failures under `body.errors`. fetchJson only throws on non-2xx, so we
  // inspect `errors` ourselves and raise AuthError (key problems) or
  // UpstreamError (everything else).

  private async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    let body: { data?: T; errors?: Array<{ message?: string }> };
    try {
      body = await fetchJson<{ data?: T; errors?: Array<{ message?: string }> }>(
        GRAPHQL_URL,
        {
          method: "POST",
          token: this.token,
          body: { query, variables },
        },
      );
    } catch (err) {
      throw this.wrapAuth(err);
    }
    if (body.errors && body.errors.length > 0) {
      const msg =
        body.errors
          .map((e) => e.message)
          .filter((m): m is string => typeof m === "string")
          .join("; ") || "GraphQL error";
      if (/unauthor|not authenticated|invalid.*key|forbidden/i.test(msg)) {
        throw new AuthError(
          "Runpod GraphQL rejected the API key. Check RUNPOD_API_KEY.",
          { detail: body.errors },
        );
      }
      throw new UpstreamError(`Runpod GraphQL error: ${msg}`, {
        detail: body.errors,
      });
    }
    return body.data as T;
  }

  async listGpuTypes(): Promise<{ gpuTypes: GpuType[] }> {
    const query =
      "query { gpuTypes { id displayName memoryInGb secureCloud communityCloud securePrice communityPrice lowestPrice(input:{gpuCount:1}) { minimumBidPrice uninterruptablePrice } } }";
    const data = await this.graphql<{ gpuTypes: GpuType[] | null }>(query);
    return { gpuTypes: data.gpuTypes ?? [] };
  }

  async getBalance(): Promise<Balance> {
    const query =
      "query { myself { id clientBalance currentSpendPerHr spendLimit minBalance } }";
    const data = await this.graphql<{ myself: Balance | null }>(query);
    return data.myself ?? {};
  }
}
