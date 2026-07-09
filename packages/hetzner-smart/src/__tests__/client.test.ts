import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { AuthError, NotFoundError, UpstreamError } from "smart-mcp-core";
import { HetznerClient, type HetznerAction } from "../client.js";

const BASE = "https://api.hetzner.cloud/v1";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedToken: string | undefined;
let savedProject: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedToken = process.env.HETZNER_API_TOKEN;
  savedProject = process.env.HETZNER_PROJECT_ID;
  savedHome = process.env.HOME;
  delete process.env.HETZNER_API_TOKEN;
  delete process.env.HETZNER_PROJECT_ID;
  // Override HOME to a non-existent directory so loadCreds cannot fall back to
  // the real `~/.config/smart-mcps/.env` (which may carry a real token on this
  // dev machine). Without this the "throws AuthError when missing" test would
  // silently pass. See CLAUDE.md "Test isolation gotcha".
  process.env.HOME = "/nonexistent/hetzner-test-home";
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.HETZNER_API_TOKEN;
  else process.env.HETZNER_API_TOKEN = savedToken;
  if (savedProject === undefined) delete process.env.HETZNER_PROJECT_ID;
  else process.env.HETZNER_PROJECT_ID = savedProject;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function withToken(): HetznerClient {
  process.env.HETZNER_API_TOKEN = "test_token";
  return new HetznerClient();
}

function action(overrides: Partial<HetznerAction> = {}): HetznerAction {
  return {
    id: 100,
    command: "start_server",
    status: "running",
    progress: 0,
    started: "2026-07-08T00:00:00Z",
    finished: null,
    resources: [{ id: 7, type: "server" }],
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) + constructor
// ---------------------------------------------------------------------------
describe("HetznerClient — constructor", () => {
  it("throws AuthError when HETZNER_API_TOKEN is missing", () => {
    expect(() => new HetznerClient()).toThrowError(AuthError);
  });

  it("constructs when HETZNER_API_TOKEN is set", () => {
    process.env.HETZNER_API_TOKEN = "test_token";
    expect(() => new HetznerClient()).not.toThrow();
  });

  it("exposes projectId (optional cred)", () => {
    process.env.HETZNER_API_TOKEN = "test_token";
    process.env.HETZNER_PROJECT_ID = "proj_123";
    const client = new HetznerClient();
    expect(client.projectId).toBe("proj_123");
  });

  it("projectId is undefined when HETZNER_PROJECT_ID is unset", () => {
    process.env.HETZNER_API_TOKEN = "test_token";
    const client = new HetznerClient();
    expect(client.projectId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (b) auth header + (c) list shape/query params
// ---------------------------------------------------------------------------
describe("HetznerClient.listServers", () => {
  it("sends Authorization: Bearer <token>", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get(`${BASE}/servers`, ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ servers: [], meta: { pagination: {} } });
      }),
    );
    await withToken().listServers();
    expect(seenAuth).toBe("Bearer test_token");
  });

  it("returns { servers, meta } and passes list filters as query params", async () => {
    let seenUrl = "";
    server.use(
      http.get(`${BASE}/servers`, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          servers: [{ id: 1, name: "alpha" }],
          meta: { pagination: { page: 1, next_page: null } },
        });
      }),
    );
    const res = await withToken().listServers({
      status: "running",
      name: "alpha",
      per_page: 25,
    });
    expect(seenUrl).toContain("status=running");
    expect(seenUrl).toContain("name=alpha");
    expect(seenUrl).toContain("per_page=25");
    const servers = res.servers as Array<{ id: number }>;
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe(1);
    expect(res.meta?.pagination?.page).toBe(1);
  });

  it("maps a plain 401 to AuthError mentioning HETZNER_API_TOKEN", async () => {
    server.use(
      http.get(`${BASE}/servers`, () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "invalid token" } },
          { status: 401 },
        ),
      ),
    );
    const client = withToken();
    try {
      await client.listServers();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("HETZNER_API_TOKEN");
    }
  });
});

// ---------------------------------------------------------------------------
// (d) getServer 404
// ---------------------------------------------------------------------------
describe("HetznerClient.getServer", () => {
  it("unwraps { server } and encodes the id in the path", async () => {
    let seenUrl = "";
    server.use(
      http.get(`${BASE}/servers/42`, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ server: { id: 42, name: "beta" } });
      }),
    );
    const res = await withToken().getServer(42);
    expect(seenUrl).toContain("/v1/servers/42");
    expect(res.id).toBe(42);
    expect(res.name).toBe("beta");
  });

  it("maps 404 to NotFoundError 'Server not found: <id>'", async () => {
    server.use(
      http.get(`${BASE}/servers/999`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "x" } },
          { status: 404 },
        ),
      ),
    );
    const client = withToken();
    try {
      await client.getServer(999);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe("Server not found: 999");
    }
  });
});

