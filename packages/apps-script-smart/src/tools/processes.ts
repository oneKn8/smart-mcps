import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { AppsScriptContext } from "../context.js";
import { resolveAccount } from "./account.js";
import type { ListProcessesOpts } from "../client.js";
import { mapProcess, type SlimProcess } from "../process-mapper.js";

const listProcessesInputSchema = z.object({
  /** Account to act as; omit for the default identity. */
  account: z.string().optional(),
  /** When set, lists processes for ONE script; otherwise across all scripts. */
  script_id: z.string().optional(),
  deployment_id: z.string().optional(),
  function_name: z.string().optional(),
  /** Filter by status (e.g. `COMPLETED`, `FAILED`, `RUNNING`, `TIMED_OUT`). */
  statuses: z.array(z.string()).optional(),
  /** Filter by type (e.g. `TIME_DRIVEN`, `TRIGGER`, `EXECUTION_API`, `WEBAPP`). */
  types: z.array(z.string()).optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  page_size: z.number().int().positive().optional(),
  page_token: z.string().optional(),
});

type ListProcessesInput = z.infer<typeof listProcessesInputSchema>;
type ListProcessesOutput = {
  processes: SlimProcess[];
  next_page_token: string | null;
};

export const listProcessesTool = defineTool<
  ListProcessesInput,
  ListProcessesOutput,
  AppsScriptContext
>({
  name: "list_processes",
  description: "List script execution processes",
  inputSchema: listProcessesInputSchema,
  handler: async (input, ctx) => {
    const account = resolveAccount(input.account, ctx);
    const opts: ListProcessesOpts = {};
    if (input.script_id !== undefined) opts.scriptId = input.script_id;
    if (input.deployment_id !== undefined) {
      opts.deploymentId = input.deployment_id;
    }
    if (input.function_name !== undefined) {
      opts.functionName = input.function_name;
    }
    if (input.statuses !== undefined) opts.statuses = input.statuses;
    if (input.types !== undefined) opts.types = input.types;
    if (input.start_time !== undefined) opts.startTime = input.start_time;
    if (input.end_time !== undefined) opts.endTime = input.end_time;
    if (input.page_size !== undefined) opts.pageSize = input.page_size;
    if (input.page_token !== undefined) opts.pageToken = input.page_token;

    const res = await ctx.client.listProcesses(account, opts);
    return {
      processes: res.items.map(mapProcess),
      next_page_token: res.nextPageToken ?? null,
    };
  },
});
