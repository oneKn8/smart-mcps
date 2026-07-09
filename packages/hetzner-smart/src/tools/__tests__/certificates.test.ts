import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listCertificates,
  createCertificate,
  deleteCertificate,
} from "../certificates.js";

// A full upstream certificate with extra fields the slim mapper must strip.
const sampleCert = {
  id: 897,
  name: "webshop-cert",
  type: "uploaded",
  domain_names: ["example.com", "www.example.com"],
  not_valid_after: "2027-01-08T12:10:00+00:00",
  labels: { env: "prod" },
  // Upstream-only fields the slim mapper must strip:
  certificate: "-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----",
  fingerprint: "03:c7:aa:1b",
  created: "2026-01-08T12:10:00+00:00",
  not_valid_before: "2026-01-08T12:10:00+00:00",
  status: null,
  used_by: [{ id: 42, type: "load_balancer" }],
};

type FakeCertClient = {
  listCertificates: ReturnType<typeof vi.fn>;
  createCertificate: ReturnType<typeof vi.fn>;
  deleteCertificate: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeCertClient> = {}): FakeCertClient {
  return {
    listCertificates: vi
      .fn()
      .mockResolvedValue({ certificates: [sampleCert], meta: {} }),
    createCertificate: vi.fn().mockResolvedValue({ certificate: sampleCert }),
    deleteCertificate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const SLIM_KEYS = [
  "id",
  "name",
  "type",
  "domain_names",
  "not_valid_after",
  "labels",
].sort();

// =============================================================================
// list_certificates
// =============================================================================

describe("listCertificates — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listCertificates.name).toBe("list_certificates");
    expect(listCertificates.description).toBeTruthy();
    expect(listCertificates.description.length).toBeGreaterThan(0);
    expect(listCertificates.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listCertificates.inputSchema.parse({})).not.toThrow();
  });

  it("rejects an empty name filter", () => {
    expect(() => listCertificates.inputSchema.parse({ name: "" })).toThrow();
  });
});

