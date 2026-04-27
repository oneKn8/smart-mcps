import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { NotFoundError } from "smart-mcp-core";
import { listDomains } from "../domains.js";

type FakeClient = {
  listProjectDomains: ReturnType<typeof vi.fn>;
};

function makeClient(response: { domains: Array<Record<string, unknown>> }): FakeClient {
  return {
    listProjectDomains: vi.fn().mockResolvedValue(response),
  };
}

describe("listDomains — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listDomains.name).toBe("list_domains");
    expect(listDomains.description).toBe(
      "List domains attached to a Vercel project.",
    );
    const parsed = listDomains.inputSchema.parse({ project: "alpha-site" }) as {
      project: string;
    };
    expect(parsed.project).toBe("alpha-site");
    expect(listDomains.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("listDomains — input validation", () => {
  it("rejects empty project string", () => {
    expect(() => listDomains.inputSchema.parse({ project: "" })).toThrow();
  });

  it("rejects missing project field", () => {
    expect(() => listDomains.inputSchema.parse({})).toThrow();
  });
});

describe("listDomains — handler behavior", () => {
  it("calls client.listProjectDomains with input.project", async () => {
    const client = makeClient({ domains: [] });
    await listDomains.handler(
      listDomains.inputSchema.parse({ project: "alpha-site" }) as {
        project: string;
      },
      { client: client as unknown as never },
    );
    expect(client.listProjectDomains).toHaveBeenCalledWith("alpha-site");
  });

  it("maps domain fields to slim shape with all 5 fields populated", async () => {
    const client = makeClient({
      domains: [
        {
          name: "www.alpha-site.com",
          apexName: "alpha-site.com",
          projectId: "prj_alpha",
          redirect: "https://alpha-site.com",
          redirectStatusCode: 308,
          verified: true,
          gitBranch: null,
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
        },
      ],
    });
    const result = (await listDomains.handler(
      listDomains.inputSchema.parse({ project: "alpha-site" }) as {
        project: string;
      },
      { client: client as unknown as never },
    )) as {
      domains: Array<{
        name: string;
        apexName: string;
        redirect: string | null;
        redirectStatusCode: number | null;
        verified: boolean;
      }>;
      count: number;
    };
    expect(result.domains[0]).toEqual({
      name: "www.alpha-site.com",
      apexName: "alpha-site.com",
      redirect: "https://alpha-site.com",
      redirectStatusCode: 308,
      verified: true,
    });
  });

  it("count matches domains.length", async () => {
    const client = makeClient({
      domains: [
        {
          name: "alpha-site.com",
          apexName: "alpha-site.com",
          projectId: "prj_alpha",
          redirect: null,
          redirectStatusCode: null,
          verified: true,
          createdAt: 1,
          updatedAt: 2,
        },
        {
          name: "www.alpha-site.com",
          apexName: "alpha-site.com",
          projectId: "prj_alpha",
          redirect: "https://alpha-site.com",
          redirectStatusCode: 308,
          verified: true,
          createdAt: 3,
          updatedAt: 4,
        },
      ],
    });
    const result = (await listDomains.handler(
      listDomains.inputSchema.parse({ project: "alpha-site" }) as {
        project: string;
      },
      { client: client as unknown as never },
    )) as { count: number; domains: unknown[] };
    expect(result.count).toBe(2);
    expect(result.domains).toHaveLength(2);
  });

  it("strips extra fields from domain objects (only 5 allowed keys)", async () => {
    const client = makeClient({
      domains: [
        {
          name: "alpha-site.com",
          apexName: "alpha-site.com",
          projectId: "prj_alpha_should_be_stripped",
          redirect: null,
          redirectStatusCode: null,
          verified: true,
          gitBranch: "main",
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
        },
      ],
    });
    const result = (await listDomains.handler(
      listDomains.inputSchema.parse({ project: "alpha-site" }) as {
        project: string;
      },
      { client: client as unknown as never },
    )) as { domains: Array<Record<string, unknown>> };

    const domain = result.domains[0]!;
    const keys = Object.keys(domain).sort();
    expect(keys).toEqual(
      ["apexName", "name", "redirect", "redirectStatusCode", "verified"].sort(),
    );
    expect(domain).not.toHaveProperty("projectId");
    expect(domain).not.toHaveProperty("gitBranch");
    expect(domain).not.toHaveProperty("createdAt");
    expect(domain).not.toHaveProperty("updatedAt");
  });

  it("returns empty domains array and count=0 when no domains", async () => {
    const client = makeClient({ domains: [] });
    const result = (await listDomains.handler(
      listDomains.inputSchema.parse({ project: "alpha-site" }) as {
        project: string;
      },
      { client: client as unknown as never },
    )) as { domains: unknown[]; count: number };
    expect(result.domains).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("propagates NotFoundError from client", async () => {
    const client: FakeClient = {
      listProjectDomains: vi
        .fn()
        .mockRejectedValue(
          new NotFoundError("Project not found: missing-project"),
        ),
    };
    await expect(
      listDomains.handler(
        listDomains.inputSchema.parse({ project: "missing-project" }) as {
          project: string;
        },
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
