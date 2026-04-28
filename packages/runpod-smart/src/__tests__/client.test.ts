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
import { AuthError, NotFoundError, RateLimitError } from "smart-mcp-core";
import { RunpodClient } from "../client.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.RUNPOD_API_KEY;
  delete process.env.RUNPOD_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.RUNPOD_API_KEY;
  else process.env.RUNPOD_API_KEY = savedKey;
});

describe("RunpodClient — constructor", () => {
  it("reads creds via loadCreds when RUNPOD_API_KEY is set", () => {
    process.env.RUNPOD_API_KEY = "test_key";
    expect(() => new RunpodClient()).not.toThrow();
  });

  it("throws AuthError when RUNPOD_API_KEY is missing", () => {
    expect(() => new RunpodClient()).toThrowError(AuthError);
  });
});

describe("RunpodClient.listPods", () => {
  const mockPods = [
    {
      id: "pod_abc",
      name: "training-rig",
      image: "runpod/pytorch:2.1.0",
      desiredStatus: "RUNNING",
      costPerHr: 0.74,
      adjustedCostPerHr: 0.69,
      gpu: { displayName: "RTX 4090" },
      lastStartedAt: "2026-04-26T18:00:00.000Z",
    },
    {
      id: "pod_def",
      name: "inference",
      image: "runpod/vllm:latest",
      desiredStatus: "EXITED",
      costPerHr: 0.34,
      adjustedCostPerHr: 0.34,
      gpu: { displayName: "RTX 3090" },
      lastStartedAt: "2026-04-20T12:00:00.000Z",
    },
  ];

  it("calls GET https://rest.runpod.io/v1/pods with bearer header", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://rest.runpod.io/v1/pods", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = request.url;
        return HttpResponse.json(mockPods);
      }),
    );
    const client = new RunpodClient();
    await client.listPods();
    expect(seenAuth).toBe("Bearer test_key");
    expect(seenUrl).toContain("https://rest.runpod.io/v1/pods");
  });

  it("passes desiredStatus as a query param when provided", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let seenUrl: string | null = null;
    server.use(
      http.get("https://rest.runpod.io/v1/pods", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockPods.filter((p) => p.desiredStatus === "RUNNING"));
      }),
    );
    const client = new RunpodClient();
    await client.listPods({ desiredStatus: "RUNNING" });
    expect(seenUrl).toContain("desiredStatus=RUNNING");
  });

  it("omits desiredStatus from query when not provided", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let seenUrl: string | null = null;
    server.use(
      http.get("https://rest.runpod.io/v1/pods", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockPods);
      }),
    );
    const client = new RunpodClient();
    await client.listPods();
    expect(seenUrl).not.toContain("desiredStatus=");
  });

  it("returns parsed body normalized to { pods: Pod[] }", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    server.use(
      http.get("https://rest.runpod.io/v1/pods", () =>
        HttpResponse.json(mockPods),
      ),
    );
    const client = new RunpodClient();
    const result = await client.listPods();
    expect(result.pods).toHaveLength(2);
    expect(result.pods[0]?.id).toBe("pod_abc");
    expect(result.pods[1]?.id).toBe("pod_def");
  });

  it("maps 401 to AuthError mentioning RUNPOD_API_KEY", async () => {
    process.env.RUNPOD_API_KEY = "bad_key";
    server.use(
      http.get("https://rest.runpod.io/v1/pods", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    const client = new RunpodClient();
    try {
      await client.listPods();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("RUNPOD_API_KEY");
    }
  });

  it("retries 429 then throws RateLimitError after retries exhausted", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let calls = 0;
    server.use(
      http.get("https://rest.runpod.io/v1/pods", () => {
        calls++;
        return HttpResponse.json({ error: "slow down" }, { status: 429 });
      }),
    );
    const client = new RunpodClient();
    await expect(client.listPods()).rejects.toBeInstanceOf(RateLimitError);
    // fetchJson default: initial + 3 retries = 4 calls on persistent 429
    expect(calls).toBe(4);
  });
});

