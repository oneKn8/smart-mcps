import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthError, NotFoundError, UpstreamError } from "smart-mcp-core";
import { AppsScriptClient } from "../client.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://script.googleapis.com/v1";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "apps-script-client-test-"));
}

function writeTokenFile(home: string, account: string): void {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${account}.script.json`),
    JSON.stringify({
      token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_uri: TOKEN_URL,
      client_id: "test-client.apps.googleusercontent.com",
      client_secret: "test-secret",
      scopes: ["https://www.googleapis.com/auth/script.projects"],
      // Far-future expiry so getAccessToken never refreshes (no token-URL hit).
      expiry: "2099-01-01T00:00:00.000Z",
    }),
  );
}

function client(): AppsScriptClient {
  writeTokenFile(tmpHome, "alice");
  return new AppsScriptClient("alice", { home: tmpHome });
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ============================================================================
// constructor
// ============================================================================

describe("AppsScriptClient — constructor", () => {
  it("is side-effect-free without HOME", () => {
    delete process.env.HOME;
    expect(() => new AppsScriptClient("alice")).not.toThrow();
  });

  it("getAccount returns the constructor account", () => {
    expect(new AppsScriptClient("alice").getAccount()).toBe("alice");
  });

  it("exposes the API base + scope constants", () => {
    expect(AppsScriptClient.API_BASE).toBe(API);
    expect(AppsScriptClient.TOKEN_FILE_SUFFIX).toBe(".script.json");
  });

  it("throws AuthError when the token file is missing", async () => {
    // HOME is a fresh empty tmp dir; no token file written.
    const c = new AppsScriptClient("nobody", { home: tmpHome });
    await expect(c.getProject("s1")).rejects.toBeInstanceOf(AuthError);
  });
});

// ============================================================================
// projects
// ============================================================================

describe("AppsScriptClient — projects", () => {
  it("createProject POSTs { title, parentId } and returns the Project", async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/projects`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ scriptId: "s_new", title: "T" });
      }),
    );
    const res = await client().createProject({ title: "T", parentId: "doc1" });
    expect(body).toEqual({ title: "T", parentId: "doc1" });
    expect(res).toEqual({ scriptId: "s_new", title: "T" });
  });

  it("createProject omits parentId when undefined", async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/projects`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ scriptId: "s_new", title: "T" });
      }),
    );
    await client().createProject({ title: "T" });
    expect(body).toEqual({ title: "T" });
  });

  it("getProject 404 → NotFoundError naming the project", async () => {
    server.use(
      http.get(`${API}/projects/s_missing`, () =>
        HttpResponse.json({ error: { message: "not found" } }, { status: 404 }),
      ),
    );
    await expect(client().getProject("s_missing")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });
});

// ============================================================================
// content (getContent + the full-overwrite updateContent)
// ============================================================================

describe("AppsScriptClient — content", () => {
  it("getContent passes versionNumber as a query param", async () => {
    let url: string | undefined;
    server.use(
      http.get(`${API}/projects/s1/content`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ scriptId: "s1", files: [] });
      }),
    );
    await client().getContent("s1", 3);
    expect(new URL(url!).searchParams.get("versionNumber")).toBe("3");
  });

  it("updateContent PUTs the full { files } array (overwrite semantics)", async () => {
    let body: unknown;
    server.use(
      http.put(`${API}/projects/s1/content`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ scriptId: "s1", files: [] });
      }),
    );
    const files = [
      { name: "Code", type: "SERVER_JS", source: "x" },
      { name: "appsscript", type: "JSON", source: "{}" },
    ];
    await client().updateContent("s1", files);
    expect(body).toEqual({ files });
  });
});

// ============================================================================
// metrics
// ============================================================================

describe("AppsScriptClient — metrics", () => {
  it("getMetrics sends metricsGranularity + metricsFilter.deploymentId", async () => {
    let url: string | undefined;
    server.use(
      http.get(`${API}/projects/s1/metrics`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({});
      }),
    );
    await client().getMetrics({
      scriptId: "s1",
      metricsGranularity: "DAILY",
      deploymentId: "dep_1",
    });
    const q = new URL(url!).searchParams;
    expect(q.get("metricsGranularity")).toBe("DAILY");
    expect(q.get("metricsFilter.deploymentId")).toBe("dep_1");
  });
});

// ============================================================================
// versions
// ============================================================================

describe("AppsScriptClient — versions", () => {
  it("createVersion POSTs { description }", async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/projects/s1/versions`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ scriptId: "s1", versionNumber: 1 });
      }),
    );
    await client().createVersion("s1", "first");
    expect(body).toEqual({ description: "first" });
  });

  it("listVersions normalizes the versions[] envelope to { items, nextPageToken }", async () => {
    server.use(
      http.get(`${API}/projects/s1/versions`, () =>
        HttpResponse.json({
          versions: [{ versionNumber: 1 }],
          nextPageToken: "tok",
        }),
      ),
    );
    const res = await client().listVersions({ scriptId: "s1" });
    expect(res).toEqual({
      items: [{ versionNumber: 1 }],
      nextPageToken: "tok",
    });
  });

  it("getVersion 404 → NotFoundError naming the version", async () => {
    server.use(
      http.get(`${API}/projects/s1/versions/9`, () =>
        HttpResponse.json({}, { status: 404 }),
      ),
    );
    await expect(client().getVersion("s1", 9)).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });
});

