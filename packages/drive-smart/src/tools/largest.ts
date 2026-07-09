import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { DriveContext } from "../context.js";
import { services } from "../context.js";
import { mapFile, type SlimFile } from "./file-mapper.js";

const inputSchema = z.object({
  account: z.string().optional(),
  root_id: z.string().optional(),
  extension: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(25),
});

type Input = z.infer<typeof inputSchema>;

type Output = { count: number; results: SlimFile[] };

export const driveLargest = defineTool<Input, Output, DriveContext>({
  name: "drive_largest",
  description: "List largest indexed files, optionally filtered by account/root/extension.",
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const ext = input.extension?.startsWith(".") ? input.extension.toLowerCase() : input.extension ? `.${input.extension.toLowerCase()}` : undefined;
    const results = services(ctx).loadIndex().files
      .filter(file => input.account ? file.account === input.account : true)
      .filter(file => input.root_id ? file.root_id === input.root_id : true)
      .filter(file => ext ? file.extension === ext : true)
      .sort((a, b) => b.size - a.size)
      .slice(0, input.limit)
      .map(mapFile);
    return { count: results.length, results };
  },
});
