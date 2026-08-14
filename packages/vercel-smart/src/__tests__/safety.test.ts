import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  assertTeamWritable,
  deniedTeamSlugs,
} from "../safety.js";

describe("team write deny-list", () => {
  const savedHome = process.env.HOME;
  const savedDenied = process.env.VERCEL_SMART_DENIED_TEAMS;

  beforeEach(() => {
    // Isolate from the real ~/.config/smart-mcps/.env (see client.test.ts pattern)
    process.env.HOME = "/nonexistent-smart-mcps-test-home";
    delete process.env.VERCEL_SMART_DENIED_TEAMS;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedDenied === undefined) delete process.env.VERCEL_SMART_DENIED_TEAMS;
    else process.env.VERCEL_SMART_DENIED_TEAMS = savedDenied;
  });

  it("defaults to an empty deny-list when unconfigured", () => {
    expect(deniedTeamSlugs()).toEqual([]);
    expect(() => assertTeamWritable("alpha-team", "some-proj")).not.toThrow();
  });

  it("blocks writes to a team listed in VERCEL_SMART_DENIED_TEAMS", () => {
    process.env.VERCEL_SMART_DENIED_TEAMS = "alpha-team";
    expect(() => assertTeamWritable("alpha-team", "some-proj")).toThrow(
      /blocked/i,
    );
  });

  it("allows writes to a non-denied team", () => {
    process.env.VERCEL_SMART_DENIED_TEAMS = "alpha-team";
    expect(() => assertTeamWritable("beta-team", "beta-site")).not.toThrow();
  });

  it("allows personal scope (null/undefined slug is never denied)", () => {
    process.env.VERCEL_SMART_DENIED_TEAMS = "alpha-team";
    expect(() => assertTeamWritable(null, "p")).not.toThrow();
    expect(() => assertTeamWritable(undefined, "p")).not.toThrow();
  });

  it("parses a comma-separated list, trimming whitespace and dropping empties", () => {
    process.env.VERCEL_SMART_DENIED_TEAMS = "alpha-team, beta-team, ,alpha-team";
    expect(deniedTeamSlugs()).toEqual(["alpha-team", "beta-team"]);
    expect(() => assertTeamWritable("beta-team", "x")).toThrow();
  });
});
