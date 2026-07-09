#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { tools } from "./tools/index.js";
import { buildContext, type HetznerContext } from "./context.js";

await createMcpServer<HetznerContext>({
  name: "hetzner-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
