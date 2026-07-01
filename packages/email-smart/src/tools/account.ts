import { ValidationError } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { listIdentities, loadIdentity } from "../identities.js";

/**
 * Resolve the account a settings tool should act on. Unlike the older send/read
 * tools (which require `account`), the settings tools accept an optional
 * `account` and fall back to the default identity. Resolution order:
 *   1. the explicit `account` argument, if provided;
 *   2. the `EMAIL_DEFAULT_ACCOUNT` env var, if set;
 *   3. the single configured identity, when exactly one exists.
 * When none of these apply (zero or multiple identities and no default set) it
 * throws rather than guessing — picking the wrong mailbox for a settings write
 * (a filter, vacation reply, etc.) is a real correctness hazard.
 */
export function resolveAccount(
  account: string | undefined,
  context: EmailContext,
): string {
  if (typeof account === "string" && account.length > 0) return account;

  const envDefault = process.env.EMAIL_DEFAULT_ACCOUNT;
  if (typeof envDefault === "string" && envDefault.length > 0) {
    return envDefault;
  }

  const identities = listIdentities(context.home);
  if (identities.length === 1) {
    const only = identities[0];
    if (only) return only.account;
  }
  if (identities.length === 0) {
    throw new ValidationError(
      "no account specified and no identities are configured; pass `account` or set EMAIL_DEFAULT_ACCOUNT",
    );
  }
  throw new ValidationError(
    `no account specified and multiple identities are configured (${identities
      .map((i) => i.account)
      .join(", ")}); pass \`account\` or set EMAIL_DEFAULT_ACCOUNT`,
  );
}

/**
 * Guard: Gmail settings only exist for oauth (real Gmail) identities. Reject an
 * smtp-transport identity before any settings mutation. Mirrors the same guard
 * on the label CRUD tools.
 */
export function rejectIfSmtp(account: string, home: string | undefined): void {
  const identity = loadIdentity(account, home);
  if (identity.transport !== "oauth") {
    throw new ValidationError(
      `account "${account}" uses transport "${identity.transport}"; this tool requires oauth transport`,
    );
  }
}
