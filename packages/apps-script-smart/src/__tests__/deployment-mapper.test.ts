import { describe, it, expect } from "vitest";
import { mapDeployment, mapEntryPoint } from "../deployment-mapper.js";

describe("mapEntryPoint", () => {
  it("flattens a WEB_APP entry point (url, access, executeAs)", () => {
    expect(
      mapEntryPoint({
        entryPointType: "WEB_APP",
        webApp: {
          url: "https://script.google.com/macros/s/abc/exec",
          entryPointConfig: { access: "ANYONE", executeAs: "USER_DEPLOYING" },
        },
      }),
    ).toEqual({
      entry_point_type: "WEB_APP",
      web_app_url: "https://script.google.com/macros/s/abc/exec",
      access: "ANYONE",
      execute_as: "USER_DEPLOYING",
    });
  });

  it("flattens an EXECUTION_API entry point (access only, no web url)", () => {
    expect(
      mapEntryPoint({
        entryPointType: "EXECUTION_API",
        executionApi: { entryPointConfig: { access: "MYSELF" } },
      }),
    ).toEqual({
      entry_point_type: "EXECUTION_API",
      web_app_url: null,
      access: "MYSELF",
      execute_as: null,
    });
  });
});

describe("mapDeployment", () => {
  it("hoists deploymentConfig fields and maps entry points", () => {
    expect(
      mapDeployment({
        deploymentId: "dep_1",
        deploymentConfig: {
          scriptId: "s1",
          versionNumber: 4,
          manifestFileName: "appsscript",
          description: "prod",
        },
        updateTime: "2026-06-30T12:00:00.000Z",
        entryPoints: [
          {
            entryPointType: "EXECUTION_API",
            executionApi: { entryPointConfig: { access: "MYSELF" } },
          },
        ],
      }),
    ).toEqual({
      deployment_id: "dep_1",
      version_number: 4,
      manifest_file_name: "appsscript",
      description: "prod",
      update_time: "2026-06-30T12:00:00.000Z",
      entry_points: [
        {
          entry_point_type: "EXECUTION_API",
          web_app_url: null,
          access: "MYSELF",
          execute_as: null,
        },
      ],
    });
  });

  it("handles a HEAD deployment with no version and no entry points", () => {
    expect(
      mapDeployment({ deploymentId: "dep_head", deploymentConfig: {} }),
    ).toEqual({
      deployment_id: "dep_head",
      version_number: null,
      manifest_file_name: null,
      description: null,
      update_time: null,
      entry_points: [],
    });
  });
});
