# Email MCP Server Landscape — April 2026

Research input for designing `email-smart` in the smart-mcps suite. Sources cited inline.

---

## 1. Existing Email MCP servers

The ecosystem splits cleanly into three transport camps: **transactional API** (Resend/Postmark/SendGrid), **OAuth provider** (Gmail/Outlook), and **raw IMAP+SMTP** (everything else). Top implementations:

| Name | Repo | Transport / provider | Lang | Tools (count) | Sample tools |
|---|---|---|---|---|---|
| **resend/mcp-send-email** (official) | [github.com/resend/mcp-send-email](https://github.com/resend/mcp-send-email) | Resend HTTP API, API key | TS | ~50+ across 10 categories | `send_email`, `list_emails`, `batch_send`, `create_domain`, `verify_domain`, `create_contact`, `create_broadcast`, `create_webhook` |
| **ActiveCampaign/postmark-mcp** (official, Postmark Labs) | [github.com/ActiveCampaign/postmark-mcp](https://github.com/ActiveCampaign/postmark-mcp) | Postmark HTTP API, server token | JS (Node) | **4** | `sendEmail`, `sendEmailWithTemplate`, `listTemplates`, `getDeliveryStats` |
| **GongRzhe/Gmail-MCP-Server** | [github.com/GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) | Gmail API, OAuth2 desktop app | TS | **19** | `send_email`, `draft_email`, `read_email`, `search_emails`, `download_attachment`, `modify_email`, `batch_delete_emails`, `create_filter`, `list_email_labels` |
| **shinzo-labs/gmail-mcp** | [github.com/shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp) | Gmail API, OAuth2 | TS | **60+** | full Gmail surface incl. threads, vacation responder, IMAP/POP toggles, auto-forwarding |
| **Garoth/sendgrid-mcp** | [github.com/Garoth/sendgrid-mcp](https://github.com/Garoth/sendgrid-mcp) | SendGrid v3 API, API key | TS (Node) | ~20 | contact lists, templates, single sends, stats |
| **codefuturist/email-mcp** | [github.com/codefuturist/email-mcp](https://github.com/codefuturist/email-mcp) | IMAP + SMTP | TS | **47 tools, 7 prompts, 6 resources** | full inbox (read/search/send/manage/schedule), IDLE watcher, AI triage |
| **yunfeizhu/mcp-mail-server** | [github.com/yunfeizhu/mcp-mail-server](https://github.com/yunfeizhu/mcp-mail-server) | IMAP + SMTP | TS | small | send/list/read |
| **samihalawa/mcp-server-smtp** | [github.com/samihalawa/mcp-server-smtp](https://github.com/samihalawa/mcp-server-smtp) | SMTP only, multi-config | TS | small | templated bulk send w/ rate limiting |
| **forwardemail/mcp-server** | [github.com/forwardemail/mcp-server](https://github.com/forwardemail/mcp-server) | Forward Email API | — | — | inbox-oriented |

There is **no** email server in the official `modelcontextprotocol/servers` repo — every implementation is community or vendor-built ([modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)).

---

## 2. Transport / provider choice patterns

Three clusters with distinct trade-offs ([Resend vs SendGrid vs Postmark 2026](https://blog.vibecoder.me/resend-vs-sendgrid-vs-postmark-email-services), [devtoolpicks 2026 comparison](https://devtoolpicks.com/blog/resend-vs-postmark-vs-mailgun-solo-developers-2026)):

- **Transactional API (Resend, Postmark, SendGrid)** — clearest winner for *send-only* MCPs. Single `Authorization: Bearer <key>` header, no OAuth, no token refresh, deliverability handled by the provider once the domain is verified. Resend and Postmark both ship official MCPs.
- **Gmail/Outlook OAuth** — required if you actually want inbox read/search/labels, but adds a desktop OAuth bootstrap, a refresh-token store, and Google Cloud Console setup. Every Gmail MCP (GongRzhe, shinzo-labs, ajbr0wn) takes essentially the same path: desktop OAuth client → JSON keys file → bootstrap CLI command → token cached at `~/.<server>/credentials.json`.
- **Raw IMAP+SMTP** — most flexible (works with any provider), but carries the deliverability burden, needs user/password or app-passwords, and historically the larger surfaces (`codefuturist/email-mcp` has 47 tools) are sprawling and fragile.

The **MCP spec itself** says stdio servers should *not* run an OAuth flow inside the protocol — they should pull credentials from environment ([modelcontextprotocol.io spec](https://modelcontextprotocol.io/specification/draft/basic/authorization)). This is why API-key transports dominate stdio MCP designs: they fit the spec model trivially.

---

## 3. Tool surface patterns

Three distinct shapes:

- **Send-only (transactional)** — the Postmark MCP is the canonical minimal: 4 tools (`send`, `send_with_template`, `list_templates`, `delivery_stats`). This pattern serves 80% of agent use cases.
- **Send + manage (Resend official)** — adds contacts, broadcasts, domains, webhooks, audiences, suppression. ~50 tools across 10 surfaces. This is "marketing-platform-as-MCP," not just send.
- **Full inbox (Gmail/IMAP)** — adds `read`, `search`, `list_labels`, `create_label`, `modify`, `batch_delete`, `create_filter`, `download_attachment`, draft + thread management. GongRzhe = 19, shinzo-labs = 60+. The bigger the tool count, the more LLM tool-selection noise the user pays for at every turn.

For a **personal-dev MCP** the send-only shape (4-7 tools) is overwhelmingly the right starting point. Postmark's official MCP exposes only 4 tools and is the cleanest reference design ([Postmark Labs blog](https://postmarkapp.com/blog/postmark-labs-teaching-ai-to-speak-email-with-our-new-mcp-server)).

---

## 4. Auth patterns

- **API key** (Resend, Postmark, SendGrid, Mailgun, AWS SES) — single env var, no flow, no refresh. Postmark uses `POSTMARK_SERVER_TOKEN`, Resend uses `RESEND_API_KEY`. Trivial to fit the smart-mcps `~/.config/smart-mcps/.env` pattern.
- **OAuth 2.0 desktop** (Gmail, Outlook) — every TS Gmail MCP uses essentially the same bootstrap:
  1. User creates a Google Cloud OAuth desktop client
  2. Downloads `gcp-oauth.keys.json` to `~/.gmail-mcp/`
  3. Runs `npx <pkg> auth` — opens browser, captures code via `http://localhost:3000/oauth2callback`
  4. Refresh token cached at `~/.gmail-mcp/credentials.json`, auto-refreshed thereafter
- **SMTP user/pass** — env vars `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`. Trivial but no per-account token rotation; works with app-passwords on Gmail/iCloud.

**MCP-specific gotcha** ([truefoundry MCP auth guide](https://www.truefoundry.com/blog/mcp-authentication-in-cursor-oauth-api-keys-and-secure-configuration), [google-gemini/gemini-cli #23296](https://github.com/google-gemini/gemini-cli/issues/23296)): a stdio MCP server is long-lived (lives for the whole client session, hours). OAuth refresh inside the process must happen lazily on each API call — caching tokens in memory is fine, but the refresh code path *must* run before every send, not only at startup. Multiple Gmail MCPs hit a real bug where `mcp list` worked but tool calls failed mid-session because refresh was only attempted on launch.

The cleanest Gmail OAuth bootstrap pattern in the wild is `npx @gongrzhe/server-gmail-autoauth-mcp auth` — a separate CLI subcommand that opens the browser and writes the refresh token to disk before the MCP server is ever launched. This matches the planned `gsc-smart-auth` CLI for `gsc-smart` exactly.

---

## 5. Resend vs Postmark vs SendGrid (opinionated, 2026)

Pricing & free tier ([buildmvpfast April 2026 pricing](https://www.buildmvpfast.com/api-costs/email), [Resend quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits), [Dreamlit alternatives](https://dreamlit.ai/blog/best-sendgrid-alternatives)):

| | Free tier | Paid entry | Deliverability | TS SDK | Delivery logs |
|---|---|---|---|---|---|
| **Resend** | 3,000/mo, 100/day, 1 domain | $20/mo → 50K | Good | Excellent (`resend@6.x`, native React Email) | Yes, 24h-3d retention on free |
| **Postmark** | 100/mo (Developer plan) | $15/mo → 10K | **Industry-leading >99% inbox** | OK | Best in class, 45-day |
| **SendGrid** | **None** (free tier killed) | $19.95/mo | Good but mixed reputation | OK, but heavy | Yes |

**Recommendation:** **Resend** wins for a personal-dev MCP today.
- Free tier is permanent, generous (3K/mo), and matches a solo dev's volume
- TS SDK is the cleanest of the three; types match the API 1:1
- `Authorization: Bearer <key>` API style fits `smart-mcp-core/http.ts` `fetchJson` exactly — no client wrapper needed beyond the typed body
- Already an official MCP exists (`resend/mcp-send-email`) to crib API shapes from
- Domain verification in dashboard is one-screen and DKIM/SPF/DMARC records auto-generate
- Pick Postmark only if deliverability is mission-critical (password resets, billing). Skip SendGrid — no free tier and the API is heavier than needed.

---

## 6. Gmail API MCP specifics

If/when a Gmail MCP is desired (separate from the transactional `email-smart`):

- **Scopes**: most servers request `https://www.googleapis.com/auth/gmail.modify` (read + send + label, no full account control) plus `https://www.googleapis.com/auth/gmail.settings.basic` for filter/label tools. `gmail.send` alone is too narrow for full inbox tools ([Google Gmail MCP config](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)).
- **Refresh token persistence**: every implementation writes the refresh token to `~/.<server>/credentials.json` (chmod 600). The access token lives in memory and is refreshed on demand by `googleapis` Node SDK.
- **Bootstrap CLI pattern**: `npx <pkg> auth` is the de-facto convention — `GongRzhe/Gmail-MCP-Server`, `shinzo-labs/gmail-mcp`, `tszaks/ghub` all do this. The CLI runs a one-shot Express server on `localhost:3000`, captures the OAuth code, exchanges for refresh token, writes to disk, exits. The MCP server itself never runs an OAuth flow. This is exactly the model the smart-mcps roadmap already plans for `gsc-smart-auth`.

---

## 7. Common pitfalls & gotchas

From [trysliq SPF/DKIM guide](https://www.trysliq.com/blog/email-deliverability-spf-dkim-dmarc), [egenconsulting 2026 checklist](https://www.egenconsulting.com/blog/email-deliverability-2026.html), [Resend reply-to issue #10361](https://github.com/payloadcms/payload/issues/10361), [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email):

- **Domain verification is non-negotiable in 2026.** Gmail and Microsoft now junk unauthenticated bulk mail by default. SPF + DKIM + DMARC must be set on the sending domain before the first send. Resend/Postmark both auto-generate the DNS records but the user must add them.
- **SPF DNS lookup limit (10).** Stacking multiple ESPs in a single SPF record hits PermError silently. The MCP should not assume a freshly-added domain is verified — surface verification status in a `verify_domain` tool.
- **DKIM 1024-bit keys are deprecated** — 2048-bit minimum in 2026.
- **Reply-To**: Resend takes `reply_to` as **array of strings**, not a single string. Common bug.
- **From address**: must be `Name <email@verified-domain.com>` with the domain verified in Resend. Free tier allows `onboarding@resend.dev` only — useful for testing, useless for real sends.
- **Threading**: Resend doesn't expose threading directly. To thread, set `headers: { "In-Reply-To": "<msgid>", "References": "<msgid>" }` manually.
- **Attachments**: Resend accepts base64 or remote URL. Hard cap of ~40MB combined per message.
- **Rate limits**: Resend free = 5 req/sec, 100 emails/day. Build a 429 retry into the client (smart-mcp-core `fetchJson` already does this).
- **HTML vs plaintext**: always send both. Spam filters penalize HTML-only messages.
- **Idempotency**: Resend supports `Idempotency-Key` header — worth exposing on `send_email` so retries don't double-send.

---

## Recommendation for smart-mcps

Build **`email-smart`** as a **Resend-only MCP**, single-purpose, send-focused. Justification:

1. **Provider: Resend.** Free tier is permanent and large enough for personal use. API key fits `~/.config/smart-mcps/.env` (`RESEND_API_KEY`) trivially, no OAuth, no refresh logic. TS SDK is cleanest of any email API.
2. **Transport: HTTPS via `smart-mcp-core/http.ts` `fetchJson`.** No `resend` npm SDK dependency — write a thin `RunpodClient`-style class. Resend's REST surface is small (`POST /emails`, `GET /emails/:id`, `POST /domains`, `GET /domains/:id/verify`). Matches the existing client pattern in `vercel-smart` and `runpod-smart` exactly.
3. **Tool surface (MVP, ~7 tools):**
   - `send_email` — to/cc/bcc/subject/html/text/reply_to/attachments/headers, `confirm` flag for destructive (it's not strictly destructive, but the user pays per send and the email is irreversible — guard with confirm by default for first-N-recipients > 1)
   - `get_email` — by ID, returns delivery state
   - `list_emails` — recent sends, slim shape
   - `cancel_email` — for scheduled sends
   - `list_domains` — read-only
   - `verify_domain` — checks SPF/DKIM/DMARC status, surfaces TXT records the user must add
   - `daily_status` — smart shortcut: today's send count, bounce count, recent failures (matches the `vercel-smart` and `runpod-smart` `daily_status` convention)
4. **Defer to phase 4+:** broadcasts, audiences, contacts, webhooks, segments, topics, batch_send. These exist in the official Resend MCP but are marketing-platform features, not transactional dev tooling, and inflate the LLM tool list with low-value entries.
5. **Skip Gmail/IMAP entirely for now.** Inbox tools are a separate product (call it `gmail-smart` later). Mixing inbound + outbound in one MCP is what made `codefuturist/email-mcp` 47 tools.
6. **Name it `email-smart`, not `resend-smart`.** Provider-agnostic name leaves room to add a Postmark fallback later via a creds-detection branch in `buildContext()` (mirrors how the credential file already mixes services). But the Phase 3 MVP is Resend-only.
7. **No bootstrap CLI needed** (unlike `gsc-smart-auth`). User pastes `RESEND_API_KEY` into `~/.config/smart-mcps/.env`, runs `./scripts/install-clients.sh email-smart`, restarts Claude Code, done.

This keeps `email-smart` scoped to ~5-7 tools, ~80-120 tests, builds in the same TDD pattern as `vercel-smart` / `runpod-smart`, and ships in one phase without needing OAuth infrastructure.

---

## Sources

- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)
- [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
- [TensorBlock awesome-mcp-servers communication category](https://github.com/TensorBlock/awesome-mcp-servers/blob/main/docs/communication--messaging.md)
- [resend/mcp-send-email](https://github.com/resend/mcp-send-email)
- [ActiveCampaign/postmark-mcp](https://github.com/ActiveCampaign/postmark-mcp)
- [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server)
- [shinzo-labs/gmail-mcp](https://github.com/shinzo-labs/gmail-mcp)
- [Garoth/sendgrid-mcp](https://github.com/Garoth/sendgrid-mcp)
- [codefuturist/email-mcp](https://github.com/codefuturist/email-mcp)
- [yunfeizhu/mcp-mail-server](https://github.com/yunfeizhu/mcp-mail-server)
- [samihalawa/mcp-server-smtp](https://github.com/samihalawa/mcp-server-smtp)
- [Postmark Labs MCP announcement](https://postmarkapp.com/blog/postmark-labs-teaching-ai-to-speak-email-with-our-new-mcp-server)
- [Resend pricing 2026](https://nuntly.com/resend-pricing) / [BuildMVPFast email API costs Apr 2026](https://www.buildmvpfast.com/api-costs/email)
- [Resend account quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits)
- [DevToolPicks Resend vs Postmark vs Mailgun 2026](https://devtoolpicks.com/blog/resend-vs-postmark-vs-mailgun-solo-developers-2026)
- [Dreamlit SendGrid alternatives 2026](https://dreamlit.ai/blog/best-sendgrid-alternatives)
- [Vibe Coder Resend vs SendGrid vs Postmark](https://blog.vibecoder.me/resend-vs-sendgrid-vs-postmark-email-services)
- [MCP authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [TrueFoundry MCP auth in Cursor 2026](https://www.truefoundry.com/blog/mcp-authentication-in-cursor-oauth-api-keys-and-secure-configuration)
- [google-gemini/gemini-cli OAuth refresh bug #23296](https://github.com/google-gemini/gemini-cli/issues/23296)
- [Google Gmail MCP server config](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)
- [TrySliq SPF/DKIM/DMARC fix guide](https://www.trysliq.com/blog/email-deliverability-spf-dkim-dmarc)
- [Egen Consulting deliverability 2026 checklist](https://www.egenconsulting.com/blog/email-deliverability-2026.html)
- [Resend send-email API reference](https://resend.com/docs/api-reference/emails/send-email)
- [Payload CMS reply_to bug #10361](https://github.com/payloadcms/payload/issues/10361)
