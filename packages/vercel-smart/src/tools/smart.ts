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
  team: string;
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
      team?: string;
    };
    return {
      id: p.id,
      name: p.name,
      framework: p.framework ?? null,
      team: p.team ?? "personal",
    };
  },
});

const dailyStatusInputSchema = z.object({
  hours: z.number().int().min(1).max(720).optional().default(24),
});

type DailyStatusInput = z.infer<typeof dailyStatusInputSchema>;

type LatestSlim = {
  state: string;
  createdAt: number;
  url: string;
  target: string | null;
};

type ProjectStatus = {
  project: string;
  team: string;
  ready: number;
  error: number;
  latest: LatestSlim | null;
};

type ProjectStatusFull = ProjectStatus & {
  building: number;
  canceled: number;
  total: number;
};

type DailyStatusOutput = {
  window_hours: number;
  project_count: number;
  deployments: {
    total: number;
    ready: number;
    error: number;
    building: number;
    canceled: number;
  };
  by_project: Array<{
    project: string;
    team: string;
    ready: number;
    error: number;
    building: number;
    canceled: number;
    latest: LatestSlim | null;
  }>;
  flagged: Array<{ project: string; reason: string }>;
};

function bucketState(
  state: string,
): "ready" | "error" | "building" | "canceled" | null {
  if (state === "READY") return "ready";
  if (state === "ERROR") return "error";
  if (state === "BUILDING" || state === "QUEUED" || state === "INITIALIZING")
    return "building";
  if (state === "CANCELED") return "canceled";
  return null;
}

export const dailyStatus = defineTool<
  DailyStatusInput,
  DailyStatusOutput,
  Context
>({
  name: "daily_status",
  description:
    "24h deploy + project health snapshot across all Vercel projects.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `number | undefined` but its output type is `number`.
  inputSchema: dailyStatusInputSchema as unknown as z.ZodType<DailyStatusInput>,
  handler: async (input, context) => {
    const now = Date.now();
    const cutoff = now - input.hours * 3600 * 1000;
    const staleCutoff = now - 7 * 24 * 3600 * 1000;

    const { projects } = await context.client.listProjects({ limit: 100 });

    const perProject: ProjectStatusFull[] = [];
    const flagged: Array<{ project: string; reason: string }> = [];

    for (const raw of projects) {
      const p = raw as {
        id: string;
        name: string;
        updatedAt?: number;
        team?: string;
      };
      const { deployments } = await context.client.listDeployments({
        projectId: p.id,
        limit: 20,
      });

      let ready = 0;
      let errCount = 0;
      let building = 0;
      let canceled = 0;
      let total = 0;
      let latest: LatestSlim | null = null;

      for (const d of deployments) {
        if (d.createdAt < cutoff) continue;
        total++;
        const bucket = bucketState(d.state);
        if (bucket === "ready") ready++;
        else if (bucket === "error") errCount++;
        else if (bucket === "building") building++;
        else if (bucket === "canceled") canceled++;
        if (latest === null || d.createdAt > latest.createdAt) {
          latest = {
            state: d.state,
            createdAt: d.createdAt,
            url: d.url,
            target: d.target ?? null,
          };
        }
      }

      perProject.push({
        project: p.name,
        team: p.team ?? "personal",
        ready,
        error: errCount,
        building,
        canceled,
        total,
        latest,
      });

      if (errCount > 0) {
        flagged.push({
          project: p.name,
          reason: `had ${errCount} errored deploys in window`,
        });
      } else if (latest === null && (p.updatedAt ?? 0) < staleCutoff) {
        flagged.push({
          project: p.name,
          reason: "no deploy activity in 7 days",
        });
      }
    }

    const totals = perProject.reduce(
      (acc, p) => {
        acc.total += p.total;
        acc.ready += p.ready;
        acc.error += p.error;
        acc.building += p.building;
        acc.canceled += p.canceled;
        return acc;
      },
      { total: 0, ready: 0, error: 0, building: 0, canceled: 0 },
    );

    return {
      window_hours: input.hours,
      project_count: projects.length,
      deployments: totals,
      by_project: perProject.map((p) => ({
        project: p.project,
        team: p.team,
        ready: p.ready,
        error: p.error,
        building: p.building,
        canceled: p.canceled,
        latest: p.latest,
      })),
      flagged,
    };
  },
});
