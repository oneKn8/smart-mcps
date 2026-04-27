import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { AmbiguousMatchError, NotFoundError } from "smart-mcp-core";
import { smartProject } from "../smart.js";

type FakeClient = {
  listProjects: ReturnType<typeof vi.fn>;
};

function makeClient(projects: Array<Record<string, unknown>>): FakeClient {
  return {
    listProjects: vi.fn().mockResolvedValue({
      projects,
      pagination: { count: projects.length, next: null },
    }),
  };
}

describe("smartProject — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(smartProject.name).toBe("smart_project");
    expect(smartProject.description).toBe(
      "Resolve a partial project name to a single Vercel project.",
    );
    const parsed = smartProject.inputSchema.parse({ query: "alpha" }) as {
      query: string;
    };
    expect(parsed.query).toBe("alpha");
    expect(smartProject.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty query string", () => {
    expect(() => smartProject.inputSchema.parse({ query: "" })).toThrow();
  });

  it("rejects missing query field", () => {
    expect(() => smartProject.inputSchema.parse({})).toThrow();
  });
});

describe("smartProject — resolution", () => {
  it("returns single project on exact name match", async () => {
    const client = makeClient([
      { id: "prj_a", name: "alpha-site", framework: "nextjs" },
      { id: "prj_b", name: "beta-site", framework: "vite" },
      { id: "prj_g", name: "gamma-site", framework: "remix" },
    ]);
    const result = (await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
      { client: client as unknown as never },
    )) as { id: string; name: string; framework: string | null };
    expect(result).toEqual({
      id: "prj_a",
      name: "alpha-site",
      framework: "nextjs",
    });
  });

  it("returns single project on fuzzy match above threshold (0.9)", async () => {
    const client = makeClient([
      { id: "prj_a", name: "alpha-site", framework: "nextjs" },
      { id: "prj_b", name: "beta-site", framework: "vite" },
      { id: "prj_g", name: "gamma-site", framework: "remix" },
    ]);
    const result = (await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-sit" }) as { query: string },
      { client: client as unknown as never },
    )) as { id: string; name: string; framework: string | null };
    expect(result.id).toBe("prj_a");
    expect(result.name).toBe("alpha-site");
  });

  it("strips extra fields from the project shape (only id, name, framework)", async () => {
    const client = makeClient([
      {
        id: "prj_a",
        name: "alpha-site",
        framework: "nextjs",
        accountId: "acc_should_be_stripped",
        env: [{ key: "FOO", value: "bar" }],
        link: { type: "github", repo: "x/y" },
        latestDeployments: [{ url: "alpha.vercel.app" }],
        updatedAt: 1700000000000,
        createdAt: 1699999999999,
      },
    ]);
    const result = (await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["framework", "id", "name"]);
    expect(result).not.toHaveProperty("accountId");
    expect(result).not.toHaveProperty("env");
    expect(result).not.toHaveProperty("link");
    expect(result).not.toHaveProperty("latestDeployments");
    expect(result).not.toHaveProperty("updatedAt");
    expect(result).not.toHaveProperty("createdAt");
  });

  it("returns framework: null when upstream framework is null", async () => {
    const client = makeClient([
      { id: "prj_a", name: "alpha-site", framework: null },
    ]);
    const result = (await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
      { client: client as unknown as never },
    )) as { framework: string | null };
    expect(result.framework).toBeNull();
  });

  it("returns framework: null when upstream framework is missing", async () => {
    const client = makeClient([
      { id: "prj_a", name: "alpha-site" },
    ]);
    const result = (await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
      { client: client as unknown as never },
    )) as { framework: string | null };
    expect(result.framework).toBeNull();
  });

  it("throws AmbiguousMatchError when no candidate exceeds threshold", async () => {
    const client = makeClient([
      { id: "prj_1", name: "alpha-staging", framework: "nextjs" },
      { id: "prj_2", name: "alpha-marketing", framework: "nextjs" },
      { id: "prj_3", name: "alpha-prod", framework: "nextjs" },
    ]);
    let caught: unknown;
    try {
      await smartProject.handler(
        smartProject.inputSchema.parse({ query: "alpha" }) as { query: string },
        { client: client as unknown as never },
      );
      expect.fail("should have thrown AmbiguousMatchError");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmbiguousMatchError);
    const ambiguous = caught as AmbiguousMatchError;
    expect(ambiguous.candidates.length).toBeLessThanOrEqual(3);
    const labels = ambiguous.candidates.map((c) => c.label);
    expect(labels).toContain("alpha-staging");
    expect(labels).toContain("alpha-marketing");
    expect(labels).toContain("alpha-prod");
  });

  it("throws NotFoundError when project list is empty", async () => {
    const client = makeClient([]);
    let caught: unknown;
    try {
      await smartProject.handler(
        smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
        { client: client as unknown as never },
      );
      expect.fail("should have thrown NotFoundError");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
  });

  it("calls client.listProjects with { limit: 100 }", async () => {
    const client = makeClient([
      { id: "prj_a", name: "alpha-site", framework: "nextjs" },
    ]);
    await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
      { client: client as unknown as never },
    );
    expect(client.listProjects).toHaveBeenCalledWith({ limit: 100 });
  });
});
