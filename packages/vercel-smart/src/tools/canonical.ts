import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { VercelClient } from "../client.js";

const inputSchema = z.object({
  project: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;

type Context = {
  client: VercelClient;
};

interface UpstreamDomain {
  name: string;
  apexName: string;
  redirect: string | null;
  redirectStatusCode: number | null;
  verified: boolean;
}

interface SlimDomain {
  name: string;
  redirect: string | null;
  redirectStatusCode: number | null;
  verified: boolean;
}

type Canonical = "apex" | "www" | "split" | "none" | "broken";

interface CanonicalAuditOutput {
  project: string;
  apex: SlimDomain | null;
  www: SlimDomain | null;
  canonical: Canonical;
  notes: string[];
}

function slim(d: UpstreamDomain): SlimDomain {
  return {
    name: d.name,
    redirect: d.redirect,
    redirectStatusCode: d.redirectStatusCode,
    verified: d.verified,
  };
}

export function classify(
  project: string,
  domains: ReadonlyArray<UpstreamDomain>,
): CanonicalAuditOutput {
  const apexRaw = domains.find((d) => d.name === d.apexName);
  if (!apexRaw) {
    return { project, apex: null, www: null, canonical: "none", notes: [] };
  }

  const wwwName = `www.${apexRaw.apexName}`;
  const wwwRaw = domains.find((d) => d.name === wwwName);
  const apex = slim(apexRaw);
  const www = wwwRaw ? slim(wwwRaw) : null;

  let canonical: Canonical;
  if (!www) {
    canonical = "none";
  } else if (apex.redirect === null && www.redirect === apex.name) {
    canonical = "apex";
  } else if (www.redirect === null && apex.redirect === www.name) {
    canonical = "www";
  } else if (apex.redirect === www.name && www.redirect === apex.name) {
    canonical = "broken";
  } else {
    canonical = "split";
  }

  const notes: string[] = [];

  if (!apex.verified) {
    notes.push(`apex domain '${apex.name}' is unverified`);
  }
  if (www && !www.verified) {
    notes.push(`www domain '${www.name}' is unverified`);
  }

  if (canonical === "apex" && www) {
    const code = www.redirectStatusCode;
    if (code !== 308 && code !== 301) {
      notes.push(
        `redirect status is ${code}, recommended: 308 (permanent)`,
      );
    }
  } else if (canonical === "www" && www) {
    const code = apex.redirectStatusCode;
    if (code !== 308 && code !== 301) {
      notes.push(
        `redirect status is ${code}, recommended: 308 (permanent)`,
      );
    }
  }

  if (canonical === "broken" && www) {
    notes.push(
      `redirect loop detected: ${apex.name} <-> ${www.name}`,
    );
  }

  // Off-project redirect notes.
  const projectDomainNames = new Set(domains.map((d) => d.name));
  if (
    apex.redirect !== null &&
    (!www || apex.redirect !== www.name) &&
    !projectDomainNames.has(apex.redirect)
  ) {
    notes.push(
      `apex redirects to '${apex.redirect}' which is not a domain on this project`,
    );
  }
  if (
    www &&
    www.redirect !== null &&
    www.redirect !== apex.name &&
    !projectDomainNames.has(www.redirect)
  ) {
    notes.push(
      `www redirects to '${www.redirect}' which is not a domain on this project`,
    );
  }

  return { project, apex, www, canonical, notes };
}

export const canonicalAudit = defineTool<Input, CanonicalAuditOutput, Context>({
  name: "canonical_audit",
  description: "Audit which apex/www variant is canonical for a Vercel project.",
  inputSchema,
  handler: async (input, context) => {
    const { domains } = await context.client.listProjectDomains(input.project);
    return classify(input.project, domains as ReadonlyArray<UpstreamDomain>);
  },
});

interface RedirectEntry {
  from: string;
  to: string;
  statusCode: number;
}

interface RedirectsAuditOutput {
  project: string;
  redirects: RedirectEntry[];
  count: number;
}

interface ConfiguredRedirectDomain extends UpstreamDomain {
  redirect: string;
  redirectStatusCode: number;
}

function hasConfiguredRedirect(d: UpstreamDomain): d is ConfiguredRedirectDomain {
  return d.redirect !== null && d.redirectStatusCode !== null;
}

export const redirectsAudit = defineTool<Input, RedirectsAuditOutput, Context>({
  name: "redirects_audit",
  description: "Show every domain on a project that has a configured redirect.",
  inputSchema,
  handler: async (input, context) => {
    const { domains } = await context.client.listProjectDomains(input.project);
    const upstream = domains as ReadonlyArray<UpstreamDomain>;
    const redirects: RedirectEntry[] = upstream
      .filter(hasConfiguredRedirect)
      .map((d) => ({
        from: d.name,
        to: d.redirect,
        statusCode: d.redirectStatusCode,
      }));
    return { project: input.project, redirects, count: redirects.length };
  },
});

// ---------- flip_canonical ----------

const flipInputSchema = z.object({
  project: z.string().min(1),
  target: z.enum(["apex", "www"]),
  statusCode: z
    .union([z.literal(301), z.literal(308)])
    .optional()
    .default(308),
  confirm: z.boolean().optional().default(false),
  skip_verify: z.boolean().optional().default(false),
});

type FlipInput = z.output<typeof flipInputSchema>;

interface BeforeAfter {
  apex_redirect: string | null;
  www_redirect: string | null;
  status_codes: { apex: number | null; www: number | null };
}

interface ChangeEntry {
  domain: string;
  field: "redirect" | "redirectStatusCode";
  before: unknown;
  after: unknown;
}

interface VerifyObservation {
  url: string;
  status: number;
  location?: string;
}

interface VerifyResult {
  apex: VerifyObservation;
  www: VerifyObservation;
}

interface FlipCanonicalOutput {
  ok: boolean;
  before: BeforeAfter;
  after: BeforeAfter;
  changes: ChangeEntry[];
  verified: VerifyResult | null;
  verified_at: string | null;
}

interface DesiredState {
  apex: { redirect: string | null; statusCode: number | null };
  www: { redirect: string | null; statusCode: number | null };
}

function formatBeforeAfter(
  apex: { name: string; redirect: string | null; redirectStatusCode: number | null } | null,
  www: { name: string; redirect: string | null; redirectStatusCode: number | null } | null,
): BeforeAfter {
  return {
    apex_redirect: apex ? apex.redirect : null,
    www_redirect: www ? www.redirect : null,
    status_codes: {
      apex: apex ? apex.redirectStatusCode : null,
      www: www ? www.redirectStatusCode : null,
    },
  };
}

function computeDesired(
  apexName: string,
  wwwName: string,
  target: "apex" | "www",
  statusCode: 301 | 308,
): DesiredState {
  if (target === "apex") {
    return {
      apex: { redirect: null, statusCode: null },
      www: { redirect: apexName, statusCode },
    };
  }
  return {
    apex: { redirect: wwwName, statusCode },
    www: { redirect: null, statusCode: null },
  };
}

function diffChanges(
  apex: { name: string; redirect: string | null; redirectStatusCode: number | null },
  www: { name: string; redirect: string | null; redirectStatusCode: number | null },
  desired: DesiredState,
): ChangeEntry[] {
  const changes: ChangeEntry[] = [];
  if (apex.redirect !== desired.apex.redirect) {
    changes.push({
      domain: apex.name,
      field: "redirect",
      before: apex.redirect,
      after: desired.apex.redirect,
    });
  }
  if (apex.redirectStatusCode !== desired.apex.statusCode) {
    changes.push({
      domain: apex.name,
      field: "redirectStatusCode",
      before: apex.redirectStatusCode,
      after: desired.apex.statusCode,
    });
  }
  if (www.redirect !== desired.www.redirect) {
    changes.push({
      domain: www.name,
      field: "redirect",
      before: www.redirect,
      after: desired.www.redirect,
    });
  }
  if (www.redirectStatusCode !== desired.www.statusCode) {
    changes.push({
      domain: www.name,
      field: "redirectStatusCode",
      before: www.redirectStatusCode,
      after: desired.www.statusCode,
    });
  }
  return changes;
}

function buildPreview(
  project: string,
  target: "apex" | "www",
  changes: ChangeEntry[],
): string {
  const lines = [`Will flip ${project} canonical to ${target}:`];
  for (const c of changes) {
    lines.push(`  ${c.domain}.${c.field}: ${formatVal(c.before)} -> ${formatVal(c.after)}`);
  }
  return lines.join("\n");
}

function formatVal(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `'${v}'`;
  return String(v);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(url: string): Promise<VerifyObservation> {
  const res = await fetch(url, { redirect: "manual" });
  const obs: VerifyObservation = { url, status: res.status };
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (loc) obs.location = loc;
  }
  return obs;
}

async function verifyCanonical(
  apexName: string,
  wwwName: string,
  target: "apex" | "www",
  statusCode: 301 | 308,
): Promise<VerifyResult> {
  const apexUrl = `https://${apexName}`;
  const wwwUrl = `https://${wwwName}`;
  let last: VerifyResult = {
    apex: { url: apexUrl, status: 0 },
    www: { url: wwwUrl, status: 0 },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const apexObs = await probe(apexUrl);
    const wwwObs = await probe(wwwUrl);
    last = { apex: apexObs, www: wwwObs };

    const apexOk =
      target === "apex"
        ? apexObs.status >= 200 && apexObs.status < 300
        : apexObs.status === statusCode;
    const wwwOk =
      target === "www"
        ? wwwObs.status >= 200 && wwwObs.status < 300
        : wwwObs.status === statusCode;
    if (apexOk && wwwOk) return last;

    if (attempt < 2) await sleep(5000);
  }
  return last;
}

export const flipCanonical = defineTool<FlipInput, FlipCanonicalOutput, Context>({
  name: "flip_canonical",
  description: "Switch apex<->www canonical redirect for a project. Destructive.",
  inputSchema: flipInputSchema as unknown as z.ZodType<FlipInput>,
  handler: async (input, context) => {
    const initial = await context.client.listProjectDomains(input.project);
    const upstream = initial.domains as ReadonlyArray<UpstreamDomain>;
    const audit = classify(input.project, upstream);

    if (audit.apex === null || audit.www === null) {
      const which = audit.apex === null ? "apex" : "www";
      throw new Error(
        `Cannot flip canonical: project '${input.project}' is missing ${which} domain`,
      );
    }

    const apex = audit.apex;
    const www = audit.www;
    const before = formatBeforeAfter(apex, www);
    const desired = computeDesired(apex.name, www.name, input.target, input.statusCode);
    const changes = diffChanges(apex, www, desired);

    if (changes.length === 0) {
      return {
        ok: true,
        before,
        after: before,
        changes: [],
        verified: null,
        verified_at: null,
      };
    }

    const preview = buildPreview(input.project, input.target, changes);
    guardDestructive({ confirm: input.confirm, preview });

    // Apply in safe order:
    // - First, set the side that WILL redirect (target=apex => www; target=www => apex)
    // - Then, NULL the canonical side
    type PatchBody = {
      redirect: string | null;
      redirectStatusCode: 301 | 302 | 307 | 308 | null;
    };
    const redirectingSide: { name: string; body: PatchBody } =
      input.target === "apex"
        ? {
            name: www.name,
            body: { redirect: apex.name, redirectStatusCode: input.statusCode },
          }
        : {
            name: apex.name,
            body: { redirect: www.name, redirectStatusCode: input.statusCode },
          };
    const canonicalSide: { name: string; body: PatchBody } =
      input.target === "apex"
        ? { name: apex.name, body: { redirect: null, redirectStatusCode: null } }
        : { name: www.name, body: { redirect: null, redirectStatusCode: null } };
    const originalRedirectingSide =
      input.target === "apex"
        ? { redirect: www.redirect, redirectStatusCode: www.redirectStatusCode }
        : { redirect: apex.redirect, redirectStatusCode: apex.redirectStatusCode };

    // Step 1
    await context.client.updateProjectDomain(
      input.project,
      redirectingSide.name,
      redirectingSide.body,
    );

    // Step 2
    try {
      await context.client.updateProjectDomain(
        input.project,
        canonicalSide.name,
        canonicalSide.body,
      );
    } catch (forwardErr) {
      // Rollback step 1
      let rollbackOutcome: string;
      try {
        const restoredCode = originalRedirectingSide.redirectStatusCode;
        const rollbackBody: {
          redirect: string | null;
          redirectStatusCode: 301 | 302 | 307 | 308 | null;
        } = {
          redirect: originalRedirectingSide.redirect,
          redirectStatusCode:
            restoredCode === 301 ||
            restoredCode === 302 ||
            restoredCode === 307 ||
            restoredCode === 308
              ? restoredCode
              : null,
        };
        await context.client.updateProjectDomain(
          input.project,
          redirectingSide.name,
          rollbackBody,
        );
        rollbackOutcome = "rollback succeeded";
      } catch (rollbackErr) {
        const rmsg =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        rollbackOutcome = `rollback FAILED: ${rmsg}`;
      }
      const fmsg = forwardErr instanceof Error ? forwardErr.message : String(forwardErr);
      throw new Error(
        `flip_canonical failed during second PATCH: ${fmsg}; ${rollbackOutcome}`,
      );
    }

    // Re-fetch state for after
    const post = await context.client.listProjectDomains(input.project);
    const postAudit = classify(input.project, post.domains as ReadonlyArray<UpstreamDomain>);
    const after = formatBeforeAfter(postAudit.apex, postAudit.www);

    let verified: VerifyResult | null = null;
    let verified_at: string | null = null;
    if (!input.skip_verify) {
      verified = await verifyCanonical(apex.name, www.name, input.target, input.statusCode);
      verified_at = new Date().toISOString();
    }

    return {
      ok: true,
      before,
      after,
      changes,
      verified,
      verified_at,
    };
  },
});
