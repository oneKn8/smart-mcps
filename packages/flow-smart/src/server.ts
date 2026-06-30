#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { buildContext, type FlowContext } from "./context.js";
import { tools } from "./tools/index.js";

await createMcpServer<FlowContext>({
  name: "flow-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
