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
import { AuthError, RateLimitError } from "smart-mcp-core";
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
