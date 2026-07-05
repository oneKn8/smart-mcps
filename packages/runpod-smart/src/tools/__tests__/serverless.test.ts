import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  runEndpoint,
  runSync,
  getJobStatus,
  cancelJob,
  endpointHealth,
  purgeQueue,
} from "../serverless.js";

type FakeClient = {
  runEndpoint: ReturnType<typeof vi.fn>;
  runEndpointSync: ReturnType<typeof vi.fn>;
  getJobStatus: ReturnType<typeof vi.fn>;
  cancelJob: ReturnType<typeof vi.fn>;
  endpointHealth: ReturnType<typeof vi.fn>;
  purgeQueue: ReturnType<typeof vi.fn>;
};

// A COMPLETED sync job with upstream extras the slim mapper must strip.
const sampleJob = {
  id: "job_abc",
  status: "COMPLETED",
  output: { text: "hello world" },
  delayTime: 120,
  executionTime: 3400,
  // upstream-only fields that must NOT pass through:
  workerId: "worker_xyz",
  retries: 0,
  error: null,
};

const sampleAsyncJob = { id: "job_new", status: "IN_QUEUE" };

const sampleHealth = {
  jobs: { completed: 5, failed: 1, inProgress: 2, inQueue: 3, retried: 0 },
  workers: { idle: 1, initializing: 0, ready: 2, running: 2, throttled: 0, unhealthy: 0 },
};

const samplePurge = { removed: 7, status: "completed" };

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    runEndpoint: vi.fn().mockResolvedValue(sampleAsyncJob),
    runEndpointSync: vi.fn().mockResolvedValue(sampleJob),
    getJobStatus: vi.fn().mockResolvedValue(sampleJob),
    cancelJob: vi.fn().mockResolvedValue({ id: "job_abc", status: "CANCELLED" }),
    endpointHealth: vi.fn().mockResolvedValue(sampleHealth),
    purgeQueue: vi.fn().mockResolvedValue(samplePurge),
    ...overrides,
  };
}

// =============================================================================
// run_endpoint
// =============================================================================

describe("runEndpoint — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(runEndpoint.name).toBe("run_endpoint");
    expect(runEndpoint.description).toBe(
      "Submit an async job to a serverless endpoint.",
    );
    expect(runEndpoint.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = runEndpoint.inputSchema.parse({
      endpoint_id: "ep_1",
      input: { prompt: "hi" },
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty endpoint_id", () => {
    expect(() =>
      runEndpoint.inputSchema.parse({ endpoint_id: "", input: {} }),
    ).toThrow();
  });

  it("rejects a missing input field", () => {
    expect(() =>
      runEndpoint.inputSchema.parse({ endpoint_id: "ep_1" }),
    ).toThrow();
  });
});

