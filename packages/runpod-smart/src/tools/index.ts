import type { ToolDefinition } from "smart-mcp-core";
import {
  listPods,
  getPod,
  startPod,
  stopPod,
  terminatePod,
  launchPod,
  updatePod,
  restartPod,
  resetPod,
} from "./pods.js";
import {
  listTemplates,
  createTemplate,
  getTemplate,
  updateTemplate,
  deleteTemplate,
} from "./templates.js";
import {
  listEndpoints,
  createEndpoint,
  getEndpoint,
  updateEndpoint,
  deleteEndpoint,
} from "./endpoints.js";
import {
  listNetworkVolumes,
  createNetworkVolume,
  getNetworkVolume,
  updateNetworkVolume,
  deleteNetworkVolume,
} from "./volumes.js";
import {
  listRegistryAuths,
  createRegistryAuth,
  getRegistryAuth,
  deleteRegistryAuth,
} from "./registry.js";
import {
  runEndpoint,
  runSync,
  getJobStatus,
  cancelJob,
  endpointHealth,
  purgeQueue,
} from "./serverless.js";
import { listGpuTypes, cheapestGpu, estimateCost } from "./gpu.js";
import { accountSummary } from "./account.js";
import { deployServerless } from "./deploy.js";
import { costAudit } from "./cost.js";
import { dailyStatus } from "./daily.js";
import { spinTrainingPod, killIdlePods } from "./smart.js";
import type { RunpodContext } from "../context.js";

const t = <T>(tool: T): ToolDefinition<unknown, unknown, RunpodContext> =>
  tool as unknown as ToolDefinition<unknown, unknown, RunpodContext>;

export const tools: ToolDefinition<unknown, unknown, RunpodContext>[] = [
  // Pods
  t(listPods),
  t(getPod),
  t(startPod),
  t(stopPod),
  t(terminatePod),
  t(launchPod),
  t(updatePod),
  t(restartPod),
  t(resetPod),
  // Templates
  t(listTemplates),
  t(createTemplate),
  t(getTemplate),
  t(updateTemplate),
  t(deleteTemplate),
  // Serverless endpoints (config)
  t(listEndpoints),
  t(createEndpoint),
  t(getEndpoint),
  t(updateEndpoint),
  t(deleteEndpoint),
  // Network volumes
  t(listNetworkVolumes),
  t(createNetworkVolume),
  t(getNetworkVolume),
  t(updateNetworkVolume),
  t(deleteNetworkVolume),
  // Container registry auth
  t(listRegistryAuths),
  t(createRegistryAuth),
  t(getRegistryAuth),
  t(deleteRegistryAuth),
  // Serverless inference
  t(runEndpoint),
  t(runSync),
  t(getJobStatus),
  t(cancelJob),
  t(endpointHealth),
  t(purgeQueue),
  // GPU pricing (GraphQL)
  t(listGpuTypes),
  t(cheapestGpu),
  t(estimateCost),
  // Analytics + account
  t(costAudit),
  t(dailyStatus),
  t(accountSummary),
  // Smart shortcuts
  t(spinTrainingPod),
  t(killIdlePods),
  t(deployServerless),
];
