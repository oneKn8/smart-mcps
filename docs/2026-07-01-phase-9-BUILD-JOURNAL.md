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
- [x] Implement B: sharing + 11 permanent-delete tools (53 total, 411->461 tests) — verified green +
      gating inspected (12 guardDestructive sites), update_send_as PUT->PATCH fixed, committed+pushed.
- [x] Adversarial cross-verify: core gating SOLID. All 5 findings FIXED (461->473 tests): HIGH create_filter
      forward action now gated; MED update_imap deleteForever gated; LOW filter name-first+ambiguity refusal;
      LOW sharing-read scope hint -> settings.basic; LOW EMAIL_DEFAULT_ACCOUNT validated. Committed+pushed.
- [ ] LIVE E2E reversible paths (create_filter->list->delete etc.) — pending Santo's scope re-auth.
- WARNING: host root / is 100% full (1.8G free of 460G) — flag to Santo; may cause git/build flakiness.
- auth.py (~/.santo-agent/bin/) SCOPES bumped to mail.google.com + settings.basic + settings.sharing.
  Santo: register 3 scopes on consent screen (console.cloud.google.com/auth/scopes) + re-run auth.py. Pending.
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
