import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  NotFoundError,
  ConfirmRequiredError,
  AmbiguousMatchError,
  ValidationError,
} from "smart-mcp-core";
import {
  listDomains,
  addDomain,
  verifyDomain,
  removeDomain,
} from "../domains.js";

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

// ---------- write tools (add / verify / remove) ----------

type WriteFakeClient = {
  resolveProjectStrict: ReturnType<typeof vi.fn>;
  addProjectDomain: ReturnType<typeof vi.fn>;
  verifyProjectDomain: ReturnType<typeof vi.fn>;
  removeProjectDomain: ReturnType<typeof vi.fn>;
};

function makeWriteClient(): WriteFakeClient {
  return {
    resolveProjectStrict: vi.fn().mockResolvedValue({
      project: { id: "prj_alpha", name: "alpha-site" },
      scope: { kind: "personal" },
    }),
    addProjectDomain: vi.fn().mockResolvedValue({
      name: "foo.com",
      apexName: "foo.com",
      projectId: "prj_alpha",
      redirect: null,
      redirectStatusCode: null,
      verified: false,
      createdAt: 1,
      updatedAt: 2,
    }),
    verifyProjectDomain: vi.fn().mockResolvedValue({ verified: true }),
    removeProjectDomain: vi.fn().mockResolvedValue({}),
  };
}

async function runAdd(
  client: WriteFakeClient,
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = addDomain.inputSchema.parse(raw);
  return (await addDomain.handler(input as never, {
    client: client as unknown as never,
  })) as Record<string, unknown>;
}

async function runVerify(
  client: WriteFakeClient,
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = verifyDomain.inputSchema.parse(raw);
  return (await verifyDomain.handler(input as never, {
    client: client as unknown as never,
  })) as Record<string, unknown>;
}

async function runRemove(
  client: WriteFakeClient,
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = removeDomain.inputSchema.parse(raw);
  return (await removeDomain.handler(input as never, {
    client: client as unknown as never,
  })) as Record<string, unknown>;
}

describe("addDomain — metadata & schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(addDomain.name).toBe("add_domain");
    expect(addDomain.description).toBe(
      "Attach a domain to a Vercel project (optionally as a redirect). Destructive.",
    );
    expect(addDomain.inputSchema).toBeInstanceOf(z.ZodType);
    const parsed = addDomain.inputSchema.parse({
      project: "alpha-site",
      domain: "foo.com",
    });
    expect(parsed).toMatchObject({
      project: "alpha-site",
      domain: "foo.com",
      confirm: false,
    });
  });

  it("rejects missing domain", () => {
    expect(() => addDomain.inputSchema.parse({ project: "alpha-site" })).toThrow();
  });

  it("rejects an invalid redirectStatusCode", () => {
    expect(() =>
      addDomain.inputSchema.parse({
        project: "alpha-site",
        domain: "foo.com",
        redirect: "bar.com",
        redirectStatusCode: 302999,
      }),
    ).toThrow();
  });
});

