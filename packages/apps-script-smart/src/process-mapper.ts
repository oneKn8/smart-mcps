import { asObject, nullableString } from "./null-helpers.js";

/**
 * Slim process shape. A process is one execution of a script (from a
 * trigger, the editor, an add-on, or the Execution API). `duration` is a
 * Google duration string (e.g. `"3.5s"`); we surface it verbatim.
 */
export type SlimProcess = {
  project_name: string | null;
  function_name: string | null;
  process_type: string | null;
  process_status: string | null;
  user_access_level: string | null;
  start_time: string | null;
  duration: string | null;
  runtime_version: string | null;
};

/** Convert a raw Google `Process` resource into the slim shape. */
export function mapProcess(raw: unknown): SlimProcess {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapProcess: expected an object process resource");
  }
  return {
    project_name: nullableString(obj.projectName),
    function_name: nullableString(obj.functionName),
    process_type: nullableString(obj.processType),
    process_status: nullableString(obj.processStatus),
    user_access_level: nullableString(obj.userAccessLevel),
    start_time: nullableString(obj.startTime),
    duration: nullableString(obj.duration),
    runtime_version: nullableString(obj.runtimeVersion),
  };
}
