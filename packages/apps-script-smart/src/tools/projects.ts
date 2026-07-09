import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { AppsScriptContext } from "../context.js";
import { resolveAccount } from "./account.js";
import { mapProject, type SlimProject } from "../project-mapper.js";

// =============================================================================
// create_project
// =============================================================================

const createProjectInputSchema = z.object({
  /** Account to act as; omit for the default identity. */
  account: z.string().optional(),
  title: z.string().min(1),
  /**
   * Drive ID of a Doc/Sheet/Form to bind the script to. Omit for a
   * standalone script (a Drive file of MIME `application/vnd.google-apps.script`).
   */
  parent_id: z.string().optional(),
});

type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
type CreateProjectOutput = { project: SlimProject };

export const createProjectTool = defineTool<
  CreateProjectInput,
  CreateProjectOutput,
  AppsScriptContext
>({
  name: "create_project",
  description: "Create a new Apps Script project",
  inputSchema: createProjectInputSchema,
  handler: async (input, ctx) => {
    const account = resolveAccount(input.account, ctx);
    const body: { title: string; parentId?: string } = { title: input.title };
    if (input.parent_id !== undefined) body.parentId = input.parent_id;
    const raw = await ctx.client.createProject(account, body);
    return { project: mapProject(raw) };
  },
});

// =============================================================================
// get_project
// =============================================================================

const getProjectInputSchema = z.object({
  /** Account to act as; omit for the default identity. */
  account: z.string().optional(),
  script_id: z.string().min(1),
});

type GetProjectInput = z.infer<typeof getProjectInputSchema>;
type GetProjectOutput = { project: SlimProject };

export const getProjectTool = defineTool<
  GetProjectInput,
  GetProjectOutput,
  AppsScriptContext
>({
  name: "get_project",
  description: "Get an Apps Script project's metadata",
  inputSchema: getProjectInputSchema,
  handler: async (input, ctx) => {
    const account = resolveAccount(input.account, ctx);
    const raw = await ctx.client.getProject(account, input.script_id);
    return { project: mapProject(raw) };
  },
});
