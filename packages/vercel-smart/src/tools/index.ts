import type { ToolDefinition } from "smart-mcp-core";
import { listProjects } from "./projects.js";
import {
  listTeams,
  updateProjectSettings,
  pauseProject,
  unpauseProject,
  deleteProject,
} from "./projects-admin.js";
import { listDomains, addDomain, verifyDomain, removeDomain } from "./domains.js";
import { listEnv, revealEnv, setEnv, editEnv, deleteEnv } from "./env.js";
import {
  listDeployments,
  getDeployment,
  deploymentLogs,
  redeploy,
  promoteDeployment,
  cancelDeployment,
  deleteDeployment,
} from "./deployments.js";
import { smartProject, dailyStatus } from "./smart.js";
import { canonicalAudit, redirectsAudit, flipCanonical } from "./canonical.js";
import type { VercelContext } from "../context.js";

export const tools: ToolDefinition<unknown, unknown, VercelContext>[] = [
  listProjects as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  listDomains as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  smartProject as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  canonicalAudit as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  redirectsAudit as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  dailyStatus as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  flipCanonical as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  // env
  listEnv as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  revealEnv as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  setEnv as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  editEnv as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  deleteEnv as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  // deployments
  listDeployments as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  getDeployment as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  deploymentLogs as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  redeploy as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  promoteDeployment as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  cancelDeployment as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  deleteDeployment as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  // domains
  addDomain as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  verifyDomain as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  removeDomain as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  // projects (admin)
  listTeams as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  updateProjectSettings as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  pauseProject as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  unpauseProject as unknown as ToolDefinition<unknown, unknown, VercelContext>,
  deleteProject as unknown as ToolDefinition<unknown, unknown, VercelContext>,
];
