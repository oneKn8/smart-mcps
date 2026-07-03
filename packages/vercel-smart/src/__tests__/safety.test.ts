import { describe, it, expect, afterEach } from "vitest";
import {
  assertTeamWritable,
  deniedTeamSlugs,
} from "../safety.js";

describe("team write deny-list", () => {
  afterEach(() => {
    delete process.env.VERCEL_SMART_DENIED_TEAMS;
  });

  it("blocks writes to the default-denied example-denied-team team", () => {
    expect(() => assertTeamWritable("example-denied-team", "some-proj")).toThrow(
      /blocked/i,
    );
  });

  it("allows writes to a non-denied team", () => {
    expect(() =>
      assertTeamWritable("gamma-team", "gamma-dashboard"),
    ).not.toThrow();
  });

  it("allows personal scope (null/undefined slug is never denied)", () => {
    expect(() => assertTeamWritable(null, "p")).not.toThrow();
    expect(() => assertTeamWritable(undefined, "p")).not.toThrow();
  });

  it("VERCEL_SMART_DENIED_TEAMS adds to the default, never removes it", () => {
    process.env.VERCEL_SMART_DENIED_TEAMS = "acme, extra-team";
    const denied = deniedTeamSlugs();
    expect(denied).toContain("example-denied-team"); // default floor stays
    expect(denied).toContain("acme");
    expect(denied).toContain("extra-team");
    expect(() => assertTeamWritable("acme", "x")).toThrow();
    expect(() => assertTeamWritable("example-denied-team", "x")).toThrow();
  });

  it("deniedTeamSlugs defaults to exactly the acme team with no env override", () => {
    expect(deniedTeamSlugs()).toEqual(["example-denied-team"]);
  });
});
