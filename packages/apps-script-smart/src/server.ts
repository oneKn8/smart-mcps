#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { buildContext, type AppsScriptContext } from "./context.js";
import { tools } from "./tools/index.js";

await createMcpServer<AppsScriptContext>({
  name: "apps-script-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
