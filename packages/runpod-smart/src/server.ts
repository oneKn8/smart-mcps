#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { tools } from "./tools/index.js";
import { buildContext, type RunpodContext } from "./context.js";

await createMcpServer<RunpodContext>({
  name: "runpod-smart",
  version: "0.2.0",
  tools,
  context: buildContext(),
});