describe("addDomain — confirm gate (M-destructive)", () => {
  it("confirm:false throws ConfirmRequiredError with a redirect preview showing the resolved absolute target", async () => {
    const client = makeWriteClient();
    let caught: unknown = null;
    try {
      await runAdd(client, {
        project: "alpha-site",
        domain: "foo.com",
        redirect: "bar.com",
        redirectStatusCode: 308,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    const e = caught as ConfirmRequiredError;
    expect(e.preview).toContain("foo.com");
    expect(e.preview).toContain("https://bar.com/");
    expect(e.preview).toContain("308");
    expect(e.preview).toContain("personal");
    expect(client.addProjectDomain).not.toHaveBeenCalled();
  });

  it("confirm:false (no redirect) throws with a preview that has no redirect line", async () => {
    const client = makeWriteClient();
    let caught: unknown = null;
    try {
      await runAdd(client, { project: "alpha-site", domain: "foo.com" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    expect((caught as ConfirmRequiredError).preview).not.toContain("redirect:");
    expect(client.addProjectDomain).not.toHaveBeenCalled();
  });
});

describe("addDomain — strict resolution (M5)", () => {
  it("propagates AmbiguousMatchError and never writes", async () => {
    const client = makeWriteClient();
    client.resolveProjectStrict.mockRejectedValue(
      new AmbiguousMatchError("Project name 'alpha-site' exists in 2 teams", {
        candidates: [],
      }),
    );
    await expect(
      runAdd(client, { project: "alpha-site", domain: "foo.com", confirm: true }),
    ).rejects.toBeInstanceOf(AmbiguousMatchError);
    expect(client.addProjectDomain).not.toHaveBeenCalled();
  });

  it("resolves strictly with the exact project argument", async () => {
    const client = makeWriteClient();
    await runAdd(client, {
      project: "alpha-site",
      domain: "foo.com",
      confirm: true,
    });
    expect(client.resolveProjectStrict).toHaveBeenCalledWith("alpha-site");
  });
});

describe("addDomain — redirect validation", () => {
  it("rejects redirectStatusCode without a redirect target", async () => {
    const client = makeWriteClient();
    await expect(
      runAdd(client, {
        project: "alpha-site",
        domain: "foo.com",
        redirectStatusCode: 308,
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.resolveProjectStrict).not.toHaveBeenCalled();
    expect(client.addProjectDomain).not.toHaveBeenCalled();
  });

  it("rejects a redirect that is not a valid URL", async () => {
    const client = makeWriteClient();
    await expect(
      runAdd(client, {
        project: "alpha-site",
        domain: "foo.com",
        redirect: "https://",
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.addProjectDomain).not.toHaveBeenCalled();
  });

  it("rejects a redirect host with no dot (no public hostname)", async () => {
    const client = makeWriteClient();
    await expect(
      runAdd(client, {
        project: "alpha-site",
        domain: "foo.com",
        redirect: "localhost",
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.addProjectDomain).not.toHaveBeenCalled();
  });
});

describe("addDomain — apply", () => {
  it("sends the full body and returns the slim domain + resolved redirect + verification", async () => {
    const client = makeWriteClient();
    client.addProjectDomain.mockResolvedValue({
      name: "bar.com",
      apexName: "bar.com",
      projectId: "prj_alpha",
      redirect: "target.com",
      redirectStatusCode: 308,
      verified: false,
      verification: [
        { type: "TXT", domain: "_vercel.bar.com", value: "abc123" },
      ],
      createdAt: 1,
      updatedAt: 2,
    });
    const result = await runAdd(client, {
      project: "alpha-site",
      domain: "bar.com",
      redirect: "target.com",
      redirectStatusCode: 308,
      confirm: true,
    });
    expect(client.addProjectDomain).toHaveBeenCalledWith("alpha-site", {
      name: "bar.com",
      redirect: "target.com",
      redirectStatusCode: 308,
    });
    expect(result).toMatchObject({
      ok: true,
      resolvedRedirect: "https://target.com/",
      domain: {
        name: "bar.com",
        apexName: "bar.com",
        redirect: "target.com",
        redirectStatusCode: 308,
        verified: false,
      },
    });
    expect(result.verification).toEqual([
      { type: "TXT", domain: "_vercel.bar.com", value: "abc123" },
    ]);
  });

  it("omits redirect fields from the body and reports resolvedRedirect null when no redirect given", async () => {
    const client = makeWriteClient();
    const result = await runAdd(client, {
      project: "alpha-site",
      domain: "plain.com",
      confirm: true,
    });
    expect(client.addProjectDomain).toHaveBeenCalledWith("alpha-site", {
      name: "plain.com",
    });
    expect(result.resolvedRedirect).toBeNull();
    expect(result.verification).toBeNull();
  });

  it("forwards gitBranch when provided", async () => {
    const client = makeWriteClient();
    await runAdd(client, {
      project: "alpha-site",
      domain: "preview.com",
      gitBranch: "staging",
      confirm: true,
    });
    expect(client.addProjectDomain).toHaveBeenCalledWith("alpha-site", {
      name: "preview.com",
      gitBranch: "staging",
    });
  });
});

describe("verifyDomain", () => {
  it("has correct name and description", () => {
    expect(verifyDomain.name).toBe("verify_domain");
    expect(verifyDomain.description).toBe(
      "Trigger DNS verification for a domain on a Vercel project. Idempotent.",
    );
  });

  it("calls verifyProjectDomain with project + domain and needs no confirm", async () => {
    const client = makeWriteClient();
    const result = await runVerify(client, {
      project: "alpha-site",
      domain: "foo.com",
    });
    expect(client.verifyProjectDomain).toHaveBeenCalledWith(
      "alpha-site",
      "foo.com",
    );
    expect(result).toEqual({
      project: "alpha-site",
      domain: "foo.com",
      verified: true,
      verification: null,
    });
  });

  it("passes through verification challenges when unverified", async () => {
    const client = makeWriteClient();
    client.verifyProjectDomain.mockResolvedValue({
      verified: false,
      verification: [{ type: "TXT", domain: "d", value: "v" }],
    });
    const result = await runVerify(client, {
      project: "alpha-site",
      domain: "foo.com",
    });
    expect(result.verified).toBe(false);
    expect(result.verification).toEqual([
      { type: "TXT", domain: "d", value: "v" },
    ]);
  });
});

describe("removeDomain — confirm gate & apply", () => {
  it("has correct name and description", () => {
    expect(removeDomain.name).toBe("remove_domain");
    expect(removeDomain.description).toBe(
      "Unlink a domain from a Vercel project. Destructive and irreversible.",
    );
  });

  it("confirm:false throws ConfirmRequiredError with an irreversible-unlink preview and never removes", async () => {
    const client = makeWriteClient();
    let caught: unknown = null;
    try {
      await runRemove(client, { project: "alpha-site", domain: "foo.com" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    const e = caught as ConfirmRequiredError;
    expect(e.preview).toContain("foo.com");
    expect(e.preview).toContain("irreversible");
    expect(client.removeProjectDomain).not.toHaveBeenCalled();
  });

  it("propagates AmbiguousMatchError and never removes (M5)", async () => {
    const client = makeWriteClient();
    client.resolveProjectStrict.mockRejectedValue(
      new AmbiguousMatchError("Project name 'alpha-site' exists in 2 teams", {
        candidates: [],
      }),
    );
    await expect(
      runRemove(client, {
        project: "alpha-site",
        domain: "foo.com",
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(AmbiguousMatchError);
    expect(client.removeProjectDomain).not.toHaveBeenCalled();
  });

  it("confirm:true removes the domain and returns the ok shape", async () => {
    const client = makeWriteClient();
    const result = await runRemove(client, {
      project: "alpha-site",
      domain: "foo.com",
      confirm: true,
    });
    expect(client.resolveProjectStrict).toHaveBeenCalledWith("alpha-site");
    expect(client.removeProjectDomain).toHaveBeenCalledWith(
      "alpha-site",
      "foo.com",
    );
    expect(result).toEqual({
      ok: true,
      project: "alpha-site",
      domain: "foo.com",
      removed: true,
    });
  });
});
