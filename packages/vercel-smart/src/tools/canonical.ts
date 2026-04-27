import { z } from "zod";
import { defineTool } from "smart-mcp-core";
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
