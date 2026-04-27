import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { VercelClient } from "../client.js";

const inputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
});

type Input = z.infer<typeof inputSchema>;

type Context = {
  client: VercelClient;
};

type SlimProject = {
  id: string;
  name: string;
  framework: string | null;
  updatedAt: number;
  latestDeploymentUrl: string | null;
  team: string;
};

type Output = {
  projects: SlimProject[];
  count: number;
};

function pickLatestDeploymentUrl(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0] as { url?: unknown };
  return typeof first?.url === "string" ? first.url : null;
}

export const listProjects = defineTool<Input, Output, Context>({
  name: "list_projects",
  description: "List Vercel projects across all accessible teams.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `number | undefined` but its output type is `number`.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, context) => {
    const { projects } = await context.client.listProjects({ limit: input.limit });
    return {
      projects: projects.map((p) => ({
        id: p.id as string,
        name: p.name as string,
        framework: (p.framework ?? null) as string | null,
        updatedAt: p.updatedAt as number,
        latestDeploymentUrl: pickLatestDeploymentUrl(p.latestDeployments),
        team: (p as { team?: string }).team ?? "personal",
      })),
      count: projects.length,
    };
  },
});
