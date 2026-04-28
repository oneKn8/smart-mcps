import { describe, it, expect } from "vitest";
import { mapPod } from "../pod-mapper.js";

describe("mapPod", () => {
  it("maps a fully-populated pod correctly", () => {
    const result = mapPod({
      id: "pod_abc",
      name: "training-rig",
      image: "runpod/pytorch:2.1.0",
      desiredStatus: "RUNNING",
      costPerHr: 0.74,
      adjustedCostPerHr: 0.69,
      gpu: { displayName: "RTX 4090" },
      gpuCount: 2,
      lastStartedAt: "2026-04-26T18:00:00.000Z",
    });

    expect(result).toEqual({
      id: "pod_abc",
      name: "training-rig",
      status: "RUNNING",
      image: "runpod/pytorch:2.1.0",
      gpu: { displayName: "RTX 4090", count: 2 },
      costPerHr: 0.74,
      adjustedCostPerHr: 0.69,
      lastStartedAt: "2026-04-26T18:00:00.000Z",
    });
  });

  it("returns sentinel slim shape for an empty record", () => {
    const result = mapPod({});

    expect(result).toEqual({
      id: "",
      name: null,
      status: "",
      image: null,
      gpu: { displayName: "", count: 0 },
      costPerHr: 0,
      adjustedCostPerHr: 0,
      lastStartedAt: null,
    });
  });

  it("strips extra upstream fields (only the slim keys remain)", () => {
    const result = mapPod({
      id: "pod_abc",
      name: "training-rig",
      image: "runpod/pytorch:2.1.0",
      desiredStatus: "RUNNING",
      costPerHr: 0.74,
      adjustedCostPerHr: 0.69,
      gpu: { displayName: "RTX 4090" },
      gpuCount: 1,
      lastStartedAt: "2026-04-26T18:00:00.000Z",
      // Extras that must be stripped:
      internalRouteId: "route_should_be_stripped",
      containerRegistryAuthId: "auth_should_be_stripped",
      machineId: "m_xyz",
      env: [{ key: "FOO", value: "bar" }],
      ports: ["8888/http"],
      volumeInGb: 50,
    });

    const keys = Object.keys(result).sort();
    expect(keys).toEqual(
      [
        "id",
        "name",
        "status",
        "image",
        "gpu",
        "costPerHr",
        "adjustedCostPerHr",
        "lastStartedAt",
      ].sort(),
    );
  });

  it("returns '' for id when pod.id is non-string", () => {
    const result = mapPod({ id: 12345, desiredStatus: "RUNNING" });
    expect(result.id).toBe("");
  });

  it("returns '' for status when pod.desiredStatus is non-string", () => {
    const result = mapPod({ id: "pod_a", desiredStatus: 7 });
    expect(result.status).toBe("");
  });

  it("returns sentinel gpu when pod.gpu is non-object", () => {
    const result = mapPod({
      id: "pod_a",
      desiredStatus: "RUNNING",
      gpu: "RTX 4090",
    });
    expect(result.gpu).toEqual({ displayName: "", count: 0 });
  });

  it("preserves empty-string lastStartedAt (does not coerce '' to null)", () => {
    const result = mapPod({
      id: "pod_a",
      desiredStatus: "RUNNING",
      lastStartedAt: "",
    });
    expect(result.lastStartedAt).toBe("");
  });
});
