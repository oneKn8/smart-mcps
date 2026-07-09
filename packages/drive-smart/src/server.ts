#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { buildContext, type DriveContext } from "./context.js";
import { tools } from "./tools/index.js";

await createMcpServer<DriveContext>({
  name: "drive-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
