#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { tools } from "./tools/index.js";
import { buildContext, type SlackContext } from "./context.js";

await createMcpServer<SlackContext>({
  name: "slack-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
