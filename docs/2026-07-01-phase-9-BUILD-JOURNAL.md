# Phase 9 build journal — gmail-max (email-smart settings/filters/delete)

Design: `docs/2026-07-01-phase-9-gmail-max-design.md`. Research:
`docs/research/2026-07-01-gmail-settings-filters-delete-reference.md`.
Branch: `phase-9-gmail-max` (stacked on phase-8). Push after each commit.

Extends existing email-smart (30 tools) IN PLACE. Multi-account (methods take account).

## State machine
- [x] Research (scope model verified) + design + committed (2 commits)
- [x] Implement A: filters + 12 basic-settings tools (42 total, 358->411 tests) — verified green +
      filter label-resolution inspected, committed. NOTE: introduced EMAIL_DEFAULT_ACCOUNT env for
      default identity; update_send_as used PUT (fix to PATCH in cross-verify — PUT clobbers other sendAs fields).
- [~] Implement B: sharing + permanent-delete (11 tools) -> 53 total. SEQUENTIAL after A. (dispatched)
      Also fix update_send_as PUT->PATCH.
- [ ] Adversarial cross-verify (gating on delete/forwarding/delegates, filter label resolution)
- [ ] LIVE E2E reversible paths (create_filter->list->delete; get_vacation; list_send_as). Irreversible
      (permanent delete, forwarding, delegates) NOT live-tested — unit+gating only, stated honestly.
- [ ] Scope bump (email auth CLI -> mail.google.com + settings.basic + settings.sharing) + register + handoff

## Scope model (definitive, from research)
- mail.google.com: permanent delete + settings READS + superset of gmail.modify.
- gmail.settings.basic: filters, vacation, imap, pop, language, sendAs update.
- gmail.settings.sharing: autoForwarding, forwardingAddresses, sendAs create/delete, delegates.
- Permanent delete needs mail.google.com (gmail.modify insufficient). Settings scopes NOT implied by mail.google.com.
- PRODUCTION consent screen: all 3 must be registered at console.cloud.google.com/auth/scopes BEFORE
  re-auth or Google drops them (same issue hit with run_function external_request).

## Notes
- Current email token = gmail.modify only. New tools fail LIVE until scope bump + re-auth. Unit-testable now.
- Gating: permanent delete + auto-forwarding + forwarding addr + delegates = hard-gated; filters/vacation/settings ungated.
