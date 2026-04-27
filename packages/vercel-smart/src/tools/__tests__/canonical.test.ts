import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { canonicalAudit } from "../canonical.js";

type FakeClient = {
  listProjectDomains: ReturnType<typeof vi.fn>;
};

function makeClient(response: { domains: Array<Record<string, unknown>> }): FakeClient {
  return {
    listProjectDomains: vi.fn().mockResolvedValue(response),
  };
}

type DomainOverrides = Partial<{
  name: string;
  apexName: string;
  projectId: string;
  redirect: string | null;
  redirectStatusCode: number | null;
  verified: boolean;
  gitBranch: string | null;
  createdAt: number;
  updatedAt: number;
}>;

function makeDomain(overrides: DomainOverrides): Record<string, unknown> {
  return {
    name: "alpha-site.com",
    apexName: "alpha-site.com",
    projectId: "prj_alpha",
    redirect: null,
    redirectStatusCode: null,
    verified: true,
    gitBranch: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

type AuditOutput = {
  project: string;
  apex:
    | { name: string; redirect: string | null; redirectStatusCode: number | null; verified: boolean }
    | null;
  www:
    | { name: string; redirect: string | null; redirectStatusCode: number | null; verified: boolean }
    | null;
  canonical: "apex" | "www" | "split" | "none" | "broken";
  notes: string[];
};

async function run(
  client: FakeClient,
  project: string,
): Promise<AuditOutput> {
  const input = canonicalAudit.inputSchema.parse({ project }) as { project: string };
  return (await canonicalAudit.handler(input, {
    client: client as unknown as never,
  })) as AuditOutput;
}

describe("canonicalAudit — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(canonicalAudit.name).toBe("canonical_audit");
    expect(canonicalAudit.description).toBe(
      "Audit which apex/www variant is canonical for a Vercel project.",
    );
    const parsed = canonicalAudit.inputSchema.parse({ project: "alpha-site" }) as {
      project: string;
    };
    expect(parsed.project).toBe("alpha-site");
    expect(canonicalAudit.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("canonicalAudit — input validation", () => {
  it("rejects empty project string", () => {
    expect(() => canonicalAudit.inputSchema.parse({ project: "" })).toThrow();
  });
});

describe("canonicalAudit — handler behavior", () => {
  it("calls client.listProjectDomains with input.project", async () => {
    const client = makeClient({ domains: [] });
    await run(client, "alpha-site");
    expect(client.listProjectDomains).toHaveBeenCalledWith("alpha-site");
  });

  it("classifies canonical = 'apex' when apex has no redirect and www redirects to apex", async () => {
    const client = makeClient({
      domains: [
        makeDomain({ name: "alpha-site.com", redirect: null, redirectStatusCode: null }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.canonical).toBe("apex");
    expect(result.apex).not.toBeNull();
    expect(result.www).not.toBeNull();
    expect(result.notes).toEqual([]);
  });

  it("classifies canonical = 'www' when www has no redirect and apex redirects to www", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          redirect: "www.alpha-site.com",
          redirectStatusCode: 308,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.canonical).toBe("www");
    expect(result.notes).toEqual([]);
  });

  it("classifies canonical = 'broken' when apex and www redirect to each other", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          redirect: "www.alpha-site.com",
          redirectStatusCode: 308,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.canonical).toBe("broken");
    const loopNote = result.notes.find((n) => n.includes("loop"));
    expect(loopNote).toBeDefined();
    expect(loopNote).toContain("alpha-site.com");
    expect(loopNote).toContain("www.alpha-site.com");
    expect(loopNote).toContain("<->");
  });

  it("classifies canonical = 'split' when both redirect to outside domains", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          redirect: "other.com",
          redirectStatusCode: 308,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "another.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.canonical).toBe("split");
  });

  it("classifies canonical = 'none' when no apex domain present", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "www.alpha-site.com",
          apexName: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.canonical).toBe("none");
    expect(result.apex).toBeNull();
    expect(result.www).toBeNull();
  });

  it("classifies canonical = 'none' when apex present but www missing", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          apexName: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.canonical).toBe("none");
    expect(result.apex).not.toBeNull();
    expect(result.www).toBeNull();
  });

  it("notes unverified apex domain", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
          verified: false,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.notes).toContain("apex domain 'alpha-site.com' is unverified");
  });

  it("notes unverified www domain", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
          verified: false,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.notes).toContain("www domain 'www.alpha-site.com' is unverified");
  });

  it("notes when redirect status is not 308 or 301", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 302,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.notes).toContain(
      "redirect status is 302, recommended: 308 (permanent)",
    );
  });

  it("notes when apex redirects to a domain not on this project", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          redirect: "unrelated.com",
          redirectStatusCode: 308,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.notes).toContain(
      "apex redirects to 'unrelated.com' which is not a domain on this project",
    );
  });

  it("strips upstream extras from apex/www output (only 4 keys)", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
          gitBranch: "main",
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.apex).not.toBeNull();
    const apexKeys = Object.keys(result.apex as object).sort();
    expect(apexKeys).toEqual(
      ["name", "redirect", "redirectStatusCode", "verified"].sort(),
    );
  });

  it("echoes the input project name in result.project", async () => {
    const client = makeClient({
      domains: [
        makeDomain({ name: "alpha-site.com", redirect: null }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = await run(client, "alpha-site");
    expect(result.project).toBe("alpha-site");
  });

  it("audits only the FIRST apex group when multiple apex groups exist", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          apexName: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          apexName: "alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
        makeDomain({
          name: "beta-site.com",
          apexName: "beta-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.beta-site.com",
          apexName: "beta-site.com",
          redirect: "beta-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = await run(client, "multi-project");
    expect(result.apex?.name).toBe("alpha-site.com");
    expect(result.www?.name).toBe("www.alpha-site.com");
    expect(result.canonical).toBe("apex");
  });
});