describe("listCertificates — handler", () => {
  it("forwards only provided filters to the client", async () => {
    const client = makeClient();
    await listCertificates.handler(
      listCertificates.inputSchema.parse({ label_selector: "env=prod" }),
      { client: client as unknown as never },
    );
    expect(client.listCertificates).toHaveBeenCalledTimes(1);
    expect(client.listCertificates).toHaveBeenCalledWith({
      label_selector: "env=prod",
    });
  });

  it("passes an empty params object when no filters are given", async () => {
    const client = makeClient();
    await listCertificates.handler(listCertificates.inputSchema.parse({}), {
      client: client as unknown as never,
    });
    expect(client.listCertificates).toHaveBeenCalledWith({});
  });

  it("strips upstream extras and returns the slim shape only", async () => {
    const client = makeClient();
    const result = (await listCertificates.handler(
      listCertificates.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { certificates: Array<Record<string, unknown>>; count: number };

    expect(result.certificates).toHaveLength(1);
    expect(result.count).toBe(1);
    const slim = result.certificates[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).toEqual({
      id: 897,
      name: "webshop-cert",
      type: "uploaded",
      domain_names: ["example.com", "www.example.com"],
      not_valid_after: "2027-01-08T12:10:00+00:00",
      labels: { env: "prod" },
    });
    expect(slim).not.toHaveProperty("certificate");
    expect(slim).not.toHaveProperty("fingerprint");
    expect(slim).not.toHaveProperty("used_by");
    expect(slim).not.toHaveProperty("status");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const client = makeClient({
      listCertificates: vi
        .fn()
        .mockResolvedValue({ certificates: [{ id: 5 }] }),
    });
    const result = (await listCertificates.handler(
      listCertificates.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { certificates: Array<Record<string, unknown>> };
    const slim = result.certificates[0]!;
    expect(slim.id).toBe(5);
    expect(slim.name).toBe("");
    expect(slim.type).toBe("");
    expect(slim.domain_names).toEqual([]);
    expect(slim.not_valid_after).toBeNull();
    expect(slim.labels).toEqual({});
  });

  it("returns empty list with count 0 when upstream is empty or malformed", async () => {
    const client = makeClient({
      listCertificates: vi.fn().mockResolvedValue({ certificates: null }),
    });
    const result = (await listCertificates.handler(
      listCertificates.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { certificates: unknown[]; count: number };
    expect(result.certificates).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// =============================================================================
// create_certificate
// =============================================================================

describe("createCertificate — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(createCertificate.name).toBe("create_certificate");
    expect(createCertificate.description).toBeTruthy();
    expect(createCertificate.description.length).toBeGreaterThan(0);
    expect(createCertificate.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults type to 'uploaded' when omitted", () => {
    const parsed = createCertificate.inputSchema.parse({
      name: "cert",
    }) as { type: string };
    expect(parsed.type).toBe("uploaded");
  });

  it("rejects an empty name", () => {
    expect(() =>
      createCertificate.inputSchema.parse({ name: "" }),
    ).toThrow();
  });

  it("rejects an unknown type", () => {
    expect(() =>
      createCertificate.inputSchema.parse({ name: "cert", type: "acme" }),
    ).toThrow();
  });

  it("accepts a managed type with domain_names", () => {
    const parsed = createCertificate.inputSchema.parse({
      name: "cert",
      type: "managed",
      domain_names: ["example.com"],
    }) as { type: string; domain_names: string[] };
    expect(parsed.type).toBe("managed");
    expect(parsed.domain_names).toEqual(["example.com"]);
  });
});

describe("createCertificate — handler", () => {
  it("forwards an uploaded cert body with only provided fields", async () => {
    const client = makeClient();
    await createCertificate.handler(
      createCertificate.inputSchema.parse({
        name: "webshop-cert",
        certificate: "PEM_CERT",
        private_key: "PEM_KEY",
        labels: { env: "prod" },
      }),
      { client: client as unknown as never },
    );
    expect(client.createCertificate).toHaveBeenCalledTimes(1);
    expect(client.createCertificate).toHaveBeenCalledWith({
      name: "webshop-cert",
      type: "uploaded",
      certificate: "PEM_CERT",
      private_key: "PEM_KEY",
      labels: { env: "prod" },
    });
  });

  it("forwards a managed cert body with domain_names and omits unset fields", async () => {
    const client = makeClient();
    await createCertificate.handler(
      createCertificate.inputSchema.parse({
        name: "managed-cert",
        type: "managed",
        domain_names: ["example.com", "www.example.com"],
      }),
      { client: client as unknown as never },
    );
    expect(client.createCertificate).toHaveBeenCalledWith({
      name: "managed-cert",
      type: "managed",
      domain_names: ["example.com", "www.example.com"],
    });
  });

  it("returns the slim shape from body.certificate (only listed keys)", async () => {
    const client = makeClient();
    const result = (await createCertificate.handler(
      createCertificate.inputSchema.parse({
        name: "webshop-cert",
        certificate: "PEM_CERT",
        private_key: "PEM_KEY",
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).toEqual({
      id: 897,
      name: "webshop-cert",
      type: "uploaded",
      domain_names: ["example.com", "www.example.com"],
      not_valid_after: "2027-01-08T12:10:00+00:00",
      labels: { env: "prod" },
    });
  });

  it("null-safes when the body carries no certificate object", async () => {
    const client = makeClient({
      createCertificate: vi.fn().mockResolvedValue({}),
    });
    const result = (await createCertificate.handler(
      createCertificate.inputSchema.parse({
        name: "managed-cert",
        type: "managed",
        domain_names: ["example.com"],
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result.id).toBe(0);
    expect(result.domain_names).toEqual([]);
  });
});

// =============================================================================
// delete_certificate
// =============================================================================

describe("deleteCertificate — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(deleteCertificate.name).toBe("delete_certificate");
    expect(deleteCertificate.description).toBeTruthy();
    expect(deleteCertificate.description.length).toBeGreaterThan(0);
    expect(deleteCertificate.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deleteCertificate.inputSchema.parse({
      certificate_id: 897,
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects a non-positive certificate_id", () => {
    expect(() =>
      deleteCertificate.inputSchema.parse({ certificate_id: 0 }),
    ).toThrow();
  });

  it("rejects a non-integer certificate_id", () => {
    expect(() =>
      deleteCertificate.inputSchema.parse({ certificate_id: 1.5 }),
    ).toThrow();
  });
});

describe("deleteCertificate — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      deleteCertificate.handler(
        deleteCertificate.inputSchema.parse({ certificate_id: 897 }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteCertificate).not.toHaveBeenCalled();
  });

  it("preview names the certificate id", async () => {
    const client = makeClient();
    try {
      await deleteCertificate.handler(
        deleteCertificate.inputSchema.parse({ certificate_id: 897 }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("897");
      expect(preview).toMatch(/delete/i);
    }
  });
});

describe("deleteCertificate — past confirm gate", () => {
  it("with confirm: true deletes and returns confirmation", async () => {
    const client = makeClient();
    const result = (await deleteCertificate.handler(
      deleteCertificate.inputSchema.parse({
        certificate_id: 897,
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as { certificate_id: number; deleted: boolean };
    expect(client.deleteCertificate).toHaveBeenCalledWith(897);
    expect(result).toEqual({ certificate_id: 897, deleted: true });
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      deleteCertificate: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Certificate not found: 999")),
    });
    await expect(
      deleteCertificate.handler(
        deleteCertificate.inputSchema.parse({
          certificate_id: 999,
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