// ============================================================================
// deployments (note: create sends bare config, update wraps in deploymentConfig)
// ============================================================================

describe("AppsScriptClient — deployments", () => {
  it("createDeployment POSTs the bare DeploymentConfig", async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/projects/s1/deployments`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ deploymentId: "dep_1" });
      }),
    );
    await client().createDeployment("s1", {
      versionNumber: 2,
      manifestFileName: "appsscript",
    });
    expect(body).toEqual({ versionNumber: 2, manifestFileName: "appsscript" });
  });

  it("updateDeployment PUTs { deploymentConfig: {...} } (wrapped)", async () => {
    let body: unknown;
    server.use(
      http.put(`${API}/projects/s1/deployments/dep_1`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ deploymentId: "dep_1" });
      }),
    );
    await client().updateDeployment("s1", "dep_1", { versionNumber: 3 });
    expect(body).toEqual({ deploymentConfig: { versionNumber: 3 } });
  });

  it("deleteDeployment issues DELETE and 404 → NotFoundError naming the deployment", async () => {
    server.use(
      http.delete(`${API}/projects/s1/deployments/dep_x`, () =>
        HttpResponse.json({}, { status: 404 }),
      ),
    );
    await expect(
      client().deleteDeployment("s1", "dep_x"),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("listDeployments normalizes the deployments[] envelope", async () => {
    server.use(
      http.get(`${API}/projects/s1/deployments`, () =>
        HttpResponse.json({ deployments: [{ deploymentId: "dep_1" }] }),
      ),
    );
    const res = await client().listDeployments({ scriptId: "s1" });
    expect(res).toEqual({ items: [{ deploymentId: "dep_1" }] });
  });
});

// ============================================================================
// processes (two endpoints)
// ============================================================================

describe("AppsScriptClient — processes", () => {
  it("uses /processes with userProcessFilter.* when no scriptId", async () => {
    let url: string | undefined;
    server.use(
      http.get(`${API}/processes`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ processes: [] });
      }),
    );
    await client().listProcesses({ functionName: "poll", statuses: ["FAILED"] });
    const q = new URL(url!).searchParams;
    expect(q.get("userProcessFilter.functionName")).toBe("poll");
    expect(q.get("userProcessFilter.statuses")).toBe("FAILED");
  });

  it("uses :listScriptProcesses with scriptId + scriptProcessFilter.* when scriptId set", async () => {
    let url: string | undefined;
    server.use(
      http.get(`${API}/processes:listScriptProcesses`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ processes: [{ functionName: "poll" }] });
      }),
    );
    const res = await client().listProcesses({
      scriptId: "s1",
      functionName: "poll",
    });
    const q = new URL(url!).searchParams;
    expect(q.get("scriptId")).toBe("s1");
    expect(q.get("scriptProcessFilter.functionName")).toBe("poll");
    expect(res.items).toEqual([{ functionName: "poll" }]);
  });
});

// ============================================================================
// scripts.run — THE risky one
// ============================================================================

describe("AppsScriptClient.runFunction — success path", () => {
  it("returns body.response.result and POSTs function/parameters/devMode", async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/scripts/dep_1:run`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          done: true,
          response: {
            "@type":
              "type.googleapis.com/google.apps.script.v1.ExecutionResponse",
            result: { ok: 42 },
          },
        });
      }),
    );
    const res = await client().runFunction({
      id: "dep_1",
      functionName: "myFunc",
      parameters: ["Santo"],
      devMode: false,
    });
    expect(body).toEqual({
      function: "myFunc",
      parameters: ["Santo"],
      devMode: false,
    });
    expect(res).toEqual({ done: true, result: { ok: 42 } });
  });
});

