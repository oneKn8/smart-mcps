import {
  loadCreds,
  fetchJson,
  AuthError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from "smart-mcp-core";

// Hetzner Cloud exposes a single REST host authenticated with a project-scoped
// bearer token (`Authorization: Bearer ${HETZNER_API_TOKEN}`). Mutations are
// asynchronous Actions that must be polled to completion — see the action layer
// below.
export const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";

export type HetznerCreds = {
  HETZNER_API_TOKEN: string;
  HETZNER_PROJECT_ID?: string;
};

// loadCreds is generic over `Record<Key, string>`; the optional project id is
// still typed as `string` there even though our public creds shape makes it
// optional. This alias satisfies loadCreds' constraint; we cast back afterward.
type HetznerCredsRecord = Record<
  "HETZNER_API_TOKEN" | "HETZNER_PROJECT_ID",
  string
>;

// The async Action envelope returned by every mutating endpoint. Kept open at
// the edges (the tool layer slims it) but with the fields the action layer and
// waiter rely on typed explicitly.
export type HetznerAction = {
  id: number;
  command: string;
  status: "running" | "success" | "error";
  progress: number;
  started: string | null;
  finished: string | null;
  resources: Array<{ id: number; type: string }>;
  error: { code: string; message: string } | null;
};

// Query params shared by every list endpoint (verified on GET /servers).
export interface HetznerListParams {
  status?: string;
  name?: string;
  label_selector?: string;
  sort?: string;
  page?: number;
  per_page?: number;
}

// Metrics query params (GET /servers/{id}/metrics): `type` is required upstream
// and RFC3339 start/end plus a numeric step drive the window.
export interface HetznerMetricsParams {
  type?: string;
  start?: string;
  end?: string;
  step?: number;
}

// Most resource methods hand back the raw upstream JSON body; the tool layer is
// responsible for slim-mapping. Wrapped list bodies carry `meta.pagination`.
export type HetznerBody = Record<string, unknown>;

export type HetznerPagination = {
  page?: number | null;
  per_page?: number | null;
  previous_page?: number | null;
  next_page?: number | null;
  last_page?: number | null;
  total_entries?: number | null;
};

export type HetznerListResponse = HetznerBody & {
  meta?: { pagination?: HetznerPagination };
};

type SearchParams = Record<string, string | number | boolean | undefined>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Lowercased blob of an error's message + serialized detail, used to sniff the
// Hetzner error semantics (read-only token, protected/locked) that core folds
// into generic AuthError/UpstreamError.
function combinedText(err: unknown): string {
  if (!(err instanceof Error)) return String(err).toLowerCase();
  const detail = (err as { detail?: unknown }).detail;
  let detailStr = "";
  if (typeof detail === "string") {
    detailStr = detail;
  } else if (detail !== undefined) {
    try {
      detailStr = JSON.stringify(detail);
    } catch {
      detailStr = String(detail);
    }
  }
  return `${err.message} ${detailStr}`.toLowerCase();
}

// Pulls the Hetzner `error.code` out of an error's `detail` when present.
function hetznerErrorCode(err: unknown): string | undefined {
  const detail = (err as { detail?: unknown }).detail;
  const rec = asRecord(detail);
  const errObj = asRecord(rec?.error);
  const code = errObj?.code;
  return typeof code === "string" ? code : undefined;
}

// Pulls the human-readable Hetzner `error.message` out of an error's `detail`.
// Undefined when the upstream body was non-JSON, empty, or carried no message.
function hetznerErrorMessage(err: unknown): string | undefined {
  const detail = (err as { detail?: unknown }).detail;
  const rec = asRecord(detail);
  const errObj = asRecord(rec?.error);
  const message = errObj?.message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

// Appends the upstream reason to the bare "METHOD URL → status" line core
// produces, so callers see e.g. "unsupported location for server type" instead
// of just "422". Returns undefined when no upstream message is available.
function surfaceHetznerMessage(
  err: Error,
  code: string | undefined,
): string | undefined {
  const message = hetznerErrorMessage(err);
  if (!message) return undefined;
  const suffix = code ? ` (${code})` : "";
  return `${err.message}: ${message}${suffix}`;
}

function capitalize(kind: string): string {
  return kind.length === 0 ? kind : kind[0]!.toUpperCase() + kind.slice(1);
}

export class HetznerClient {
  private readonly creds: HetznerCreds;

  constructor(creds?: HetznerCreds) {
    this.creds =
      creds ??
      (loadCreds<HetznerCredsRecord>({
        serviceName: "hetzner-smart",
        required: ["HETZNER_API_TOKEN"],
        optional: ["HETZNER_PROJECT_ID"],
      }) as HetznerCreds);
  }

  // Informational only (the token already scopes to one project). Exposed as a
  // typed getter so the secret token never leaks out of the client.
  get projectId(): string | undefined {
    return this.creds.HETZNER_PROJECT_ID;
  }

  private get token(): string {
    return this.creds.HETZNER_API_TOKEN;
  }

  // ---------- Thin HTTP helpers over core fetchJson ----------

  private get<T>(
    path: string,
    searchParams?: HetznerListParams | HetznerMetricsParams,
  ): Promise<T> {
    return fetchJson<T>(`${HETZNER_API_BASE}${path}`, {
      token: this.token,
      // Localized boundary cast: our typed param interfaces carry no index
      // signature, but every value is already string | number | undefined.
      searchParams: searchParams as SearchParams | undefined,
    });
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return fetchJson<T>(`${HETZNER_API_BASE}${path}`, {
      method: "POST",
      token: this.token,
      body,
    });
  }

  private put<T>(path: string, body?: unknown): Promise<T> {
    return fetchJson<T>(`${HETZNER_API_BASE}${path}`, {
      method: "PUT",
      token: this.token,
      body,
    });
  }

  // Generic DELETE. Defaults to `void` (204 endpoints); server delete overrides
  // T to capture the `{ action }` body Hetzner returns for the async case.
  private del<T = void>(path: string): Promise<T> {
    return fetchJson<T>(`${HETZNER_API_BASE}${path}`, {
      method: "DELETE",
      token: this.token,
    });
  }

  // Runs an HTTP op and remaps any thrown error into a caller-friendly one.
  private async guard<T>(
    kind: string | undefined,
    id: string | number | undefined,
    op: () => Promise<T>,
  ): Promise<T> {
    try {
      return await op();
    } catch (err) {
      throw this.mapError(err, kind, id);
    }
  }

  // Central error mapper. AuthError → relabel (and flag read-only tokens);
  // NotFoundError (+id) → "<Kind> not found: <id>"; UpstreamError 423 →
  // protected/locked guidance. Everything else passes through unchanged.
  private mapError(err: unknown, kind?: string, id?: string | number): Error {
    if (err instanceof AuthError) {
      const text = combinedText(err);
      const code = hetznerErrorCode(err);
      const readOnly =
        code === "token_readonly" ||
        /only allowed to perform get/.test(text) ||
        /read[-\s]?only/.test(text);
      if (readOnly) {
        return new AuthError(
          "Hetzner token is read-only — needs a Read & Write token. Update HETZNER_API_TOKEN.",
          { detail: err.detail, cause: err },
        );
      }
      return new AuthError(
        "Hetzner rejected HETZNER_API_TOKEN. Check the token is valid and adequately scoped.",
        { detail: err.detail, cause: err },
      );
    }

    if (err instanceof NotFoundError && kind !== undefined && id !== undefined) {
      return new NotFoundError(`${capitalize(kind)} not found: ${id}`, {
        detail: err.detail,
        cause: err,
      });
    }

    if (err instanceof UpstreamError) {
      const text = combinedText(err);
      const code = hetznerErrorCode(err);
      if (code === "protected" || /\bprotected\b/.test(text)) {
        return new UpstreamError(
          "Resource is protected; disable delete/rebuild protection first.",
          { detail: err.detail, cause: err },
        );
      }
      if (
        code === "locked" ||
        code === "resource_locked" ||
        /\block(ed)?\b/.test(text)
      ) {
        return new UpstreamError(
          "Resource has an action in progress; retry shortly.",
          { detail: err.detail, cause: err },
        );
      }
      // Otherwise (e.g. 422/409/5xx) surface the raw upstream reason so the
      // caller sees why, not just the status. Class is preserved.
      const surfaced = surfaceHetznerMessage(err, code);
      if (surfaced) {
        return new UpstreamError(surfaced, { detail: err.detail, cause: err });
      }
    }

    // A 400 is mapped to ValidationError by core; enrich its message the same
    // way without changing the class.
    if (err instanceof ValidationError) {
      const surfaced = surfaceHetznerMessage(err, hetznerErrorCode(err));
      if (surfaced) {
        return new ValidationError(surfaced, { detail: err.detail, cause: err });
      }
    }

    return err instanceof Error ? err : new Error(String(err));
  }

  // ---------- Action layer (the novel piece vs other smart-mcps) ----------

  // Normalizes any mutation envelope to its primary action: `{ action }` (most
  // ops) or `{ actions: [...] }` (firewall multi-action). Undefined when the
  // response is synchronous (e.g. POST /networks, POST /ssh_keys).
  extractAction(body: unknown): HetznerAction | undefined {
    const rec = asRecord(body);
    if (!rec) return undefined;
    const single = asRecord(rec.action);
    if (single) return single as unknown as HetznerAction;
    const multi = rec.actions;
    if (Array.isArray(multi)) {
      const first = asRecord(multi[0]);
      if (first) return first as unknown as HetznerAction;
    }
    return undefined;
  }

  async getAction(id: number): Promise<HetznerAction> {
    const body = await this.guard("action", id, () =>
      this.get<{ action: HetznerAction }>(`/actions/${encodeURIComponent(id)}`),
    );
    return body.action;
  }

  // Polls GET /actions/{id} with capped exponential backoff until the action
  // settles. Resolves on success; throws UpstreamError on error status or when
  // the overall timeout elapses. `pollMs` is injectable so tests can drive it
  // fast and deterministically with real timers.
  async waitForAction(
    id: number,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<HetznerAction> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const maxPollMs = 5_000;
    let pollMs = opts.pollMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const action = await this.getAction(id);
      if (action.status === "success") return action;
      if (action.status === "error") {
        const message = action.error?.message ?? "unknown error";
        throw new UpstreamError(
          `Hetzner action ${id} (${action.command}) failed: ${message}`,
          { detail: action.error },
        );
      }
      if (Date.now() >= deadline) {
        throw new UpstreamError(
          `Hetzner action ${id} (${action.command}) did not finish within ${timeoutMs}ms; last status "${action.status}".`,
        );
      }
      await delay(pollMs);
      pollMs = Math.min(pollMs * 2, maxPollMs);
    }
  }

  // ---------- Servers ----------

  async listServers(params: HetznerListParams = {}): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/servers", params),
    );
  }

  async getServer(id: number): Promise<HetznerBody> {
    const body = await this.guard("server", id, () =>
      this.get<{ server: HetznerBody }>(`/servers/${encodeURIComponent(id)}`),
    );
    return body.server;
  }

  async createServer(body: unknown): Promise<HetznerBody> {
    return this.guard("server", undefined, () =>
      this.post<HetznerBody>("/servers", body),
    );
  }

  async updateServer(id: number, body: unknown): Promise<HetznerBody> {
    return this.guard("server", id, () =>
      this.put<HetznerBody>(`/servers/${encodeURIComponent(id)}`, body),
    );
  }

  async deleteServer(id: number): Promise<HetznerBody> {
    // DELETE /servers/{id} is async: it returns `{ action }`, not 204.
    return this.guard("server", id, () =>
      this.del<HetznerBody>(`/servers/${encodeURIComponent(id)}`),
    );
  }

  async getServerMetrics(
    id: number,
    params: HetznerMetricsParams,
  ): Promise<HetznerBody> {
    return this.guard("server", id, () =>
      this.get<HetznerBody>(`/servers/${encodeURIComponent(id)}/metrics`, params),
    );
  }

  async serverAction(
    id: number,
    command: string,
    body?: unknown,
  ): Promise<HetznerBody> {
    return this.guard("server", id, () =>
      this.post<HetznerBody>(
        `/servers/${encodeURIComponent(id)}/actions/${encodeURIComponent(command)}`,
        body,
      ),
    );
  }

  // ---------- SSH keys (create/delete are synchronous — no action) ----------

  async listSshKeys(params: HetznerListParams = {}): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/ssh_keys", params),
    );
  }

  async getSshKey(id: number): Promise<HetznerBody> {
    const body = await this.guard("SSH key", id, () =>
      this.get<{ ssh_key: HetznerBody }>(`/ssh_keys/${encodeURIComponent(id)}`),
    );
    return body.ssh_key;
  }

  async createSshKey(body: unknown): Promise<HetznerBody> {
    return this.guard("SSH key", undefined, () =>
      this.post<HetznerBody>("/ssh_keys", body),
    );
  }

  async deleteSshKey(id: number): Promise<void> {
    await this.guard("SSH key", id, () =>
      this.del(`/ssh_keys/${encodeURIComponent(id)}`),
    );
  }

  // ---------- Volumes ----------

  async listVolumes(params: HetznerListParams = {}): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/volumes", params),
    );
  }

  async getVolume(id: number): Promise<HetznerBody> {
    const body = await this.guard("volume", id, () =>
      this.get<{ volume: HetznerBody }>(`/volumes/${encodeURIComponent(id)}`),
    );
    return body.volume;
  }

  async createVolume(body: unknown): Promise<HetznerBody> {
    return this.guard("volume", undefined, () =>
      this.post<HetznerBody>("/volumes", body),
    );
  }

  async deleteVolume(id: number): Promise<void> {
    await this.guard("volume", id, () =>
      this.del(`/volumes/${encodeURIComponent(id)}`),
    );
  }

  async volumeAction(
    id: number,
    command: string,
    body?: unknown,
  ): Promise<HetznerBody> {
    return this.guard("volume", id, () =>
      this.post<HetznerBody>(
        `/volumes/${encodeURIComponent(id)}/actions/${encodeURIComponent(command)}`,
        body,
      ),
    );
  }

  // ---------- Firewalls (actions return `{ actions: [...] }`) ----------

  async listFirewalls(
    params: HetznerListParams = {},
  ): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/firewalls", params),
    );
  }

  async getFirewall(id: number): Promise<HetznerBody> {
    const body = await this.guard("firewall", id, () =>
      this.get<{ firewall: HetznerBody }>(`/firewalls/${encodeURIComponent(id)}`),
    );
    return body.firewall;
  }

  async createFirewall(body: unknown): Promise<HetznerBody> {
    return this.guard("firewall", undefined, () =>
      this.post<HetznerBody>("/firewalls", body),
    );
  }

  async deleteFirewall(id: number): Promise<void> {
    await this.guard("firewall", id, () =>
      this.del(`/firewalls/${encodeURIComponent(id)}`),
    );
  }

  async firewallAction(
    id: number,
    command: string,
    body?: unknown,
  ): Promise<HetznerBody> {
    return this.guard("firewall", id, () =>
      this.post<HetznerBody>(
        `/firewalls/${encodeURIComponent(id)}/actions/${encodeURIComponent(command)}`,
        body,
      ),
    );
  }

  // ---------- Networks (create is synchronous — returns `{ network }`) ----------

  async listNetworks(
    params: HetznerListParams = {},
  ): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/networks", params),
    );
  }

  async getNetwork(id: number): Promise<HetznerBody> {
    const body = await this.guard("network", id, () =>
      this.get<{ network: HetznerBody }>(`/networks/${encodeURIComponent(id)}`),
    );
    return body.network;
  }

  async createNetwork(body: unknown): Promise<HetznerBody> {
    return this.guard("network", undefined, () =>
      this.post<HetznerBody>("/networks", body),
    );
  }

  async deleteNetwork(id: number): Promise<void> {
    await this.guard("network", id, () =>
      this.del(`/networks/${encodeURIComponent(id)}`),
    );
  }

  // ---------- Load balancers ----------

  async listLoadBalancers(
    params: HetznerListParams = {},
  ): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/load_balancers", params),
    );
  }

  async getLoadBalancer(id: number): Promise<HetznerBody> {
    const body = await this.guard("load balancer", id, () =>
      this.get<{ load_balancer: HetznerBody }>(
        `/load_balancers/${encodeURIComponent(id)}`,
      ),
    );
    return body.load_balancer;
  }

  async createLoadBalancer(body: unknown): Promise<HetznerBody> {
    return this.guard("load balancer", undefined, () =>
      this.post<HetznerBody>("/load_balancers", body),
    );
  }

  async deleteLoadBalancer(id: number): Promise<void> {
    await this.guard("load balancer", id, () =>
      this.del(`/load_balancers/${encodeURIComponent(id)}`),
    );
  }

  // ---------- Floating IPs ----------

  async listFloatingIps(
    params: HetznerListParams = {},
  ): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/floating_ips", params),
    );
  }

  async createFloatingIp(body: unknown): Promise<HetznerBody> {
    return this.guard("floating IP", undefined, () =>
      this.post<HetznerBody>("/floating_ips", body),
    );
  }

  async deleteFloatingIp(id: number): Promise<void> {
    await this.guard("floating IP", id, () =>
      this.del(`/floating_ips/${encodeURIComponent(id)}`),
    );
  }

  async floatingIpAction(
    id: number,
    command: string,
    body?: unknown,
  ): Promise<HetznerBody> {
    return this.guard("floating IP", id, () =>
      this.post<HetznerBody>(
        `/floating_ips/${encodeURIComponent(id)}/actions/${encodeURIComponent(command)}`,
        body,
      ),
    );
  }

  // ---------- Primary IPs ----------

  async listPrimaryIps(
    params: HetznerListParams = {},
  ): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/primary_ips", params),
    );
  }

  async createPrimaryIp(body: unknown): Promise<HetznerBody> {
    return this.guard("primary IP", undefined, () =>
      this.post<HetznerBody>("/primary_ips", body),
    );
  }

  async deletePrimaryIp(id: number): Promise<void> {
    await this.guard("primary IP", id, () =>
      this.del(`/primary_ips/${encodeURIComponent(id)}`),
    );
  }

  async primaryIpAction(
    id: number,
    command: string,
    body?: unknown,
  ): Promise<HetznerBody> {
    return this.guard("primary IP", id, () =>
      this.post<HetznerBody>(
        `/primary_ips/${encodeURIComponent(id)}/actions/${encodeURIComponent(command)}`,
        body,
      ),
    );
  }

  // ---------- Certificates ----------

  async listCertificates(
    params: HetznerListParams = {},
  ): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/certificates", params),
    );
  }

  async createCertificate(body: unknown): Promise<HetznerBody> {
    return this.guard("certificate", undefined, () =>
      this.post<HetznerBody>("/certificates", body),
    );
  }

  async deleteCertificate(id: number): Promise<void> {
    await this.guard("certificate", id, () =>
      this.del(`/certificates/${encodeURIComponent(id)}`),
    );
  }

  // ---------- Placement groups ----------

  async listPlacementGroups(
    params: HetznerListParams = {},
  ): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/placement_groups", params),
    );
  }

  async createPlacementGroup(body: unknown): Promise<HetznerBody> {
    return this.guard("placement group", undefined, () =>
      this.post<HetznerBody>("/placement_groups", body),
    );
  }

  async deletePlacementGroup(id: number): Promise<void> {
    await this.guard("placement group", id, () =>
      this.del(`/placement_groups/${encodeURIComponent(id)}`),
    );
  }

  // ---------- Images (no create — images come from server snapshots) ----------

  async listImages(params: HetznerListParams = {}): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/images", params),
    );
  }

  async getImage(id: number): Promise<HetznerBody> {
    const body = await this.guard("image", id, () =>
      this.get<{ image: HetznerBody }>(`/images/${encodeURIComponent(id)}`),
    );
    return body.image;
  }

  async deleteImage(id: number): Promise<void> {
    await this.guard("image", id, () =>
      this.del(`/images/${encodeURIComponent(id)}`),
    );
  }

  // ---------- Catalog (read-only reference) ----------

  async listServerTypes(
    params: HetznerListParams = {},
  ): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/server_types", params),
    );
  }

  async listLocations(
    params: HetznerListParams = {},
  ): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/locations", params),
    );
  }

  async listDatacenters(
    params: HetznerListParams = {},
  ): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/datacenters", params),
    );
  }

  async listIsos(params: HetznerListParams = {}): Promise<HetznerListResponse> {
    return this.guard(undefined, undefined, () =>
      this.get<HetznerListResponse>("/isos", params),
    );
  }

  async getPricing(): Promise<HetznerBody> {
    const body = await this.guard(undefined, undefined, () =>
      this.get<{ pricing: HetznerBody }>("/pricing"),
    );
    return body.pricing;
  }

  // ---------- Pagination helper for shortcuts ----------

  // Walks `page` via `meta.pagination.next_page`, concatenating each page's
  // `key` array. Capped at 20 pages so a runaway account can't hang a shortcut.
  async getAllPages<T>(
    path: string,
    key: string,
    params: HetznerListParams = {},
  ): Promise<T[]> {
    const MAX_PAGES = 20;
    const out: T[] = [];
    let page = params.page ?? 1;
    let fetched = 0;

    for (;;) {
      const body = await this.guard(undefined, undefined, () =>
        this.get<HetznerListResponse>(path, { ...params, page }),
      );
      const arr = body[key];
      if (Array.isArray(arr)) out.push(...(arr as T[]));
      fetched += 1;

      const pagination = asRecord(asRecord(body.meta)?.pagination);
      const next = pagination?.next_page;
      if (typeof next !== "number" || fetched >= MAX_PAGES) break;
      page = next;
    }

    return out;
  }
}

// setTimeout-backed sleep. Kept module-level so waitForAction can await it and
// tests can drive the poll cadence with a small injected `pollMs`.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
