#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { buildContext, type SheetsContext } from "./context.js";
import { tools } from "./tools/index.js";

await createMcpServer<SheetsContext>({
  name: "sheets-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
