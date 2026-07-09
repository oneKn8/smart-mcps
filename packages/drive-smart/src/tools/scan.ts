import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { DriveContext } from "../context.js";
import { services } from "../context.js";
import { bytes } from "../format.js";

const inputSchema = z.object({
  root_ids: z.array(z.string()).optional(),
  max_depth: z.number().int().min(0).max(50).optional().default(12),
  limit_files: z.number().int().min(1).max(500_000).optional().default(100_000),
  // Network (gvfs) Google Drive roots are skipped by default because walking a
  // stale FUSE mount blocks indefinitely. Set true to include them, or name a
  // specific network root in `root_ids` (explicit per-root opt-in).
  include_network_roots: z.boolean().optional().default(false),
});

type Input = z.infer<typeof inputSchema>;

export const driveScan = defineTool<Input, {
  index_path: string;
  generated_at: string;
  root_count: number;
  file_count: number;
  skipped_count: number;
  total_bytes: number;
  total_size: string;
}, DriveContext>({
  name: "drive_scan",
  description: "Scan local and config roots into the index; skips network mounts by default.",
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const svc = services(ctx);
    const { index, path } = svc.scan({
      maxDepth: input.max_depth,
      limitFiles: input.limit_files,
      rootIds: input.root_ids,
      includeNetworkRoots: input.include_network_roots,
    });
    const total = index.files.reduce((sum, file) => sum + file.size, 0);
    return {
      index_path: path,
      generated_at: index.generated_at,
      root_count: index.roots.length,
      file_count: index.files.length,
      skipped_count: index.skipped.length,
      total_bytes: total,
      total_size: bytes(total),
    };
  },
});
