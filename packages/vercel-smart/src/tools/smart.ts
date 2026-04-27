import { z } from "zod";
import { defineTool, resolveOne } from "smart-mcp-core";
import type { VercelClient } from "../client.js";

const inputSchema = z.object({
  query: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;

type Context = {
  client: VercelClient;
};

type Output = {
  id: string;
  name: string;
  framework: string | null;
};

export const smartProject = defineTool<Input, Output, Context>({
  name: "smart_project",
  description: "Resolve a partial project name to a single Vercel project.",
  inputSchema,
  handler: async (input, context) => {
    const { projects } = await context.client.listProjects({ limit: 100 });
    const project = resolveOne(
      input.query,
      projects,
      (p) => (p as { name: string }).name,
      { threshold: 0.9 },
    );
    const p = project as {
      id: string;
      name: string;
      framework?: string | null;
    };
    return {
      id: p.id,
      name: p.name,
      framework: p.framework ?? null,
    };
  },
});
