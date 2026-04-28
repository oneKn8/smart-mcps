import { nullableString } from "./null-helpers.js";

export type SlimPod = {
  id: string;
  name: string | null;
  status: string;
  image: string | null;
  gpu: { displayName: string; count: number };
  costPerHr: number;
  adjustedCostPerHr: number;
  lastStartedAt: string | null;
};

function pickGpu(pod: Record<string, unknown>): { displayName: string; count: number } {
  const gpuField = pod.gpu;
  const displayName =
    gpuField && typeof gpuField === "object" && gpuField !== null
      ? typeof (gpuField as { displayName?: unknown }).displayName === "string"
        ? ((gpuField as { displayName: string }).displayName)
        : ""
      : "";
  const rawCount = (pod as { gpuCount?: unknown }).gpuCount;
  const count = typeof rawCount === "number" ? rawCount : 0;
  return { displayName, count };
}

export function mapPod(pod: Record<string, unknown>): SlimPod {
  return {
    id: typeof pod.id === "string" ? pod.id : "",
    name: nullableString(pod.name),
    status: typeof pod.desiredStatus === "string" ? pod.desiredStatus : "",
    image: nullableString(pod.image),
    gpu: pickGpu(pod),
    costPerHr: typeof pod.costPerHr === "number" ? pod.costPerHr : 0,
    adjustedCostPerHr:
      typeof pod.adjustedCostPerHr === "number" ? pod.adjustedCostPerHr : 0,
    lastStartedAt: nullableString(pod.lastStartedAt),
  };
}
