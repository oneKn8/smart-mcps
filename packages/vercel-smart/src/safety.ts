import { PermissionError } from "smart-mcp-core";

/**
 * Production-affecting actions that must clear an explicit, operator-set env gate
 * before they run. The confirm:true flag on a tool is only a secondary speed-bump;
 * this is the primary gate. The MODEL cannot set these env vars — only the human
 * who launches the MCP server can — so a prompt-injected or over-eager agent can
 * never talk its way past a production write.
 */
export type ProdAction =
  | "redeploy_production"
  | "promote_deployment"
  | "pause_project"
  | "unpause_project"
  | "delete_project";

/**
 * M1 — production gate. Throws unless VERCEL_SMART_ALLOW_PROD === "1". When
 * VERCEL_SMART_ALLOWED_PROJECTS is set (comma-separated), the project must also
 * appear in it. `project` is the id or name the caller resolved; matching is
 * exact, and a mismatch fails closed (the safe direction).
 */
export function assertProdAllowed(project: string, action: ProdAction | string): void {
  if (process.env.VERCEL_SMART_ALLOW_PROD !== "1") {
    throw new PermissionError(
      `Production-affecting action '${action}' on project '${project}' is blocked. ` +
        `Set environment variable VERCEL_SMART_ALLOW_PROD=1 in the MCP server config to allow it. ` +
        `(confirm:true alone does not authorize production writes.)`,
    );
  }

  const raw = process.env.VERCEL_SMART_ALLOWED_PROJECTS;
  if (raw !== undefined && raw.trim() !== "") {
    const allowed = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!allowed.includes(project)) {
      throw new PermissionError(
        `Project '${project}' is not in the VERCEL_SMART_ALLOWED_PROJECTS allowlist ` +
          `[${allowed.join(", ")}]. Add '${project}' to VERCEL_SMART_ALLOWED_PROJECTS to allow '${action}'.`,
      );
    }
  }
}

/**
 * M4 — secret-reveal gate. Throws unless VERCEL_SMART_ALLOW_REVEAL === "1".
 * Guards reveal_env and list_env(decrypt=true); without it, decrypted secret
 * values never leave the boundary.
 */
export function assertRevealAllowed(): void {
  if (process.env.VERCEL_SMART_ALLOW_REVEAL !== "1") {
    throw new PermissionError(
      `Revealing decrypted secret values is blocked. ` +
        `Set environment variable VERCEL_SMART_ALLOW_REVEAL=1 in the MCP server config to allow it.`,
    );
  }
}
