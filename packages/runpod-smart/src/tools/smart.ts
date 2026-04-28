import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import { launchPod } from "./pods.js";
import type { SlimPod } from "./pod-mapper.js";

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
