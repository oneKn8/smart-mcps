import { ConfirmRequiredError } from "./errors.js";

export type GuardDestructiveOpts = {
  confirm: boolean;
  preview: string;
};

export function guardDestructive({ confirm, preview }: GuardDestructiveOpts): void {
  if (confirm !== true) {
    throw new ConfirmRequiredError(
      "Destructive operation requires confirm: true. Re-invoke with confirm: true to apply.",
      { preview },
    );
  }
}
