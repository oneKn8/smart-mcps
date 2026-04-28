import type { ToolDefinition } from "smart-mcp-core";
import { listPods, getPod, startPod, stopPod, terminatePod, launchPod } from "./pods.js";
import { listTemplates } from "./templates.js";
import { listEndpoints } from "./endpoints.js";
import { costAudit } from "./cost.js";
import { dailyStatus } from "./daily.js";
import { spinTrainingPod, killIdlePods } from "./smart.js";
import type { RunpodContext } from "../context.js";

export const tools: ToolDefinition<unknown, unknown, RunpodContext>[] = [
  listPods as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  getPod as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  startPod as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  stopPod as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  terminatePod as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  launchPod as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  listTemplates as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  listEndpoints as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  costAudit as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  dailyStatus as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  spinTrainingPod as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
  killIdlePods as unknown as ToolDefinition<unknown, unknown, RunpodContext>,
];