describe("runEndpoint — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      runEndpoint.handler(
        runEndpoint.inputSchema.parse({
          endpoint_id: "ep_1",
          input: { prompt: "hi" },
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.runEndpoint).not.toHaveBeenCalled();
  });

  it("preview contains the endpoint id and 'async job'", async () => {
    const client = makeClient();
    try {
      await runEndpoint.handler(
        runEndpoint.inputSchema.parse({
          endpoint_id: "ep_1",
          input: { prompt: "hi" },
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("ep_1");
      expect(preview).toMatch(/async job/i);
    }
  });
});

describe("runEndpoint — past confirm gate", () => {
  it("calls client.runEndpoint with id + input only when no webhook", async () => {
    const client = makeClient();
    await runEndpoint.handler(
      runEndpoint.inputSchema.parse({
        endpoint_id: "ep_1",
        input: { prompt: "hi" },
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.runEndpoint).toHaveBeenCalledTimes(1);
    expect(client.runEndpoint).toHaveBeenCalledWith("ep_1", { prompt: "hi" });
  });

  it("forwards webhook as extra only when provided", async () => {
    const client = makeClient();
    await runEndpoint.handler(
      runEndpoint.inputSchema.parse({
        endpoint_id: "ep_1",
        input: { prompt: "hi" },
        webhook: "https://hook.example/cb",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.runEndpoint).toHaveBeenCalledWith(
      "ep_1",
      { prompt: "hi" },
      { webhook: "https://hook.example/cb" },
    );
  });

  it("returns the { job_id, status } slim shape (exact keys)", async () => {
    const client = makeClient();
    const result = (await runEndpoint.handler(
      runEndpoint.inputSchema.parse({
        endpoint_id: "ep_1",
        input: { prompt: "hi" },
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["job_id", "status"].sort());
    expect(result).toEqual({ job_id: "job_new", status: "IN_QUEUE" });
  });

  it("null-safes job_id and status when upstream omits them", async () => {
    const client = makeClient({
      runEndpoint: vi.fn().mockResolvedValue({}),
    });
    const result = (await runEndpoint.handler(
      runEndpoint.inputSchema.parse({
        endpoint_id: "ep_1",
        input: {},
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as { job_id: string | null; status: string | null };
    expect(result.job_id).toBeNull();
    expect(result.status).toBeNull();
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      runEndpoint: vi.fn().mockRejectedValue(
        new NotFoundError("Endpoint not found: ep_x"),
      ),
    });
    await expect(
      runEndpoint.handler(
        runEndpoint.inputSchema.parse({
          endpoint_id: "ep_x",
          input: {},
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// run_sync
// =============================================================================

describe("runSync — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(runSync.name).toBe("run_sync");
    expect(runSync.description).toBe(
      "Run a serverless job and wait for the result.",
    );
    expect(runSync.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = runSync.inputSchema.parse({
      endpoint_id: "ep_1",
      input: {},
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });
});

describe("runSync — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false", async () => {
    const client = makeClient();
    await expect(
      runSync.handler(
        runSync.inputSchema.parse({ endpoint_id: "ep_1", input: {} }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.runEndpointSync).not.toHaveBeenCalled();
  });

  it("preview contains the endpoint id and 'synchronous'", async () => {
    const client = makeClient();
    try {
      await runSync.handler(
        runSync.inputSchema.parse({ endpoint_id: "ep_9", input: {} }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("ep_9");
      expect(preview).toMatch(/synchronous/i);
    }
  });
});

describe("runSync — past confirm gate", () => {
  it("calls client.runEndpointSync with id + input only when no webhook", async () => {
    const client = makeClient();
    await runSync.handler(
      runSync.inputSchema.parse({
        endpoint_id: "ep_1",
        input: { prompt: "hi" },
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.runEndpointSync).toHaveBeenCalledWith("ep_1", { prompt: "hi" });
  });

  it("forwards webhook as extra only when provided", async () => {
    const client = makeClient();
    await runSync.handler(
      runSync.inputSchema.parse({
        endpoint_id: "ep_1",
        input: { prompt: "hi" },
        webhook: "https://hook.example/cb",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.runEndpointSync).toHaveBeenCalledWith(
      "ep_1",
      { prompt: "hi" },
      { webhook: "https://hook.example/cb" },
    );
  });

  it("maps the full slim job shape and strips upstream extras", async () => {
    const client = makeClient();
    const result = (await runSync.handler(
      runSync.inputSchema.parse({ endpoint_id: "ep_1", input: {}, confirm: true }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(
      ["delay_ms", "execution_ms", "job_id", "output", "status"].sort(),
    );
    expect(result).toEqual({
      job_id: "job_abc",
      status: "COMPLETED",
      output: { text: "hello world" },
      delay_ms: 120,
      execution_ms: 3400,
    });
    expect(result).not.toHaveProperty("delayTime");
    expect(result).not.toHaveProperty("executionTime");
    expect(result).not.toHaveProperty("workerId");
  });

  it("null-safes every field and defaults output to null when omitted", async () => {
    const client = makeClient({
      runEndpointSync: vi.fn().mockResolvedValue({}),
    });
    const result = (await runSync.handler(
      runSync.inputSchema.parse({ endpoint_id: "ep_1", input: {}, confirm: true }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(result).toEqual({
      job_id: null,
      status: null,
      output: null,
      delay_ms: null,
      execution_ms: null,
    });
  });

  it("preserves a falsy output value (0) rather than nulling it", async () => {
    const client = makeClient({
      runEndpointSync: vi.fn().mockResolvedValue({ id: "j", status: "COMPLETED", output: 0 }),
    });
    const result = (await runSync.handler(
      runSync.inputSchema.parse({ endpoint_id: "ep_1", input: {}, confirm: true }),
      { client: client as unknown as never },
    )) as { output: unknown };
    expect(result.output).toBe(0);
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      runEndpointSync: vi.fn().mockRejectedValue(
        new NotFoundError("Endpoint not found: ep_x"),
      ),
    });
    await expect(
      runSync.handler(
        runSync.inputSchema.parse({ endpoint_id: "ep_x", input: {}, confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// get_job_status
// =============================================================================

describe("getJobStatus — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getJobStatus.name).toBe("get_job_status");
    expect(getJobStatus.description).toBe(
      "Check a serverless job's status and output.",
    );
    expect(getJobStatus.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty endpoint_id and empty job_id", () => {
    expect(() =>
      getJobStatus.inputSchema.parse({ endpoint_id: "", job_id: "j" }),
    ).toThrow();
    expect(() =>
      getJobStatus.inputSchema.parse({ endpoint_id: "e", job_id: "" }),
    ).toThrow();
  });
});

describe("getJobStatus — handler", () => {
  it("calls client.getJobStatus with endpoint_id and job_id", async () => {
    const client = makeClient();
    await getJobStatus.handler(
      getJobStatus.inputSchema.parse({ endpoint_id: "ep_1", job_id: "job_abc" }),
      { client: client as unknown as never },
    );
    expect(client.getJobStatus).toHaveBeenCalledTimes(1);
    expect(client.getJobStatus).toHaveBeenCalledWith("ep_1", "job_abc");
  });

  it("returns the same slim job shape as run_sync", async () => {
    const client = makeClient();
    const result = (await getJobStatus.handler(
      getJobStatus.inputSchema.parse({ endpoint_id: "ep_1", job_id: "job_abc" }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(
      ["delay_ms", "execution_ms", "job_id", "output", "status"].sort(),
    );
    expect(result).toEqual({
      job_id: "job_abc",
      status: "COMPLETED",
      output: { text: "hello world" },
      delay_ms: 120,
      execution_ms: 3400,
    });
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      getJobStatus: vi.fn().mockRejectedValue(
        new NotFoundError("Endpoint not found: ep_x"),
      ),
    });
    await expect(
      getJobStatus.handler(
        getJobStatus.inputSchema.parse({ endpoint_id: "ep_x", job_id: "j" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// cancel_job
// =============================================================================

describe("cancelJob — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(cancelJob.name).toBe("cancel_job");
    expect(cancelJob.description).toBe(
      "Cancel a queued or running serverless job.",
    );
    expect(cancelJob.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = cancelJob.inputSchema.parse({
      endpoint_id: "ep_1",
      job_id: "job_abc",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty job_id", () => {
    expect(() =>
      cancelJob.inputSchema.parse({ endpoint_id: "ep_1", job_id: "" }),
    ).toThrow();
  });
});

describe("cancelJob — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false", async () => {
    const client = makeClient();
    await expect(
      cancelJob.handler(
        cancelJob.inputSchema.parse({ endpoint_id: "ep_1", job_id: "job_abc" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.cancelJob).not.toHaveBeenCalled();
  });

  it("preview contains the job id, endpoint id, and 'cancel'", async () => {
    const client = makeClient();
    try {
      await cancelJob.handler(
        cancelJob.inputSchema.parse({ endpoint_id: "ep_1", job_id: "job_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("job_abc");
      expect(preview).toContain("ep_1");
      expect(preview).toMatch(/cancel/i);
    }
  });
});

describe("cancelJob — past confirm gate", () => {
  it("calls client.cancelJob and returns { job_id, status }", async () => {
    const client = makeClient();
    const result = (await cancelJob.handler(
      cancelJob.inputSchema.parse({
        endpoint_id: "ep_1",
        job_id: "job_abc",
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(client.cancelJob).toHaveBeenCalledWith("ep_1", "job_abc");
    expect(Object.keys(result).sort()).toEqual(["job_id", "status"].sort());
    expect(result).toEqual({ job_id: "job_abc", status: "CANCELLED" });
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      cancelJob: vi.fn().mockRejectedValue(
        new NotFoundError("Endpoint not found: ep_x"),
      ),
    });
    await expect(
      cancelJob.handler(
        cancelJob.inputSchema.parse({
          endpoint_id: "ep_x",
          job_id: "j",
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// endpoint_health
// =============================================================================

describe("endpointHealth — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(endpointHealth.name).toBe("endpoint_health");
    expect(endpointHealth.description).toBe(
      "Serverless endpoint queue and worker health.",
    );
    expect(endpointHealth.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty endpoint_id", () => {
    expect(() => endpointHealth.inputSchema.parse({ endpoint_id: "" })).toThrow();
  });
});

describe("endpointHealth — handler", () => {
  it("calls client.endpointHealth with the endpoint id", async () => {
    const client = makeClient();
    await endpointHealth.handler(
      endpointHealth.inputSchema.parse({ endpoint_id: "ep_1" }),
      { client: client as unknown as never },
    );
    expect(client.endpointHealth).toHaveBeenCalledTimes(1);
    expect(client.endpointHealth).toHaveBeenCalledWith("ep_1");
  });

  it("passes numeric jobs/workers entries through and keeps only jobs+workers keys", async () => {
    const client = makeClient();
    const result = (await endpointHealth.handler(
      endpointHealth.inputSchema.parse({ endpoint_id: "ep_1" }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["jobs", "workers"].sort());
    expect(result.jobs).toEqual({
      completed: 5,
      failed: 1,
      inProgress: 2,
      inQueue: 3,
      retried: 0,
    });
    expect(result.workers).toEqual({
      idle: 1,
      initializing: 0,
      ready: 2,
      running: 2,
      throttled: 0,
      unhealthy: 0,
    });
  });

  it("drops non-numeric entries inside jobs/workers", async () => {
    const client = makeClient({
      endpointHealth: vi.fn().mockResolvedValue({
        jobs: { completed: 4, note: "n/a", inQueue: null },
        workers: { ready: 2, label: "prod" },
      }),
    });
    const result = (await endpointHealth.handler(
      endpointHealth.inputSchema.parse({ endpoint_id: "ep_1" }),
      { client: client as unknown as never },
    )) as { jobs: Record<string, number>; workers: Record<string, number> };
    expect(result.jobs).toEqual({ completed: 4 });
    expect(result.jobs).not.toHaveProperty("note");
    expect(result.jobs).not.toHaveProperty("inQueue");
    expect(result.workers).toEqual({ ready: 2 });
    expect(result.workers).not.toHaveProperty("label");
  });

  it("returns empty objects when jobs/workers are absent", async () => {
    const client = makeClient({
      endpointHealth: vi.fn().mockResolvedValue({}),
    });
    const result = (await endpointHealth.handler(
      endpointHealth.inputSchema.parse({ endpoint_id: "ep_1" }),
      { client: client as unknown as never },
    )) as { jobs: Record<string, number>; workers: Record<string, number> };
    expect(result.jobs).toEqual({});
    expect(result.workers).toEqual({});
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      endpointHealth: vi.fn().mockRejectedValue(
        new NotFoundError("Endpoint not found: ep_x"),
      ),
    });
    await expect(
      endpointHealth.handler(
        endpointHealth.inputSchema.parse({ endpoint_id: "ep_x" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// purge_queue
// =============================================================================

describe("purgeQueue — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(purgeQueue.name).toBe("purge_queue");
    expect(purgeQueue.description).toBe("Purge all queued jobs for an endpoint.");
    expect(purgeQueue.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = purgeQueue.inputSchema.parse({ endpoint_id: "ep_1" }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty endpoint_id", () => {
    expect(() =>
      purgeQueue.inputSchema.parse({ endpoint_id: "", confirm: true }),
    ).toThrow();
  });
});

describe("purgeQueue — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false", async () => {
    const client = makeClient();
    await expect(
      purgeQueue.handler(
        purgeQueue.inputSchema.parse({ endpoint_id: "ep_1" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.purgeQueue).not.toHaveBeenCalled();
  });

  it("preview contains the endpoint id and 'purge'", async () => {
    const client = makeClient();
    try {
      await purgeQueue.handler(
        purgeQueue.inputSchema.parse({ endpoint_id: "ep_7" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("ep_7");
      expect(preview).toMatch(/purge/i);
    }
  });
});

describe("purgeQueue — past confirm gate", () => {
  it("calls client.purgeQueue and returns { removed, status }", async () => {
    const client = makeClient();
    const result = (await purgeQueue.handler(
      purgeQueue.inputSchema.parse({ endpoint_id: "ep_1", confirm: true }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(client.purgeQueue).toHaveBeenCalledWith("ep_1");
    expect(Object.keys(result).sort()).toEqual(["removed", "status"].sort());
    expect(result).toEqual({ removed: 7, status: "completed" });
  });

  it("null-safes removed and status when upstream omits them", async () => {
    const client = makeClient({
      purgeQueue: vi.fn().mockResolvedValue({}),
    });
    const result = (await purgeQueue.handler(
      purgeQueue.inputSchema.parse({ endpoint_id: "ep_1", confirm: true }),
      { client: client as unknown as never },
    )) as { removed: number | null; status: string | null };
    expect(result.removed).toBeNull();
    expect(result.status).toBeNull();
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      purgeQueue: vi.fn().mockRejectedValue(
        new NotFoundError("Endpoint not found: ep_x"),
      ),
    });
    await expect(
      purgeQueue.handler(
        purgeQueue.inputSchema.parse({ endpoint_id: "ep_x", confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
