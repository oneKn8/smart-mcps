import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import { launchPod } from "./pods.js";
import type { SlimPod } from "./pod-mapper.js";
import { nullableString } from "./null-helpers.js";

// =============================================================================
// spin_training_pod — smart shortcut over launch_pod
// =============================================================================
//
// Maps (framework, cuda) -> a Runpod-published training image and delegates to
// launch_pod with sensible training defaults: a 100GB persistent volume mounted
// at /workspace, Jupyter (8888/http) and SSH (22/tcp) exposed, and a placeholder
// JUPYTER_PASSWORD env var. Users wanting a different image, ports, or env can
// call launch_pod directly — this is a convenience layer, not a replacement.
//
// Image tag honesty: the table below is the best-effort mapping of common
// framework+CUDA combinations to images on the runpod/* Docker Hub namespace.
// Runpod retags frequently; if a specific tag has been removed or renamed
// upstream, launch_pod will surface a CreatePodError. In that case the caller
// should override by calling launch_pod with an explicit image string.

type Framework = "pytorch" | "tensorflow" | "jax";
type CudaVer = "11.8" | "12.1" | "12.4";

export const TRAINING_IMAGES: Record<Framework, Record<CudaVer, string>> = {
  pytorch: {
    "11.8": "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04",
    "12.1": "runpod/pytorch:2.4.0-py3.11-cuda12.1.1-devel-ubuntu22.04",
    "12.4": "runpod/pytorch:2.5.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
  },
  tensorflow: {
    "11.8": "runpod/tensorflow:2.13.0-py3.10-cuda11.8-ubuntu22.04",
    "12.1": "runpod/tensorflow:2.15.0-py3.11-cuda12.1-ubuntu22.04",
    "12.4": "runpod/tensorflow:2.17.0-py3.11-cuda12.4-ubuntu22.04",
  },
  jax: {
    "11.8": "runpod/jax:0.4.20-py3.10-cuda11.8-ubuntu22.04",
    "12.1": "runpod/jax:0.4.30-py3.11-cuda12.1-ubuntu22.04",
    "12.4": "runpod/jax:0.4.35-py3.11-cuda12.4-ubuntu22.04",
  },
};

const spinTrainingPodInputSchema = z.object({
  name: z.string().min(1),
  framework: z.enum(["pytorch", "tensorflow", "jax"]).optional().default("pytorch"),
  cuda: z.enum(["11.8", "12.1", "12.4"]).optional().default("12.1"),
  gpu: z.string().optional(),
  gpu_count: z.number().int().min(1).max(8).optional().default(1),
  volume_gb: z.number().int().min(0).max(2000).optional().default(100),
  confirm: z.boolean().optional().default(false),
});

type SpinTrainingPodInput = z.infer<typeof spinTrainingPodInputSchema>;

type SpinTrainingPodOutput = SlimPod & {
  connect_hint: string;
};

export const spinTrainingPod = defineTool<
  SpinTrainingPodInput,
  SpinTrainingPodOutput,
  RunpodContext
>({
  name: "spin_training_pod",
  description: "Launch a pre-configured GPU pod for ML training.",
  // Cast required: many fields use `.optional().default(...)`, so the schema's
  // input type is wider than the resolved output type the handler receives.
  inputSchema: spinTrainingPodInputSchema as unknown as z.ZodType<SpinTrainingPodInput>,
  handler: async (input, context) => {
    const image = TRAINING_IMAGES[input.framework][input.cuda];
    if (!image) {
      // Unreachable while the lookup table covers every (framework, cuda)
      // pair the schema accepts. Defensive in case the table is ever pared
      // down without updating the enums.
      throw new Error(
        `No training image for framework=${input.framework} cuda=${input.cuda}`,
      );
    }

    // Delegate everything else (confirm gate, GPU resolution, snake->camel
    // mapping, connect_hint) to launchPod's handler. We re-parse through
    // launchPod.inputSchema so its defaults (cloud_type, container_disk_gb,
    // interruptible) apply consistently.
    const launchInput = launchPod.inputSchema.parse({
      name: input.name,
      image,
      gpu: input.gpu,
      gpu_count: input.gpu_count,
      cloud_type: "SECURE",
      container_disk_gb: 50,
      volume_gb: input.volume_gb,
      volume_mount_path: "/workspace",
      ports: ["8888/http", "22/tcp"],
      // Placeholder password: the user is expected to override via launch_pod
      // for any non-throwaway pod. Documented in the tool's README.
      env: { JUPYTER_PASSWORD: "changeme" },
      interruptible: false,
      confirm: input.confirm,
    });

    return await launchPod.handler(launchInput, context);
  },
});

