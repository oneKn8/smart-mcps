import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { VercelClient } from "../client.js";

const inputSchema = z.object({
  project: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;

type Context = {
  client: VercelClient;
};

type SlimDomain = {
  name: string;
  apexName: string;
  redirect: string | null;
  redirectStatusCode: number | null;
  verified: boolean;
};

type Output = {
  domains: SlimDomain[];
  count: number;
};

export const listDomains = defineTool<Input, Output, Context>({
  name: "list_domains",
  description: "List domains attached to a Vercel project.",
  inputSchema,
  handler: async (input, context) => {
    const { domains } = await context.client.listProjectDomains(input.project);
    return {
      domains: domains.map((d) => ({
        name: d.name,
        apexName: d.apexName,
        redirect: d.redirect,
        redirectStatusCode: d.redirectStatusCode,
        verified: d.verified,
      })),
      count: domains.length,
    };
  },
});
