import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import { nullableNumber, nullableString } from "./null-helpers.js";

// =============================================================================
// Shared field schemas + slim mappers
// =============================================================================

const endpointIdSchema = z.string().min(1);
const jobIdSchema = z.string().min(1);

// Slim job view shared by run_sync + get_job_status. `output` passes through as
// an opaque `unknown` (the endpoint decides its own payload shape) but defaults
// to null when upstream omits it, so the key is always present.
type SlimJob = {
  job_id: string | null;
  status: string | null;
  output: unknown;
  delay_ms: number | null;
  execution_ms: number | null;
};

function mapJob(job: Record<string, unknown>): SlimJob {
  return {
    job_id: nullableString(job.id),
    status: nullableString(job.status),
    output: job.output ?? null,
    delay_ms: nullableNumber(job.delayTime),
    execution_ms: nullableNumber(job.executionTime),
  };
}

// Trimmed { job_id, status } view shared by run_endpoint + cancel_job, where the
// job's output is not yet available (async submit) or irrelevant (cancel).
type JobRef = {
  job_id: string | null;
  status: string | null;
};

function mapJobRef(job: Record<string, unknown>): JobRef {
  return {
    job_id: nullableString(job.id),
    status: nullableString(job.status),
  };
}

// Coerce an upstream count map (health.jobs / health.workers) into a clean
// Record<string, number>, keeping only entries whose value is actually a number.
// Non-numeric entries are dropped so the slim shape never leaks stray types.
function numericRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number") out[key] = v;
    }
  }
  return out;
}

// =============================================================================
// run_endpoint
// =============================================================================

const runEndpointInputSchema = z.object({
  endpoint_id: endpointIdSchema,
  input: z.record(z.string(), z.unknown()),
  webhook: z.string().min(1).optional(),
  confirm: z.boolean().optional().default(false),
});

type RunEndpointInput = z.infer<typeof runEndpointInputSchema>;