describe("RunpodClient.getPod", () => {
  const mockPod = {
    id: "pod_abc",
    name: "training-rig",
    image: "runpod/pytorch:2.1.0",
    desiredStatus: "RUNNING",
    costPerHr: 0.74,
    adjustedCostPerHr: 0.69,
    gpu: { displayName: "RTX 4090" },
    lastStartedAt: "2026-04-26T18:00:00.000Z",
  };

  it("calls GET /pods/<id> and returns the pod", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://rest.runpod.io/v1/pods/pod_abc", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = request.url;
        return HttpResponse.json(mockPod);
      }),
    );
    const client = new RunpodClient();
    const result = await client.getPod("pod_abc");
    expect(seenAuth).toBe("Bearer test_key");
    expect(seenUrl).toContain("/v1/pods/pod_abc");
    expect(result.id).toBe("pod_abc");
  });

  it("encodes pod IDs containing special characters", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let seenUrl: string | null = null;
    server.use(
      http.get("https://rest.runpod.io/v1/pods/:podId", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({ ...mockPod, id: "pod-abc%20" });
      }),
    );
    const client = new RunpodClient();
    await client.getPod("pod-abc ");
    // URL must contain the encoded form, not the raw space
    expect(seenUrl).toContain("/v1/pods/pod-abc%20");
    expect(seenUrl).not.toContain("/v1/pods/pod-abc ");
  });

  it("maps 404 to NotFoundError with 'Pod not found: <id>' message", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    server.use(
      http.get("https://rest.runpod.io/v1/pods/missing_pod", () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    const client = new RunpodClient();
    try {
      await client.getPod("missing_pod");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe("Pod not found: missing_pod");
    }
  });

  it("maps 401 to AuthError mentioning RUNPOD_API_KEY", async () => {
    process.env.RUNPOD_API_KEY = "bad_key";
    server.use(
      http.get("https://rest.runpod.io/v1/pods/pod_abc", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    const client = new RunpodClient();
    try {
      await client.getPod("pod_abc");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("RUNPOD_API_KEY");
    }
  });
});

describe("RunpodClient.startPod", () => {
  const mockPod = {
    id: "pod_abc",
    desiredStatus: "RUNNING",
    costPerHr: 0.74,
    adjustedCostPerHr: 0.69,
  };

  it("POSTs /pods/<id>/start and returns the updated pod", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    let seenAuth: string | null = null;
    server.use(
      http.post(
        "https://rest.runpod.io/v1/pods/pod_abc/start",
        ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          seenAuth = request.headers.get("authorization");
          return HttpResponse.json(mockPod);
        },
      ),
    );
    const client = new RunpodClient();
    const result = await client.startPod("pod_abc");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toContain("/v1/pods/pod_abc/start");
    expect(seenAuth).toBe("Bearer test_key");
    expect(result.id).toBe("pod_abc");
  });

  it("maps 404 to NotFoundError with 'Pod not found: <id>'", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    server.use(
      http.post("https://rest.runpod.io/v1/pods/missing/start", () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    const client = new RunpodClient();
    try {
      await client.startPod("missing");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe("Pod not found: missing");
    }
  });
});

describe("RunpodClient.stopPod", () => {
  const mockPod = {
    id: "pod_abc",
    desiredStatus: "STOPPED",
    costPerHr: 0.74,
    adjustedCostPerHr: 0.69,
  };

  it("POSTs /pods/<id>/stop and returns the updated pod", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.post(
        "https://rest.runpod.io/v1/pods/pod_abc/stop",
        ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          return HttpResponse.json(mockPod);
        },
      ),
    );
    const client = new RunpodClient();
    const result = await client.stopPod("pod_abc");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toContain("/v1/pods/pod_abc/stop");
    expect(result.id).toBe("pod_abc");
  });

  it("maps 404 to NotFoundError with 'Pod not found: <id>'", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    server.use(
      http.post("https://rest.runpod.io/v1/pods/missing/stop", () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    const client = new RunpodClient();
    try {
      await client.stopPod("missing");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe("Pod not found: missing");
    }
  });
});

