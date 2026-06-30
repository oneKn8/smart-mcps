import { asObject, nullableNumber, nullableString } from "./null-helpers.js";

/**
 * Slim entry-point shape. A deployment carries one or more entry points
 * (`WEB_APP`, `EXECUTION_API`, `ADD_ON`). We flatten the per-type nested
 * config (`webApp`/`executionApi`/`addOn`) into a single, total shape so
 * callers can read `entry_point_type` and the few fields that matter for
 * wiring `scripts.run` or opening a web app, without walking a union.
 *
 * `access` is resolved from whichever nested `entryPointConfig.access`
 * exists; `web_app_url` and `execute_as` are populated only for `WEB_APP`.
 */
export type SlimEntryPoint = {
  entry_point_type: string | null;
  web_app_url: string | null;
  access: string | null;
  execute_as: string | null;
};

/**
 * Slim deployment shape. Hoists the useful `deploymentConfig` fields
 * (`versionNumber`, `manifestFileName`, `description`) up to the top level
 * and maps every entry point through `mapEntryPoint`.
 */
export type SlimDeployment = {
  deployment_id: string | null;
  version_number: number | null;
  manifest_file_name: string | null;
  description: string | null;
  update_time: string | null;
  entry_points: SlimEntryPoint[];
};

/** Resolve `entryPointConfig.access` from a nested entry-point sub-object. */
function nestedAccess(value: unknown): string | null {
  const obj = asObject(value);
  if (!obj) return null;
  const cfg = asObject(obj.entryPointConfig);
  if (!cfg) return null;
  return nullableString(cfg.access);
}

/** Map one raw Google `EntryPoint` into the flattened slim shape. */
export function mapEntryPoint(raw: unknown): SlimEntryPoint {
  const obj = asObject(raw);
  if (!obj) {
    return {
      entry_point_type: null,
      web_app_url: null,
      access: null,
      execute_as: null,
    };
  }
  const webApp = asObject(obj.webApp);
  const webAppCfg = webApp ? asObject(webApp.entryPointConfig) : null;
  // access lives under whichever type-specific block is present.
  const access =
    nestedAccess(obj.webApp) ??
    nestedAccess(obj.executionApi) ??
    nestedAccess(obj.addOn);
  return {
    entry_point_type: nullableString(obj.entryPointType),
    web_app_url: webApp ? nullableString(webApp.url) : null,
    access,
    execute_as: webAppCfg ? nullableString(webAppCfg.executeAs) : null,
  };
}

/** Convert a raw Google `Deployment` resource into the slim shape. */
export function mapDeployment(raw: unknown): SlimDeployment {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapDeployment: expected an object deployment resource");
  }
  const cfg = asObject(obj.deploymentConfig) ?? {};
  const entryPoints = Array.isArray(obj.entryPoints)
    ? obj.entryPoints.map(mapEntryPoint)
    : [];
  return {
    deployment_id: nullableString(obj.deploymentId),
    version_number: nullableNumber(cfg.versionNumber),
    manifest_file_name: nullableString(cfg.manifestFileName),
    description: nullableString(cfg.description),
    update_time: nullableString(obj.updateTime),
    entry_points: entryPoints,
  };
}
