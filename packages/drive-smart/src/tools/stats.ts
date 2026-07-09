import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { DriveContext } from "../context.js";
import { services } from "../context.js";
import { bytes } from "../format.js";

const inputSchema = z.object({});
type Input = z.infer<typeof inputSchema>;

export const driveStats = defineTool<Input, {
  generated_at: string;
  root_count: number;
  file_count: number;
  skipped_count: number;
  total_bytes: number;
  total_size: string;
  by_root: Array<{ root_id: string; root_label: string; account?: string; file_count: number; total_bytes: number; total_size: string }>;
  by_extension: Array<{ extension: string; file_count: number; total_bytes: number; total_size: string }>;
}, DriveContext>({
  name: "drive_stats",
  description: "Summarize the persistent drive-smart index by root and extension.",
  inputSchema,
  handler: async (_input, ctx) => {
    const index = services(ctx).loadIndex();
    const total = index.files.reduce((sum, file) => sum + file.size, 0);
    const byRoot = new Map<string, { root_id: string; root_label: string; account?: string; file_count: number; total_bytes: number }>();
    const byExt = new Map<string, { extension: string; file_count: number; total_bytes: number }>();
    for (const file of index.files) {
      const root = byRoot.get(file.root_id) ?? {
        root_id: file.root_id,
        root_label: file.root_label,
        ...(file.account ? { account: file.account } : {}),
        file_count: 0,
        total_bytes: 0,
      };
      root.file_count += 1;
      root.total_bytes += file.size;
      byRoot.set(file.root_id, root);
      const extKey = file.extension || "(none)";
      const ext = byExt.get(extKey) ?? { extension: extKey, file_count: 0, total_bytes: 0 };
      ext.file_count += 1;
      ext.total_bytes += file.size;
      byExt.set(extKey, ext);
    }
    return {
      generated_at: index.generated_at,
      root_count: index.roots.length,
      file_count: index.files.length,
      skipped_count: index.skipped.length,
      total_bytes: total,
      total_size: bytes(total),
      by_root: [...byRoot.values()]
        .sort((a, b) => b.total_bytes - a.total_bytes)
        .map(item => ({ ...item, total_size: bytes(item.total_bytes) })),
      by_extension: [...byExt.values()]
        .sort((a, b) => b.total_bytes - a.total_bytes)
        .slice(0, 50)
        .map(item => ({ ...item, total_size: bytes(item.total_bytes) })),
    };
  },
});
