#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { tools } from "./tools/index.js";
import { buildContext, type VercelContext } from "./context.js";

await createMcpServer<VercelContext>({
  name: "vercel-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