describe("AppsScriptClient.runFunction — incomplete/odd operation (no false success)", () => {
  async function expectIncomplete(body: unknown): Promise<void> {
    server.use(
      http.post(`${API}/scripts/dep_1:run`, () =>
        HttpResponse.json(body as Record<string, unknown>, { status: 200 }),
      ),
    );
    try {
      await client().runFunction({
        id: "dep_1",
        functionName: "f",
        parameters: [],
        devMode: false,
      });
      throw new Error("expected UpstreamError");
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError);
      // The raw operation body is carried in .detail for debugging.
      expect((err as UpstreamError).detail).toEqual(body);
    }
  }

  it("an empty operation `{}` (no done, no response) is NOT success", async () => {
    await expectIncomplete({});
  });

  it("`{done:true}` with NO response object is NOT success", async () => {
    await expectIncomplete({ done: true });
  });

  it("an in-progress operation (no `done` field) is NOT success", async () => {
    await expectIncomplete({ metadata: { progress: 50 } });
  });
});

describe("AppsScriptClient.runFunction — HTTP 200 LIES (script-side error)", () => {
  it("inspects body.error BEFORE body.response and throws UpstreamError with the script stack", async () => {
    server.use(
      http.post(`${API}/scripts/dep_1:run`, () =>
        // HTTP 200 even though the script threw.
        HttpResponse.json(
          {
            done: true,
            error: {
              code: 3,
              message: "ScriptError",
              details: [
                {
                  "@type":
                    "type.googleapis.com/google.apps.script.v1.ExecutionError",
                  errorType: "ReferenceError",
                  errorMessage: "foo is not defined",
                  scriptStackTraceElements: [
                    { function: "myFunc", lineNumber: 12 },
                  ],
                },
              ],
            },
          },
          { status: 200 },
        ),
      ),
    );
    const c = client();
    await expect(
      c.runFunction({
        id: "dep_1",
        functionName: "myFunc",
        parameters: [],
        devMode: false,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);

    // And the surfaced error carries errorType/errorMessage + the stack trace.
    try {
      await c.runFunction({
        id: "dep_1",
        functionName: "myFunc",
        parameters: [],
        devMode: false,
      });
      throw new Error("expected UpstreamError");
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError);
      const e = err as UpstreamError;
      expect(e.message).toContain("ReferenceError");
      expect(e.message).toContain("foo is not defined");
      expect(e.detail).toMatchObject({
        errorType: "ReferenceError",
        errorMessage: "foo is not defined",
        scriptStackTraceElements: [{ function: "myFunc", lineNumber: 12 }],
      });
    }
  });
});

describe("AppsScriptClient.runFunction — missing setup", () => {
  it("rewrites a 403 into an actionable setup AuthError pointing at the README", async () => {
    server.use(
      http.post(`${API}/scripts/dep_1:run`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "PERMISSION_DENIED" } },
          { status: 403 },
        ),
      ),
    );
    try {
      await client().runFunction({
        id: "dep_1",
        functionName: "f",
        parameters: [],
        devMode: false,
      });
      throw new Error("expected AuthError");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      const e = err as AuthError;
      expect(e.message.toLowerCase()).toContain("one-time setup");
      expect(e.message).toContain("README");
      expect(e.message).toContain("API Executable");
    }
  });

  it("a 404 target points the caller at deployment-id / API Executable", async () => {
    server.use(
      http.post(`${API}/scripts/bad:run`, () =>
        HttpResponse.json({}, { status: 404 }),
      ),
    );
    await expect(
      client().runFunction({
        id: "bad",
        functionName: "f",
        parameters: [],
        devMode: false,
      }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });
});

// ============================================================================
// error mapping — the management-side 401/403 shapes
// ============================================================================

describe("AppsScriptClient — auth error mapping", () => {
  it("403 with the per-user toggle off points at usersettings", async () => {
    server.use(
      http.get(`${API}/projects/s1`, () =>
        HttpResponse.json(
          {
            error: {
              message:
                "User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings then retry.",
            },
          },
          { status: 403 },
        ),
      ),
    );
    try {
      await client().getProject("s1");
      throw new Error("expected AuthError");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toContain("usersettings");
    }
  });

  it("403 with accessNotConfigured points at enabling the API", async () => {
    server.use(
      http.get(`${API}/projects/s1`, () =>
        HttpResponse.json(
          {
            error: {
              status: "PERMISSION_DENIED",
              message: "Apps Script API has not been used in project 123 before",
              details: [{ reason: "SERVICE_DISABLED" }],
            },
          },
          { status: 403 },
        ),
      ),
    );
    try {
      await client().getProject("s1");
      throw new Error("expected AuthError");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toContain("not enabled");
    }
  });

  it("401 → AuthError telling the user to re-auth", async () => {
    server.use(
      http.get(`${API}/projects/s1`, () =>
        HttpResponse.json({}, { status: 401 }),
      ),
    );
    try {
      await client().getProject("s1");
      throw new Error("expected AuthError");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toContain("re-run");
    }
  });
});
