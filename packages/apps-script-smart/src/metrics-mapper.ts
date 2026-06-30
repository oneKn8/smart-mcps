import { asObject, nullableString } from "./null-helpers.js";

/**
 * One metric data point. `value` is a count Google encodes as a string;
 * `start_time`/`end_time` bound the bucket.
 */
export type SlimMetricsValue = {
  value: string | null;
  start_time: string | null;
  end_time: string | null;
};

/**
 * Slim metrics shape. The three parallel series Google returns for a
 * project: active users, total executions, and failed executions.
 */
export type SlimMetrics = {
  active_users: SlimMetricsValue[];
  total_executions: SlimMetricsValue[];
  failed_executions: SlimMetricsValue[];
};

function mapValue(raw: unknown): SlimMetricsValue {
  const obj = asObject(raw) ?? {};
  return {
    value: nullableString(obj.value),
    start_time: nullableString(obj.startTime),
    end_time: nullableString(obj.endTime),
  };
}

function mapSeries(raw: unknown): SlimMetricsValue[] {
  return Array.isArray(raw) ? raw.map(mapValue) : [];
}

/** Convert a raw Google `Metrics` resource into the slim shape. */
export function mapMetrics(raw: unknown): SlimMetrics {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapMetrics: expected an object metrics resource");
  }
  return {
    active_users: mapSeries(obj.activeUsers),
    total_executions: mapSeries(obj.totalExecutions),
    failed_executions: mapSeries(obj.failedExecutions),
  };
}
