import type { ToolDefinition } from "smart-mcp-core";
import type { AppsScriptContext } from "../context.js";
import { createProjectTool, getProjectTool } from "./projects.js";
import {
  getContentTool,
  updateContentTool,
  pushFileTool,
} from "./content.js";
import { getMetricsTool } from "./metrics.js";
import {
  createVersionTool,
  listVersionsTool,
  getVersionTool,
} from "./versions.js";
import {
  createDeploymentTool,
  listDeploymentsTool,
  getDeploymentTool,
  updateDeploymentTool,
  deleteDeploymentTool,
} from "./deployments.js";
import { listProcessesTool } from "./processes.js";
import { deployScriptTool } from "./deploy.js";
import { runFunctionTool } from "./run.js";

/**
 * Registry of every apps-script-smart tool. Imported by both `server.ts` (to
 * register with the MCP runtime) and `__tests__/wire.test.ts` (count + naming
 * invariants).
 *
 * Order is documentation: project read/write, then versions, then
 * deployments, then processes, then the two composites (deploy_script,
 * run_function).
 */
export const tools = [
  // projects (2)
  createProjectTool,
  getProjectTool,
  // content (3) — get, the clobbering full-overwrite, the safe wrapper
  getContentTool,
  updateContentTool,
  pushFileTool,
  // metrics (1)
  getMetricsTool,
  // versions (3)
  createVersionTool,
  listVersionsTool,
  getVersionTool,
  // deployments (5)
  createDeploymentTool,
  listDeploymentsTool,
  getDeploymentTool,
  updateDeploymentTool,
  deleteDeploymentTool,
  // processes (1)
  listProcessesTool,
  // composites
  deployScriptTool, // create_version + create_deployment
  runFunctionTool, // gated scripts.run
] as unknown as ToolDefinition<unknown, unknown, AppsScriptContext>[];
