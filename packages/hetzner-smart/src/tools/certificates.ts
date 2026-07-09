import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import { confirmField } from "./wait-schema.js";
import { nullableString } from "./null-helpers.js";

// Slim view of a Hetzner TLS Certificate. Upstream also returns the PEM blob,
// fingerprint, created/not_valid_before, status, and used_by; the tool layer
// drops everything outside these six fields.
export type SlimCertificate = {
  id: number;
  name: string;
  type: string;
  domain_names: string[];
  not_valid_after: string | null;
  labels: Record<string, string>;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Slim-maps a raw Hetzner certificate payload. Every access is guarded: upstream
// can null labels, omit domain_names, and leave not_valid_after unset while a
// managed certificate is still being issued.
function mapCertificate(raw: Record<string, unknown>): SlimCertificate {
  const labelsRaw = asObject(raw.labels);
  const domainNames = Array.isArray(raw.domain_names)
    ? raw.domain_names.filter((d): d is string => typeof d === "string")
    : [];

  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    type: typeof raw.type === "string" ? raw.type : "",
    domain_names: domainNames,
    not_valid_after: nullableString(raw.not_valid_after),
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
  };
}

// =============================================================================
// list_certificates
// =============================================================================

const listCertificatesInputSchema = z.object({
  name: z.string().min(1).optional(),
  label_selector: z.string().min(1).optional(),
});

type ListCertificatesInput = z.infer<typeof listCertificatesInputSchema>;

type ListCertificatesOutput = {
  certificates: SlimCertificate[];
  count: number;
};

export const listCertificates = defineTool<
  ListCertificatesInput,
  ListCertificatesOutput,
  HetznerContext
>({
  name: "list_certificates",
  description: "List TLS certificates",
  inputSchema: listCertificatesInputSchema,
  handler: async (input, context) => {
    const params: { name?: string; label_selector?: string } = {};
    if (input.name !== undefined) params.name = input.name;
    if (input.label_selector !== undefined) {
      params.label_selector = input.label_selector;
    }

    const body = await context.client.listCertificates(params);
    const raw = body.certificates;
    const certs = Array.isArray(raw) ? raw : [];
    return {
      certificates: certs.map((c) => mapCertificate(c as Record<string, unknown>)),
      count: certs.length,
    };
  },
});

// =============================================================================
// create_certificate
// =============================================================================

const createCertificateInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["uploaded", "managed"]).optional().default("uploaded"),
  certificate: z.string().min(1).optional(),
  private_key: z.string().min(1).optional(),
  domain_names: z.array(z.string().min(1)).optional(),
  labels: z.record(z.string()).optional(),
});

type CreateCertificateInput = z.infer<typeof createCertificateInputSchema>;

export const createCertificate = defineTool<
  CreateCertificateInput,
  SlimCertificate,
  HetznerContext
>({
  name: "create_certificate",
  description: "Upload or request a TLS certificate",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    createCertificateInputSchema as unknown as z.ZodType<CreateCertificateInput>,
  handler: async (input, context) => {
    // Only forward fields the caller set. Uploaded certs need certificate +
    // private_key; managed certs need domain_names. We never fabricate either.
    const body: Record<string, unknown> = {
      name: input.name,
      type: input.type,
    };
    if (input.certificate !== undefined) body.certificate = input.certificate;
    if (input.private_key !== undefined) body.private_key = input.private_key;
    if (input.domain_names !== undefined) body.domain_names = input.domain_names;
    if (input.labels !== undefined) body.labels = input.labels;

    // createCertificate returns the full raw body nesting the resource under
    // `certificate` (managed certs also carry an `action` we do not surface).
    const created = await context.client.createCertificate(body);
    const cert = asObject((created as Record<string, unknown>).certificate) ?? {};
    return mapCertificate(cert);
  },
});

// =============================================================================
// delete_certificate
// =============================================================================

const deleteCertificateInputSchema = z.object({
  certificate_id: z.number().int().positive(),
  confirm: confirmField,
});

type DeleteCertificateInput = z.infer<typeof deleteCertificateInputSchema>;

type DeleteCertificateOutput = {
  certificate_id: number;
  deleted: true;
};

export const deleteCertificate = defineTool<
  DeleteCertificateInput,
  DeleteCertificateOutput,
  HetznerContext
>({
  name: "delete_certificate",
  description: "Delete a TLS certificate",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    deleteCertificateInputSchema as unknown as z.ZodType<DeleteCertificateInput>,
  handler: async (input, context) => {
    // No single-certificate GET exists upstream, so the preview names the id.
    const preview =
      `Will PERMANENTLY DELETE certificate ${input.certificate_id} (load balancers lose it)`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteCertificate(input.certificate_id);
    return { certificate_id: input.certificate_id, deleted: true };
  },
});
