import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { DriveContext } from "../context.js";
import { services } from "../context.js";
import { mapFile, type SlimFile } from "./file-mapper.js";

const inputSchema = z.object({
  q: z.string().min(1),
  account: z.string().optional(),
  root_id: z.string().optional(),
  extension: z.string().optional(),
  min_size: z.number().int().min(0).optional(),
  max_results: z.number().int().min(1).max(500).optional().default(50),
});

type Input = z.infer<typeof inputSchema>;

type Output = { count: number; results: SlimFile[] };

export const driveSearch = defineTool<Input, Output, DriveContext>({
  name: "drive_search",
  description: "Search indexed Drive/filesystem files by name, path, account, root, extension, and size.",
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const q = input.q.toLowerCase();
    const ext = input.extension?.startsWith(".") ? input.extension.toLowerCase() : input.extension ? `.${input.extension.toLowerCase()}` : undefined;
    const files = services(ctx).loadIndex().files
      .filter(file => file.name.toLowerCase().includes(q) || file.relative_path.toLowerCase().includes(q) || file.path.toLowerCase().includes(q))
      .filter(file => input.account ? file.account === input.account : true)
      .filter(file => input.root_id ? file.root_id === input.root_id : true)
      .filter(file => ext ? file.extension === ext : true)
      .filter(file => input.min_size !== undefined ? file.size >= input.min_size : true)
      .sort((a, b) => b.size - a.size)
      .slice(0, input.max_results)
      .map(mapFile);
    return { count: files.length, results: files };
  },
});