// =============================================================================
// kill_idle_pods — destructive bulk-stop shortcut
// =============================================================================
//
// Lists RUNNING pods, filters those whose `lastStartedAt` is older than
// `older_than_hours` ago, and (with confirm=true and dry_run=false) issues
// sequential stopPod calls. The tool follows a two-step preview/apply pattern:
//
//   1. Default call (dry_run=true) → returns the candidate list and the
//      total per-hour savings estimate, but never touches anything. The
//      caller inspects, then decides.
//   2. Apply call (dry_run=false, confirm=true) → walks the candidate list
//      and stops each pod sequentially. Failures don't abort the loop;
//      each pod gets its own { ok, error? } entry in `stopped`.
//
// Edge cases:
// - dry_run=true wins over confirm. If both are set, we still don't stop.
// - Pods missing `lastStartedAt` (or with malformed timestamps) can't be
//   judged for idleness, so they're silently skipped from the candidate set.
// - Empty candidate set on an apply call short-circuits the confirm gate
//   (stopping zero pods isn't destructive).

const killIdlePodsInputSchema = z.object({
  older_than_hours: z.number().int().min(1).max(720).optional().default(24),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
});

type KillIdlePodsInput = z.infer<typeof killIdlePodsInputSchema>;

type KillIdlePodCandidate = {
  id: string;
  name: string | null;
  started_at: string | null;
  hours_running: number;
  costPerHr: number;
};

type KillIdlePodStopped = {
  id: string;
  ok: boolean;
  error?: string;
};

type KillIdlePodsOutput = {
  scanned: number;
  candidates: KillIdlePodCandidate[];
  stopped: KillIdlePodStopped[];
  total_savings_estimate_per_hr: number;
};

export const killIdlePods = defineTool<
  KillIdlePodsInput,
  KillIdlePodsOutput,
  RunpodContext
>({
  name: "kill_idle_pods",
  description: "Stop pods running > N hours without recent activity.",
  // Cast required: schema's input type is wider than the resolved output
  // type (every field is `.optional().default(...)`).
  inputSchema: killIdlePodsInputSchema as unknown as z.ZodType<KillIdlePodsInput>,
  handler: async (input, context) => {
    const now = Date.now();
    const cutoff = now - input.older_than_hours * 3600 * 1000;

    const { pods } = await context.client.listPods({ desiredStatus: "RUNNING" });

    const candidates: KillIdlePodCandidate[] = [];
    for (const pod of pods) {
      const record = pod as Record<string, unknown>;
      const startedRaw = record.lastStartedAt;
      // No timestamp -> can't judge idleness; skip rather than guess.
      if (typeof startedRaw !== "string") continue;
      const startedMs = Date.parse(startedRaw);
      if (Number.isNaN(startedMs)) continue;
      // Not old enough yet.
      if (startedMs >= cutoff) continue;

      // Round hours_running to 1 decimal place.
      const hoursRunning =
        Math.round(((now - startedMs) / 3600 / 1000) * 10) / 10;

      candidates.push({
        id: typeof record.id === "string" ? record.id : "",
        name: nullableString(record.name),
        started_at: startedRaw,
        hours_running: hoursRunning,
        costPerHr: typeof record.costPerHr === "number" ? record.costPerHr : 0,
      });
    }

    const total_savings_estimate_per_hr = candidates.reduce(
      (sum, c) => sum + c.costPerHr,
      0,
    );
    const scanned = pods.length;

    // dry_run wins. Even if confirm=true, dry_run=true means preview only.
    if (input.dry_run) {
      return {
        scanned,
        candidates,
        stopped: [],
        total_savings_estimate_per_hr,
      };
    }

    // Apply path. Empty candidate set short-circuits the confirm gate —
    // stopping zero pods isn't destructive, no need to round-trip the user.
    if (candidates.length === 0) {
      return {
        scanned,
        candidates,
        stopped: [],
        total_savings_estimate_per_hr,
      };
    }

    guardDestructive({
      confirm: input.confirm,
      preview:
        `Will stop ${candidates.length} pod(s) idle > ${input.older_than_hours}h, ` +
        `saving ~$${total_savings_estimate_per_hr.toFixed(2)}/hr`,
    });

    // Sequential awaits: a parallel Promise.all would race the upstream API
    // and obscure per-pod failures. Sequential is also kinder on rate limits
    // and produces a stable callback order for tests.
    const stopped: KillIdlePodStopped[] = [];
    for (const candidate of candidates) {
      try {
        await context.client.stopPod(candidate.id);
        stopped.push({ id: candidate.id, ok: true });
      } catch (err) {
        stopped.push({
          id: candidate.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      scanned,
      candidates,
      stopped,
      total_savings_estimate_per_hr,
    };
  },
});
