import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { DriveContext } from "../context.js";
import { services } from "../context.js";
import { mapRoot, type SlimRoot } from "./file-mapper.js";

const inputSchema = z.object({});
type Input = z.infer<typeof inputSchema>;

type Output = { roots: SlimRoot[] };

export const driveRoots = defineTool<Input, Output, DriveContext>({
  name: "drive_roots",
  description: "Discover configured, network, and local Drive/filesystem roots.",
  inputSchema,
  handler: async (_input, ctx) => {
    const svc = services(ctx);
    return { roots: svc.roots().map(root => mapRoot(root, svc.gvfsBase)) };
  },
});
