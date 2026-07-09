import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { DriveContext } from "../context.js";
import { services } from "../context.js";
import { bytes } from "../format.js";
import { mapFile, type SlimFile } from "./file-mapper.js";
import type { IndexedFile } from "../types.js";

const inputSchema = z.object({
  mode: z.enum(["same_name_and_size", "same_size"]).optional().default("same_name_and_size"),
  min_size: z.number().int().min(0).optional().default(1),
  limit_groups: z.number().int().min(1).max(200).optional().default(50),
});

type Input = z.infer<typeof inputSchema>;

type DuplicateGroup = {
  duplicate_count: number;
  size_bytes: number;
  size: string;
  files: SlimFile[];
};
type Output = { group_count: number; groups: DuplicateGroup[] };

export const driveDuplicates = defineTool<Input, Output, DriveContext>({
  name: "drive_duplicates",
  description: "Find duplicate candidates in the persistent index by same name+size or same size.",
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const groups = new Map<string, IndexedFile[]>();
    for (const file of services(ctx).loadIndex().files) {
      if (file.size < input.min_size) continue;
      const key = input.mode === "same_size" ? String(file.size) : `${file.name.toLowerCase()}:${file.size}`;
      const arr = groups.get(key) ?? [];
      arr.push(file);
      groups.set(key, arr);
    }
    const result = [...groups.values()]
      .filter(group => group.length > 1)
      .sort((a, b) => (b[0]?.size ?? 0) * b.length - (a[0]?.size ?? 0) * a.length)
      .slice(0, input.limit_groups)
      .map(group => ({
        duplicate_count: group.length,
        size_bytes: group[0]?.size ?? 0,
        size: bytes(group[0]?.size ?? 0),
        files: group.map(mapFile),
      }));
    return { group_count: result.length, groups: result };
  },
});
