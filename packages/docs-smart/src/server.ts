#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { buildContext, type DocsContext } from "./context.js";
import { tools } from "./tools/index.js";

await createMcpServer<DocsContext>({
  name: "docs-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
