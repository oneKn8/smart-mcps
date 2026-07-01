#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { buildContext, type GDriveContext } from "./context.js";
import { tools } from "./tools/index.js";

await createMcpServer<GDriveContext>({
  name: "gdrive-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
