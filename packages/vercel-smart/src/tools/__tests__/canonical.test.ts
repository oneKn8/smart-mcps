import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError } from "smart-mcp-core";
import { canonicalAudit, redirectsAudit, flipCanonical } from "../canonical.js";

type FakeClient = {
  listProjectDomains: ReturnType<typeof vi.fn>;
  updateProjectDomain?: ReturnType<typeof vi.fn>;
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

type RedirectEntry = { from: string; to: string; statusCode: number };
type RedirectsAuditOutput = {
  project: string;
  redirects: RedirectEntry[];
  count: number;
};

async function runRedirects(
  client: FakeClient,
  project: string,
): Promise<RedirectsAuditOutput> {
  const input = redirectsAudit.inputSchema.parse({ project }) as { project: string };
  return (await redirectsAudit.handler(input, {
    client: client as unknown as never,
  })) as RedirectsAuditOutput;
}

describe("redirectsAudit", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(redirectsAudit.name).toBe("redirects_audit");
    expect(redirectsAudit.description).toBe(
      "Show every domain on a project that has a configured redirect.",
    );
    const parsed = redirectsAudit.inputSchema.parse({ project: "alpha-site" }) as {
      project: string;
    };
    expect(parsed.project).toBe("alpha-site");
    expect(redirectsAudit.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty project string", () => {
    expect(() => redirectsAudit.inputSchema.parse({ project: "" })).toThrow();
  });

  it("calls client.listProjectDomains with input.project", async () => {
    const client = makeClient({ domains: [] });
    await runRedirects(client, "alpha-site");
    expect(client.listProjectDomains).toHaveBeenCalledWith("alpha-site");
  });

  it("returns empty redirects when no domain has a redirect", async () => {
    const client = makeClient({
      domains: [
        makeDomain({ name: "alpha-site.com", redirect: null, redirectStatusCode: null }),
        makeDomain({ name: "www.alpha-site.com", redirect: null, redirectStatusCode: null }),
      ],
    });
    const result = await runRedirects(client, "alpha-site");
    expect(result).toEqual({ project: "alpha-site", redirects: [], count: 0 });
  });

  it("returns a single redirect with exact shape", async () => {
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
    const result = await runRedirects(client, "alpha-site");
    expect(result.count).toBe(1);
    expect(result.redirects).toHaveLength(1);
    expect(result.redirects[0]).toEqual({
      from: "www.alpha-site.com",
      to: "alpha-site.com",
      statusCode: 308,
    });
  });

  it("returns multiple redirects with their own status codes", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          redirect: "canonical.com",
          redirectStatusCode: 301,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
        makeDomain({
          name: "beta-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 302,
        }),
        makeDomain({
          name: "gamma-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
      ],
    });
    const result = await runRedirects(client, "alpha-site");
    expect(result.count).toBe(3);
    expect(result.redirects).toContainEqual({
      from: "alpha-site.com",
      to: "canonical.com",
      statusCode: 301,
    });
    expect(result.redirects).toContainEqual({
      from: "www.alpha-site.com",
      to: "alpha-site.com",
      statusCode: 308,
    });
    expect(result.redirects).toContainEqual({
      from: "beta-site.com",
      to: "alpha-site.com",
      statusCode: 302,
    });
  });

  it("skips domain with redirect set but statusCode null", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "alpha-site.com",
          redirect: "x.com",
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = await runRedirects(client, "alpha-site");
    expect(result.count).toBe(1);
    expect(result.redirects[0]?.from).toBe("www.alpha-site.com");
  });

  it("strips upstream extras from each redirect entry (only 3 keys)", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
          gitBranch: "main",
          createdAt: 1700000000000,
          updatedAt: 1700000001000,
        }),
      ],
    });
    const result = await runRedirects(client, "alpha-site");
    expect(result.redirects).toHaveLength(1);
    const keys = Object.keys(result.redirects[0] as object).sort();
    expect(keys).toEqual(["from", "statusCode", "to"]);
  });

  it("echoes the input project name in result.project", async () => {
    const client = makeClient({
      domains: [
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = await runRedirects(client, "alpha-site");
    expect(result.project).toBe("alpha-site");
  });
});

// ---------- flipCanonical ----------

type FlipClient = {
  listProjectDomains: ReturnType<typeof vi.fn>;
  updateProjectDomain: ReturnType<typeof vi.fn>;
};

function makeFlipClient(opts: {
  before: Array<Record<string, unknown>>;
  after?: Array<Record<string, unknown>>;
  updateImpl?: (
    project: string,
    domain: string,
    body: Record<string, unknown>,
  ) => Promise<unknown>;
}): FlipClient {
  const listMock = vi.fn();
  listMock.mockResolvedValueOnce({ domains: opts.before });
  if (opts.after) {
    listMock.mockResolvedValueOnce({ domains: opts.after });
  } else {
    listMock.mockResolvedValueOnce({ domains: opts.before });
  }
  const updateMock = vi.fn();
  if (opts.updateImpl) {
    updateMock.mockImplementation(opts.updateImpl);
  } else {
    updateMock.mockImplementation(async (_p, _d, body) => body);
  }
  return {
    listProjectDomains: listMock,
    updateProjectDomain: updateMock,
  };
}

type FlipInput = {
  project: string;
  target: "apex" | "www";
  statusCode?: 301 | 308;
  confirm?: boolean;
  skip_verify?: boolean;
};

async function runFlip(client: FlipClient, raw: FlipInput): Promise<unknown> {
  const input = flipCanonical.inputSchema.parse(raw);
  return await flipCanonical.handler(input as never, {
    client: client as unknown as never,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("flipCanonical — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(flipCanonical.name).toBe("flip_canonical");
    expect(flipCanonical.description).toBe(
      "Switch apex<->www canonical redirect for a project. Destructive.",
    );
    expect(flipCanonical.inputSchema).toBeInstanceOf(z.ZodType);
    const parsed = flipCanonical.inputSchema.parse({
      project: "alpha-site",
      target: "apex",
    });
    expect(parsed).toMatchObject({
      project: "alpha-site",
      target: "apex",
      statusCode: 308,
      confirm: false,
      skip_verify: false,
    });
  });

  it("schema rejects invalid target", () => {
    expect(() =>
      flipCanonical.inputSchema.parse({ project: "x", target: "invalid" }),
    ).toThrow();
  });

  it("schema rejects invalid statusCode", () => {
    expect(() =>
      flipCanonical.inputSchema.parse({
        project: "x",
        target: "apex",
        statusCode: 302,
      }),
    ).toThrow();
  });

  it("schema applies defaults", () => {
    const parsed = flipCanonical.inputSchema.parse({
      project: "alpha-site",
      target: "www",
    });
    expect(parsed).toEqual({
      project: "alpha-site",
      target: "www",
      statusCode: 308,
      confirm: false,
      skip_verify: false,
    });
  });
});

describe("flipCanonical — confirm gate and idempotence", () => {
  it("confirm:false throws ConfirmRequiredError with preview containing changes", async () => {
    // Currently canonical=www, asking to flip to apex
    const client = makeFlipClient({
      before: [
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
    let caught: unknown = null;
    try {
      await runFlip(client, { project: "alpha-site", target: "apex" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    const e = caught as ConfirmRequiredError;
    expect(e.preview).toContain("alpha-site.com");
    expect(e.preview).toContain("www.alpha-site.com");
    expect(e.preview).toContain("->");
    expect(client.updateProjectDomain).not.toHaveBeenCalled();
  });

  it("already canonical: returns no-op without calling updateProjectDomain (no confirm needed)", async () => {
    // Currently canonical=apex, asking for apex
    const client = makeFlipClient({
      before: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = (await runFlip(client, {
      project: "alpha-site",
      target: "apex",
      confirm: false,
    })) as {
      ok: boolean;
      changes: unknown[];
      verified: unknown;
      verified_at: unknown;
    };
    expect(result.ok).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.verified).toBeNull();
    expect(result.verified_at).toBeNull();
    expect(client.updateProjectDomain).not.toHaveBeenCalled();
  });

  it("missing apex: throws informative error mentioning project and 'apex'", async () => {
    const client = makeFlipClient({
      before: [
        makeDomain({
          name: "www.alpha-site.com",
          apexName: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
      ],
    });
    let caught: unknown = null;
    try {
      await runFlip(client, {
        project: "alpha-site",
        target: "apex",
        confirm: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("alpha-site");
    expect((caught as Error).message).toContain("apex");
  });

  it("missing www: throws informative error mentioning project and 'www'", async () => {
    const client = makeFlipClient({
      before: [
        makeDomain({
          name: "alpha-site.com",
          apexName: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
      ],
    });
    let caught: unknown = null;
    try {
      await runFlip(client, {
        project: "alpha-site",
        target: "apex",
        confirm: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("alpha-site");
    expect((caught as Error).message).toContain("www");
  });
});

describe("flipCanonical — apply changes", () => {
  it("apex -> www: 2 PATCH calls in correct order (apex first sets redirect, then www nulls)", async () => {
    // Currently canonical=apex, target=www
    const client = makeFlipClient({
      before: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
      after: [
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
    const result = (await runFlip(client, {
      project: "alpha-site",
      target: "www",
      confirm: true,
      skip_verify: true,
    })) as { ok: boolean; changes: unknown[] };

    expect(client.updateProjectDomain).toHaveBeenCalledTimes(2);
    const calls = client.updateProjectDomain.mock.calls;
    // First: set apex redirect to www
    expect(calls[0][0]).toBe("alpha-site");
    expect(calls[0][1]).toBe("alpha-site.com");
    expect(calls[0][2]).toEqual({
      redirect: "www.alpha-site.com",
      redirectStatusCode: 308,
    });
    // Second: null out www
    expect(calls[1][0]).toBe("alpha-site");
    expect(calls[1][1]).toBe("www.alpha-site.com");
    expect(calls[1][2]).toEqual({
      redirect: null,
      redirectStatusCode: null,
    });
    expect(result.ok).toBe(true);
    expect((result.changes as unknown[]).length).toBeGreaterThan(0);
  });

  it("www -> apex: 2 PATCH calls in correct order (www first sets redirect, then apex nulls)", async () => {
    // Currently canonical=www, target=apex
    const client = makeFlipClient({
      before: [
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
      after: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = (await runFlip(client, {
      project: "alpha-site",
      target: "apex",
      confirm: true,
      skip_verify: true,
    })) as { ok: boolean };

    expect(client.updateProjectDomain).toHaveBeenCalledTimes(2);
    const calls = client.updateProjectDomain.mock.calls;
    // First: set www redirect to apex
    expect(calls[0][1]).toBe("www.alpha-site.com");
    expect(calls[0][2]).toEqual({
      redirect: "alpha-site.com",
      redirectStatusCode: 308,
    });
    // Second: null out apex
    expect(calls[1][1]).toBe("alpha-site.com");
    expect(calls[1][2]).toEqual({
      redirect: null,
      redirectStatusCode: null,
    });
    expect(result.ok).toBe(true);
  });

  it("statusCode=301 honored in PATCH body", async () => {
    const client = makeFlipClient({
      before: [
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
    await runFlip(client, {
      project: "alpha-site",
      target: "apex",
      statusCode: 301,
      confirm: true,
      skip_verify: true,
    });
    const calls = client.updateProjectDomain.mock.calls;
    // First call: set www redirect to apex with 301
    expect(calls[0][2]).toEqual({
      redirect: "alpha-site.com",
      redirectStatusCode: 301,
    });
  });
});

describe("flipCanonical — verify", () => {
  it("verify success: returns observed status and location", async () => {
    // Currently apex canonical, target=www -> after flip apex should redirect to www
    const client = makeFlipClient({
      before: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
      after: [
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

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("//alpha-site.com")) {
        return new Response(null, {
          status: 308,
          headers: { location: "https://www.alpha-site.com/" },
        });
      }
      // www
      return new Response(null, { status: 200 });
    });

    const result = (await runFlip(client, {
      project: "alpha-site",
      target: "www",
      confirm: true,
    })) as {
      ok: boolean;
      verified: {
        apex: { url: string; status: number; location?: string };
        www: { url: string; status: number; location?: string };
      };
      verified_at: string;
    };

    expect(result.ok).toBe(true);
    expect(result.verified.apex.status).toBe(308);
    expect(result.verified.apex.location).toBe("https://www.alpha-site.com/");
    expect(result.verified.www.status).toBe(200);
    // verified_at is ISO
    expect(typeof result.verified_at).toBe("string");
    expect(() => new Date(result.verified_at).toISOString()).not.toThrow();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("verify retry: succeeds on second attempt after CDN propagation", async () => {
    vi.useFakeTimers();
    const client = makeFlipClient({
      before: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
      after: [
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

    let apexCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("//alpha-site.com")) {
        apexCalls++;
        if (apexCalls === 1) {
          // CDN hasn't propagated, returns 200 instead of expected 308
          return new Response(null, { status: 200 });
        }
        return new Response(null, {
          status: 308,
          headers: { location: "https://www.alpha-site.com/" },
        });
      }
      return new Response(null, { status: 200 });
    });

    const promise = runFlip(client, {
      project: "alpha-site",
      target: "www",
      confirm: true,
    });

    // Advance through the retry sleep (5000ms)
    await vi.advanceTimersByTimeAsync(6000);

    const result = (await promise) as {
      ok: boolean;
      verified: { apex: { status: number; location?: string } };
    };
    expect(result.ok).toBe(true);
    expect(result.verified.apex.status).toBe(308);
    // We retried — fetch was called more than 2 times (apex+www on attempt 1, then again)
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it("verify gives up after 3 attempts: returns last result, ok still true", async () => {
    vi.useFakeTimers();
    const client = makeFlipClient({
      before: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
      after: [
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

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("//alpha-site.com")) {
        // Always wrong: 200 instead of 308
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 200 });
    });

    const promise = runFlip(client, {
      project: "alpha-site",
      target: "www",
      confirm: true,
    });
    // Advance through 2 retry sleeps (5000ms each)
    await vi.advanceTimersByTimeAsync(15000);

    const result = (await promise) as {
      ok: boolean;
      verified: { apex: { status: number } };
    };
    expect(result.ok).toBe(true);
    expect(result.verified.apex.status).toBe(200); // last (still wrong) value
  });

  it("skip_verify:true returns null verified and null verified_at, no fetch calls", async () => {
    const client = makeFlipClient({
      before: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = (await runFlip(client, {
      project: "alpha-site",
      target: "www",
      confirm: true,
      skip_verify: true,
    })) as { verified: unknown; verified_at: unknown };
    expect(result.verified).toBeNull();
    expect(result.verified_at).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("flipCanonical — rollback and output shape", () => {
  it("rollback: when second PATCH fails, first PATCH is restored", async () => {
    // canonical=apex, target=www
    // First PATCH: apex.redirect = www, statusCode 308 (succeeds)
    // Second PATCH: www null/null (fails)
    // Rollback: apex.redirect = null, statusCode = null
    const client: FlipClient = {
      listProjectDomains: vi
        .fn()
        .mockResolvedValueOnce({
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
            }),
          ],
        }),
      updateProjectDomain: vi.fn(),
    };
    let callIdx = 0;
    client.updateProjectDomain.mockImplementation(async (_p, _d, body) => {
      callIdx++;
      if (callIdx === 2) {
        throw new Error("second patch failed");
      }
      return body;
    });

    let caught: unknown = null;
    try {
      await runFlip(client, {
        project: "alpha-site",
        target: "www",
        confirm: true,
        skip_verify: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);

    // Three calls total: forward apex, forward www (fails), rollback apex
    expect(client.updateProjectDomain).toHaveBeenCalledTimes(3);
    const calls = client.updateProjectDomain.mock.calls;
    // Rollback is third call: restore apex to original (null/null)
    expect(calls[2][1]).toBe("alpha-site.com");
    expect(calls[2][2]).toEqual({
      redirect: null,
      redirectStatusCode: null,
    });
    // Error message mentions both original failure and rollback
    expect((caught as Error).message).toContain("second patch failed");
    expect((caught as Error).message.toLowerCase()).toContain("rollback");
  });

  it("changes[] entries have {domain, field, before, after} shape", async () => {
    const client = makeFlipClient({
      before: [
        makeDomain({
          name: "alpha-site.com",
          redirect: null,
          redirectStatusCode: null,
        }),
        makeDomain({
          name: "www.alpha-site.com",
          redirect: "alpha-site.com",
          redirectStatusCode: 308,
        }),
      ],
    });
    const result = (await runFlip(client, {
      project: "alpha-site",
      target: "www",
      confirm: true,
      skip_verify: true,
    })) as {
      changes: Array<{ domain: string; field: string; before: unknown; after: unknown }>;
    };
    expect(result.changes.length).toBeGreaterThan(0);
    for (const change of result.changes) {
      expect(Object.keys(change).sort()).toEqual(
        ["after", "before", "domain", "field"].sort(),
      );
      expect(typeof change.domain).toBe("string");
      expect(["redirect", "redirectStatusCode"]).toContain(change.field);
    }
  });

  it("before/after use slim shape with apex_redirect, www_redirect, status_codes (no upstream extras)", async () => {
    const client = makeFlipClient({
      before: [
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
          gitBranch: "main",
        }),
      ],
      after: [
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
    const result = (await runFlip(client, {
      project: "alpha-site",
      target: "www",
      confirm: true,
      skip_verify: true,
    })) as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    const beforeKeys = Object.keys(result.before).sort();
    expect(beforeKeys).toEqual(
      ["apex_redirect", "status_codes", "www_redirect"].sort(),
    );
    const afterKeys = Object.keys(result.after).sort();
    expect(afterKeys).toEqual(
      ["apex_redirect", "status_codes", "www_redirect"].sort(),
    );
    const statusCodes = result.before.status_codes as Record<string, unknown>;
    expect(Object.keys(statusCodes).sort()).toEqual(["apex", "www"].sort());
  });
});