describe("RunpodClient.createPod", () => {
  const mockCreated = {
    id: "pod_new",
    name: "fresh",
    image: "runpod/pytorch:2.1.0",
    desiredStatus: "CREATED",
    costPerHr: 0.74,
    adjustedCostPerHr: 0.74,
    gpu: { displayName: "RTX 4090" },
    gpuCount: 1,
  };

  it("POSTs /pods with bearer header and returns parsed pod", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let seenAuth: string | null = null;
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.post("https://rest.runpod.io/v1/pods", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenMethod = request.method;
        seenUrl = request.url;
        return HttpResponse.json(mockCreated);
      }),
    );
    const client = new RunpodClient();
    const result = await client.createPod({ name: "fresh", imageName: "runpod/pytorch:2.1.0" });
    expect(seenAuth).toBe("Bearer test_key");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toContain("https://rest.runpod.io/v1/pods");
    expect(result.id).toBe("pod_new");
  });

  it("JSON-encodes the body exactly as passed", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let seenBody: unknown = null;
    server.use(
      http.post("https://rest.runpod.io/v1/pods", async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json(mockCreated);
      }),
    );
    const client = new RunpodClient();
    const body = {
      name: "fresh",
      imageName: "runpod/pytorch:2.1.0",
      gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
      gpuCount: 2,
      cloudType: "SECURE",
      containerDiskInGb: 100,
    };
    await client.createPod(body);
    expect(seenBody).toEqual(body);
  });

  it("returns the parsed pod response", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    server.use(
      http.post("https://rest.runpod.io/v1/pods", () =>
        HttpResponse.json(mockCreated),
      ),
    );
    const client = new RunpodClient();
    const result = await client.createPod({ name: "fresh", imageName: "x" });
    expect(result).toMatchObject({
      id: "pod_new",
      name: "fresh",
      desiredStatus: "CREATED",
    });
  });

  it("maps 401 to AuthError mentioning RUNPOD_API_KEY", async () => {
    process.env.RUNPOD_API_KEY = "bad_key";
    server.use(
      http.post("https://rest.runpod.io/v1/pods", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    const client = new RunpodClient();
    try {
      await client.createPod({ name: "x", imageName: "y" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("RUNPOD_API_KEY");
    }
  });

  it("retries 429 then throws RateLimitError after retries exhausted", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let calls = 0;
    server.use(
      http.post("https://rest.runpod.io/v1/pods", () => {
        calls++;
        return HttpResponse.json({ error: "slow down" }, { status: 429 });
      }),
    );
    const client = new RunpodClient();
    await expect(
      client.createPod({ name: "x", imageName: "y" }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toBe(4);
  });
});

describe("RunpodClient — RUNPOD_DEFAULT_GPU optional cred", () => {
  let savedDefault: string | undefined;
  beforeEach(() => {
    savedDefault = process.env.RUNPOD_DEFAULT_GPU;
    delete process.env.RUNPOD_DEFAULT_GPU;
  });
  afterEach(() => {
    if (savedDefault === undefined) delete process.env.RUNPOD_DEFAULT_GPU;
    else process.env.RUNPOD_DEFAULT_GPU = savedDefault;
  });

  it("exposes defaultGpu as undefined when RUNPOD_DEFAULT_GPU is unset", () => {
    process.env.RUNPOD_API_KEY = "test_key";
    const client = new RunpodClient();
    expect(client.defaultGpu).toBeUndefined();
  });

  it("exposes defaultGpu when RUNPOD_DEFAULT_GPU is set", () => {
    process.env.RUNPOD_API_KEY = "test_key";
    process.env.RUNPOD_DEFAULT_GPU = "NVIDIA RTX A6000";
    const client = new RunpodClient();
    expect(client.defaultGpu).toBe("NVIDIA RTX A6000");
  });
});

describe("RunpodClient.terminatePod", () => {
  it("DELETEs /pods/<id> and returns void on 204", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.delete(
        "https://rest.runpod.io/v1/pods/pod_abc",
        ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const client = new RunpodClient();
    const result = await client.terminatePod("pod_abc");
    expect(seenMethod).toBe("DELETE");
    expect(seenUrl).toContain("/v1/pods/pod_abc");
    expect(result).toBeUndefined();
  });

  it("maps 404 to NotFoundError with 'Pod not found: <id>'", async () => {
    process.env.RUNPOD_API_KEY = "test_key";
    server.use(
      http.delete("https://rest.runpod.io/v1/pods/missing", () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    const client = new RunpodClient();
    try {
      await client.terminatePod("missing");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toBe("Pod not found: missing");
    }
  });
});
