import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { DriveContext } from "../context.js";
import { services } from "../context.js";
import { bytes } from "../format.js";
import { mapFile, type SlimFile } from "./file-mapper.js";

const inputSchema = z.object({
  strategy: z.enum(["large_files", "archives", "media", "caches"]).optional().default("large_files"),
  min_size: z.number().int().min(0).optional().default(100 * 1024 * 1024),
  limit: z.number().int().min(1).max(500).optional().default(50),
});

type Input = z.infer<typeof inputSchema>;

const archiveExts = new Set([".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"]);
const mediaExts = new Set([".mp4", ".mkv", ".mov", ".avi", ".m4v", ".mp3", ".wav", ".flac"]);

type Output = {
  dry_run: true;
  strategy: string;
  count: number;
  total_bytes: number;
  total_size: string;
  candidates: SlimFile[];
};

export const drivePlanCleanup = defineTool<Input, Output, DriveContext>({
  name: "drive_plan_cleanup",
  description: "Dry-run cleanup candidates from the persistent index. Does not delete or move files.",
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const files = services(ctx).loadIndex().files
      .filter(file => file.size >= input.min_size)
      .filter(file => {
        if (input.strategy === "archives") return archiveExts.has(file.extension);
        if (input.strategy === "media") return mediaExts.has(file.extension);
        if (input.strategy === "caches") return /(^|\/)(node_modules|\.cache|cache|dist|coverage)(\/|$)/i.test(file.path);
        return true;
      })
      .sort((a, b) => b.size - a.size)
      .slice(0, input.limit);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    return {
      dry_run: true,
      strategy: input.strategy,
      count: files.length,
      total_bytes: total,
      total_size: bytes(total),
      candidates: files.map(mapFile),
    };
  },
});