export const runEndpoint = defineTool<RunEndpointInput, JobRef, RunpodContext>({
  name: "run_endpoint",
  description: "Submit an async job to a serverless endpoint.",
  // Cast required: `confirm` uses `.optional().default(false)`, so the schema's
  // input type (`confirm?: boolean`) is wider than the resolved output type the
  // handler receives — z.ZodType<Input> is invariant over ZodDefault.
  inputSchema: runEndpointInputSchema as unknown as z.ZodType<RunEndpointInput>,
  handler: async (input, context) => {
    const preview = `Will submit async job to endpoint ${input.endpoint_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    // Only forward `webhook` when the caller provided it (omit undefined).
    const job =
      input.webhook !== undefined
        ? await context.client.runEndpoint(input.endpoint_id, input.input, {
            webhook: input.webhook,
          })
        : await context.client.runEndpoint(input.endpoint_id, input.input);
    return mapJobRef(job as Record<string, unknown>);
  },
});

// =============================================================================
// run_sync
// =============================================================================

const runSyncInputSchema = z.object({
  endpoint_id: endpointIdSchema,
  input: z.record(z.string(), z.unknown()),
  webhook: z.string().min(1).optional(),
  confirm: z.boolean().optional().default(false),
});

type RunSyncInput = z.infer<typeof runSyncInputSchema>;

export const runSync = defineTool<RunSyncInput, SlimJob, RunpodContext>({
  name: "run_sync",
  description: "Run a serverless job and wait for the result.",
  // Cast required: `confirm` uses `.optional().default(false)`, so the schema's
  // input type (`confirm?: boolean`) is wider than the resolved output type the
  // handler receives — z.ZodType<Input> is invariant over ZodDefault.
  inputSchema: runSyncInputSchema as unknown as z.ZodType<RunSyncInput>,
  handler: async (input, context) => {
    const preview = `Will run a synchronous job on endpoint ${input.endpoint_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    const job =
      input.webhook !== undefined
        ? await context.client.runEndpointSync(input.endpoint_id, input.input, {
            webhook: input.webhook,
          })
        : await context.client.runEndpointSync(input.endpoint_id, input.input);
    return mapJob(job as Record<string, unknown>);
  },
});

// =============================================================================
// get_job_status
// =============================================================================

const getJobStatusInputSchema = z.object({
  endpoint_id: endpointIdSchema,
  job_id: jobIdSchema,
});

type GetJobStatusInput = z.infer<typeof getJobStatusInputSchema>;

export const getJobStatus = defineTool<GetJobStatusInput, SlimJob, RunpodContext>({
  name: "get_job_status",
  description: "Check a serverless job's status and output.",
  inputSchema: getJobStatusInputSchema,
  handler: async (input, context) => {
    const job = await context.client.getJobStatus(input.endpoint_id, input.job_id);
    return mapJob(job as Record<string, unknown>);
  },
});

// =============================================================================
// cancel_job
// =============================================================================

const cancelJobInputSchema = z.object({
  endpoint_id: endpointIdSchema,
  job_id: jobIdSchema,
  confirm: z.boolean().optional().default(false),
});

type CancelJobInput = z.infer<typeof cancelJobInputSchema>;

export const cancelJob = defineTool<CancelJobInput, JobRef, RunpodContext>({
  name: "cancel_job",
  description: "Cancel a queued or running serverless job.",
  // Cast required: `confirm` uses `.optional().default(false)`, so the schema's
  // input type (`confirm?: boolean`) is wider than the resolved output type the
  // handler receives — z.ZodType<Input> is invariant over ZodDefault.
  inputSchema: cancelJobInputSchema as unknown as z.ZodType<CancelJobInput>,
  handler: async (input, context) => {
    const preview = `Will cancel job ${input.job_id} on endpoint ${input.endpoint_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    const job = await context.client.cancelJob(input.endpoint_id, input.job_id);
    return mapJobRef(job as Record<string, unknown>);
  },
});

// =============================================================================
// endpoint_health
// =============================================================================

const endpointHealthInputSchema = z.object({
  endpoint_id: endpointIdSchema,
});

type EndpointHealthInput = z.infer<typeof endpointHealthInputSchema>;

type EndpointHealthOutput = {
  jobs: Record<string, number>;
  workers: Record<string, number>;
};

export const endpointHealth = defineTool<
  EndpointHealthInput,
  EndpointHealthOutput,
  RunpodContext
>({
  name: "endpoint_health",
  description: "Serverless endpoint queue and worker health.",
  inputSchema: endpointHealthInputSchema,
  handler: async (input, context) => {
    const health = (await context.client.endpointHealth(
      input.endpoint_id,
    )) as Record<string, unknown>;
    return {
      jobs: numericRecord(health.jobs),
      workers: numericRecord(health.workers),
    };
  },
});

// =============================================================================
// purge_queue
// =============================================================================

const purgeQueueInputSchema = z.object({
  endpoint_id: endpointIdSchema,
  confirm: z.boolean().optional().default(false),
});

type PurgeQueueInput = z.infer<typeof purgeQueueInputSchema>;

type PurgeQueueOutput = {
  removed: number | null;
  status: string | null;
};

export const purgeQueue = defineTool<PurgeQueueInput, PurgeQueueOutput, RunpodContext>({
  name: "purge_queue",
  description: "Purge all queued jobs for an endpoint.",
  // Cast required: `confirm` uses `.optional().default(false)`, so the schema's
  // input type (`confirm?: boolean`) is wider than the resolved output type the
  // handler receives — z.ZodType<Input> is invariant over ZodDefault.
  inputSchema: purgeQueueInputSchema as unknown as z.ZodType<PurgeQueueInput>,
  handler: async (input, context) => {
    const preview = `Will purge the job queue for endpoint ${input.endpoint_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    const result = (await context.client.purgeQueue(
      input.endpoint_id,
    )) as Record<string, unknown>;
    return {
      removed: nullableNumber(result.removed),
      status: nullableString(result.status),
    };
  },
});
