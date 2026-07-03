import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type {
  VercelClient,
  AddProjectDomainBody,
  ProjectDomain,
  TeamScope,
} from "../client.js";

const inputSchema = z.object({
  project: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;

type Context = {
  client: VercelClient;
};

type SlimDomain = {
  name: string;
  apexName: string;
  redirect: string | null;
  redirectStatusCode: number | null;
  verified: boolean;
};

type Output = {
  domains: SlimDomain[];
  count: number;
};

export const listDomains = defineTool<Input, Output, Context>({
  name: "list_domains",
  description: "List domains attached to a Vercel project.",
  inputSchema,
  handler: async (input, context) => {
    const { domains } = await context.client.listProjectDomains(input.project);
    return {
      domains: domains.map((d) => ({
        name: d.name,
        apexName: d.apexName,
        redirect: d.redirect,
        redirectStatusCode: d.redirectStatusCode,
        verified: d.verified,
      })),
      count: domains.length,
    };
  },
});

// ---------- shared helpers (write tools) ----------

function teamLabel(scope: TeamScope): string {
  return scope.kind === "personal" ? "personal" : scope.slug;
}

interface DomainVerificationChallenge {
  type: string;
  domain: string;
  value: string;
  reason?: string;
}

/**
 * Validate a redirect target and resolve it to an absolute URL for the preview.
 * A redirect on a domain is an open door: a typo or a hostile value silently
 * bounces every visitor off-site. We never send anything we could not parse,
 * and the confirm preview shows the fully-resolved absolute target so the human
 * approves the exact URL traffic will land on (not a bare, ambiguous host).
 * The original (un-normalized) value is what we send upstream — Vercel accepts a
 * bare host — so this only validates and displays, it never mutates intent.
 */
function resolveRedirectTarget(redirect: string): string {
  const trimmed = redirect.trim();
  if (trimmed === "") {
    throw new ValidationError("redirect target is empty");
  }
  const hasScheme = /^https?:\/\//i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ValidationError(
      `redirect target '${redirect}' is not a valid URL or host`,
    );
  }
  if (!url.hostname.includes(".")) {
    throw new ValidationError(
      `redirect target '${redirect}' has no valid public hostname`,
    );
  }
  return url.toString();
}

// ---------- add_domain ----------

const addDomainInputSchema = z.object({
  project: z.string().min(1),
  domain: z.string().min(1),
  gitBranch: z.string().min(1).optional(),
  redirect: z.string().min(1).optional(),
  redirectStatusCode: z
    .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
    .optional(),
  confirm: z.boolean().optional().default(false),
});

type AddDomainInput = z.output<typeof addDomainInputSchema>;

interface AddDomainResult extends ProjectDomain {
  verification?: DomainVerificationChallenge[];
}

interface AddDomainOutput {
  ok: true;
  domain: {
    name: string;
    apexName: string;
    redirect: string | null;
    redirectStatusCode: number | null;
    verified: boolean;
  };
  resolvedRedirect: string | null;
  verification: DomainVerificationChallenge[] | null;
}

export const addDomain = defineTool<AddDomainInput, AddDomainOutput, Context>({
  name: "add_domain",
  description:
    "Attach a domain to a Vercel project (optionally as a redirect). Destructive.",
  inputSchema: addDomainInputSchema as unknown as z.ZodType<AddDomainInput>,
  handler: async (input, context) => {
    if (input.redirectStatusCode !== undefined && input.redirect === undefined) {
      throw new ValidationError(
        "redirectStatusCode was set without a redirect target",
      );
    }

    // Strict resolve first (M5): fail fast on an ambiguous name or a missing
    // project before showing any preview, and derive the team for the preview.
    const { scope } = await context.client.resolveProjectStrict(input.project);
    const team = teamLabel(scope);

    const resolvedRedirect =
      input.redirect !== undefined ? resolveRedirectTarget(input.redirect) : null;

    const lines = [
      `Will add domain '${input.domain}' to project '${input.project}' (team: ${team}).`,
    ];
    if (input.redirect !== undefined) {
      const code = input.redirectStatusCode ?? "default";
      lines.push(`  redirect: -> ${resolvedRedirect} (status ${code})`);
    }
    guardDestructive({ confirm: input.confirm, preview: lines.join("\n") });

    const body: AddProjectDomainBody = { name: input.domain };
    if (input.gitBranch !== undefined) body.gitBranch = input.gitBranch;
    if (input.redirect !== undefined) body.redirect = input.redirect;
    if (input.redirectStatusCode !== undefined) {
      body.redirectStatusCode = input.redirectStatusCode;
    }

    const res = (await context.client.addProjectDomain(
      input.project,
      body,
    )) as AddDomainResult;

    return {
      ok: true,
      domain: {
        name: res.name,
        apexName: res.apexName,
        redirect: res.redirect,
        redirectStatusCode: res.redirectStatusCode,
        verified: res.verified,
      },
      resolvedRedirect,
      verification: Array.isArray(res.verification) ? res.verification : null,
    };
  },
});

// ---------- verify_domain ----------

const verifyDomainInputSchema = z.object({
  project: z.string().min(1),
  domain: z.string().min(1),
});

type VerifyDomainInput = z.infer<typeof verifyDomainInputSchema>;

interface VerifyDomainOutput {
  project: string;
  domain: string;
  verified: boolean;
  verification: DomainVerificationChallenge[] | null;
}

export const verifyDomain = defineTool<
  VerifyDomainInput,
  VerifyDomainOutput,
  Context
>({
  name: "verify_domain",
  description:
    "Trigger DNS verification for a domain on a Vercel project. Idempotent.",
  inputSchema: verifyDomainInputSchema,
  handler: async (input, context) => {
    // Low-risk re-check, no confirm gate. resolveProjectStrict is enforced
    // inside client.verifyProjectDomain so the correct team is always used (M5).
    const res = await context.client.verifyProjectDomain(
      input.project,
      input.domain,
    );
    return {
      project: input.project,
      domain: input.domain,
      verified: res.verified === true,
      verification: Array.isArray(res.verification)
        ? (res.verification as DomainVerificationChallenge[])
        : null,
    };
  },
});

// ---------- remove_domain ----------

const removeDomainInputSchema = z.object({
  project: z.string().min(1),
  domain: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type RemoveDomainInput = z.output<typeof removeDomainInputSchema>;

interface RemoveDomainOutput {
  ok: true;
  project: string;
  domain: string;
  removed: true;
}

export const removeDomain = defineTool<
  RemoveDomainInput,
  RemoveDomainOutput,
  Context
>({
  name: "remove_domain",
  description:
    "Unlink a domain from a Vercel project. Destructive and irreversible.",
  inputSchema: removeDomainInputSchema as unknown as z.ZodType<RemoveDomainInput>,
  handler: async (input, context) => {
    // Strict resolve first (M5): fail fast on an ambiguous name / missing
    // project and derive the team for the preview.
    const { scope } = await context.client.resolveProjectStrict(input.project);
    const team = teamLabel(scope);

    const preview = [
      `Will REMOVE domain '${input.domain}' from project '${input.project}' (team: ${team}).`,
      "  This unlinks the domain from the project (irreversible).",
    ].join("\n");
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.removeProjectDomain(input.project, input.domain);

    return {
      ok: true,
      project: input.project,
      domain: input.domain,
      removed: true,
    };
  },
});