// ---------------------------------------------------------------------------
// (e) mutation returns { action } + extractAction
// ---------------------------------------------------------------------------
describe("HetznerClient.serverAction + extractAction", () => {
  it("POSTs /servers/{id}/actions/{command} and returns the raw { action } body", async () => {
    let seenMethod = "";
    let seenUrl = "";
    server.use(
      http.post(`${BASE}/servers/7/actions/poweron`, ({ request }) => {
        seenMethod = request.method;
        seenUrl = request.url;
        return HttpResponse.json({ action: action({ id: 555 }) });
      }),
    );
    const client = withToken();
    const body = await client.serverAction(7, "poweron");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toContain("/v1/servers/7/actions/poweron");
    const extracted = client.extractAction(body);
    expect(extracted?.id).toBe(555);
    expect(extracted?.command).toBe("start_server");
  });

  it("extractAction pulls the first action from an { actions: [...] } envelope", () => {
    const client = withToken();
    const first = client.extractAction({
      actions: [action({ id: 1 }), action({ id: 2 })],
    });
    expect(first?.id).toBe(1);
  });

  it("extractAction returns undefined for a synchronous (actionless) body", () => {
    const client = withToken();
    expect(client.extractAction({ network: { id: 3 } })).toBeUndefined();
    expect(client.extractAction(null)).toBeUndefined();
    expect(client.extractAction({ actions: [] })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (f) waitForAction polls to success  (g) error status  (h) timeout
// ---------------------------------------------------------------------------
describe("HetznerClient.waitForAction", () => {
  it("polls GET /actions/{id} until status success and returns it", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/actions/42`, () => {
        calls += 1;
        return HttpResponse.json({
          action:
            calls === 1
              ? action({ id: 42, status: "running", progress: 40 })
              : action({
                  id: 42,
                  status: "success",
                  progress: 100,
                  finished: "2026-07-08T00:01:00Z",
                }),
        });
      }),
    );
    const settled = await withToken().waitForAction(42, { pollMs: 1 });
    expect(settled.status).toBe("success");
    expect(settled.progress).toBe(100);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("throws UpstreamError when the action ends in status error", async () => {
    server.use(
      http.get(`${BASE}/actions/43`, () =>
        HttpResponse.json({
          action: action({
            id: 43,
            command: "create_server",
            status: "error",
            error: { code: "server_error", message: "boom" },
          }),
        }),
      ),
    );
    const client = withToken();
    await expect(
      client.waitForAction(43, { pollMs: 1 }),
    ).rejects.toBeInstanceOf(UpstreamError);
    await expect(
      client.waitForAction(43, { pollMs: 1 }),
    ).rejects.toThrowError(/boom/);
  });

  it("throws UpstreamError when the timeout elapses while still running", async () => {
    server.use(
      http.get(`${BASE}/actions/44`, () =>
        HttpResponse.json({ action: action({ id: 44, status: "running" }) }),
      ),
    );
    const client = withToken();
    await expect(
      client.waitForAction(44, { pollMs: 1, timeoutMs: 20 }),
    ).rejects.toThrowError(/did not finish within 20ms/);
  });
});

// ---------------------------------------------------------------------------
// (i) read-only token 401
// ---------------------------------------------------------------------------
describe("HetznerClient — read-only token", () => {
  it("maps a token_readonly 401 to a read-only guidance message", async () => {
    server.use(
      http.post(`${BASE}/servers/7/actions/poweron`, () =>
        HttpResponse.json(
          {
            error: {
              code: "token_readonly",
              message: "The token is only allowed to perform GET requests",
            },
          },
          { status: 401 },
        ),
      ),
    );
    const client = withToken();
    try {
      await client.serverAction(7, "poweron");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toMatch(/read-only/i);
    }
  });
});

// ---------------------------------------------------------------------------
// (j) 423 protected / locked mapping
// ---------------------------------------------------------------------------
describe("HetznerClient — 423 protected/locked", () => {
  it("maps 423 'protected' to protection guidance", async () => {
    server.use(
      http.delete(`${BASE}/servers/8`, () =>
        HttpResponse.json(
          { error: { code: "protected", message: "server is protected" } },
          { status: 423 },
        ),
      ),
    );
    const client = withToken();
    await expect(client.deleteServer(8)).rejects.toThrowError(/protected/i);
  });

  it("maps 423 'locked' to action-in-progress guidance", async () => {
    server.use(
      http.post(`${BASE}/servers/9/actions/poweroff`, () =>
        HttpResponse.json(
          { error: { code: "locked", message: "server is locked" } },
          { status: 423 },
        ),
      ),
    );
    const client = withToken();
    await expect(
      client.serverAction(9, "poweroff"),
    ).rejects.toThrowError(/action in progress/i);
  });
});

// ---------------------------------------------------------------------------
// (k) getAllPages follows next_page
// ---------------------------------------------------------------------------
describe("HetznerClient.getAllPages", () => {
  it("follows meta.pagination.next_page across pages and concatenates", async () => {
    const seenPages: string[] = [];
    server.use(
      http.get(`${BASE}/servers`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page") ?? "1";
        seenPages.push(page);
        if (page === "1") {
          return HttpResponse.json({
            servers: [{ id: 1 }],
            meta: { pagination: { page: 1, next_page: 2 } },
          });
        }
        return HttpResponse.json({
          servers: [{ id: 2 }],
          meta: { pagination: { page: 2, next_page: null } },
        });
      }),
    );
    const all = await withToken().getAllPages<{ id: number }>(
      "/servers",
      "servers",
    );
    expect(seenPages).toEqual(["1", "2"]);
    expect(all.map((s) => s.id)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Extra coverage: representative resource families + catalog + delete shapes
// ---------------------------------------------------------------------------
describe("HetznerClient — resource surface", () => {
  it("deleteServer returns the async { action } body (not 204)", async () => {
    server.use(
      http.delete(`${BASE}/servers/7`, () =>
        HttpResponse.json({ action: action({ id: 900, command: "delete_server" }) }),
      ),
    );
    const client = withToken();
    const body = await client.deleteServer(7);
    expect(client.extractAction(body)?.command).toBe("delete_server");
  });

  it("deleteVolume resolves void on 204", async () => {
    server.use(
      http.delete(`${BASE}/volumes/5`, () => new HttpResponse(null, { status: 204 })),
    );
    await expect(withToken().deleteVolume(5)).resolves.toBeUndefined();
  });

  it("createNetwork POSTs the body verbatim and returns { network }", async () => {
    let seenBody: unknown = null;
    server.use(
      http.post(`${BASE}/networks`, async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ network: { id: 12, name: "net" } });
      }),
    );
    const res = await withToken().createNetwork({
      name: "net",
      ip_range: "10.0.0.0/16",
    });
    expect(seenBody).toEqual({ name: "net", ip_range: "10.0.0.0/16" });
    // createNetwork returns the raw synchronous body; the tool layer unwraps it.
    expect((res.network as { name?: string }).name).toBe("net");
  });

  it("firewallAction returns the multi-action { actions } envelope", async () => {
    server.use(
      http.post(`${BASE}/firewalls/3/actions/apply_to_resources`, () =>
        HttpResponse.json({ actions: [action({ id: 1 }), action({ id: 2 })] }),
      ),
    );
    const client = withToken();
    const body = await client.firewallAction(3, "apply_to_resources", {
      apply_to: [{ type: "server", server: { id: 7 } }],
    });
    expect(client.extractAction(body)?.id).toBe(1);
  });

  it("getSshKey 404 names the resource with proper casing", async () => {
    server.use(
      http.get(`${BASE}/ssh_keys/2`, () =>
        HttpResponse.json({ error: { code: "not_found", message: "x" } }, { status: 404 }),
      ),
    );
    await expect(withToken().getSshKey(2)).rejects.toThrowError(
      /SSH key not found: 2/,
    );
  });

  it("getPricing unwraps { pricing }", async () => {
    server.use(
      http.get(`${BASE}/pricing`, () =>
        HttpResponse.json({ pricing: { currency: "EUR", vat_rate: "19" } }),
      ),
    );
    const res = await withToken().getPricing();
    expect(res.currency).toBe("EUR");
  });

  it("listServerTypes hits /server_types and returns the wrapped body", async () => {
    let seenUrl = "";
    server.use(
      http.get(`${BASE}/server_types`, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          server_types: [{ id: 1, name: "cx22" }],
          meta: { pagination: {} },
        });
      }),
    );
    const res = await withToken().listServerTypes();
    expect(seenUrl).toContain("/v1/server_types");
    expect((res.server_types as Array<unknown>)).toHaveLength(1);
  });
});
