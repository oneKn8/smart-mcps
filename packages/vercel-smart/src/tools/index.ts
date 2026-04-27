import type { ToolDefinition } from "smart-mcp-core";
import { listProjects } from "./projects.js";
import { listDomains } from "./domains.js";
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
];
