import { describe, it, expect } from "vitest";
import { tools } from "../tools/index.js";

const EXPECTED = [
  // Pods
  "list_pods",
  "get_pod",
  "start_pod",
  "stop_pod",
  "terminate_pod",
  "launch_pod",
  "update_pod",
  "restart_pod",
  "reset_pod",
  // Templates
  "list_templates",
  "create_template",
  "get_template",
  "update_template",
  "delete_template",
  // Serverless endpoints (config)
  "list_endpoints",
  "create_endpoint",
  "get_endpoint",
  "update_endpoint",
  "delete_endpoint",
  // Network volumes
  "list_network_volumes",
  "create_network_volume",
  "get_network_volume",
  "update_network_volume",
  "delete_network_volume",
  // Container registry auth
  "list_registry_auths",
  "create_registry_auth",
  "get_registry_auth",
  "delete_registry_auth",
  // Serverless inference
  "run_endpoint",
  "run_sync",
  "get_job_status",
  "cancel_job",
  "endpoint_health",
  "purge_queue",
  // GPU pricing
  "list_gpu_types",
  "cheapest_gpu",
  "estimate_cost",
  // Analytics + account
  "cost_audit",
  "daily_status",
  "account_summary",
  // Smart shortcuts
  "spin_training_pod",
  "kill_idle_pods",
  "deploy_serverless",
];

describe("tools wire-up", () => {
  it("exports all 43 expected tools", () => {
    expect(tools).toHaveLength(43);
  });

  it("tool names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("tool names are snake_case", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("tool descriptions are non-empty and terse", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      // <= 15 tokens ~ keep the raw string comfortably short.
      expect(t.description.split(/\s+/).length).toBeLessThanOrEqual(15);
    }
  });

  it("includes exactly the expected tool set", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
  });
});
