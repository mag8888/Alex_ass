# Integration Status — Wave Match × Wave Chat

> Living document. Both teams update this whenever something meaningful changes.
> Order of sections: **Working** → **In progress** → **Blocked** → **Recently changed** (timeline).
>
> **Owners:** Wave Chat: `@roman_arctur`. Wave Match: _(нужен контакт от их стороны)_

---

## Working ✅

### Contract & docs
- [`docs/contract/openapi.yaml`](./contract/openapi.yaml) — OpenAPI 3.1 spec, valid, version `1.1.2` covering 7 endpoints + 6 webhook events
- [`docs/contract/README.md`](./contract/README.md) — workflow rules + versioning policy
- [`docs/contract/examples/`](./contract/examples/) — 8 real JSON payloads
- [`docs/WAVEMATCH_API_TZ.md`](./WAVEMATCH_API_TZ.md) — full architectural TZ (10 sections)
- [`docs/WM_HANDOFF_RUNBOOK.md`](./WM_HANDOFF_RUNBOOK.md) — short action runbook for WM team

### Wave Match side (per their last update)
- ✅ Schema migration `20260429_add_wavematch_integration` deployed
- ✅ Bearer auth (`wmAuth` middleware), scope hierarchy, audit log
- ✅ HMAC-SHA256 webhook signing (`X-WC-Signature` + `X-WC-Timestamp`)
- ✅ 6 endpoints under `/api/wm/*`
- ✅ Background webhook delivery worker (1m → 5m → 30m → 2h → 6h → 24h backoff)
- ✅ CLI to issue API keys (`wm-issue-key.js`)
- ✅ Webhook subscription registered: id `5576edeb-fd23-49f8-b8de-da21d55e939f` since 2026-04-29 08:32 UTC, `failureCount=0`

### Wave Chat side (this repo) — ALIGNED v1.2.0
- ✅ Canon `docs/contract/openapi.yaml@1.2.0` — reality-aligned (mirrors deployed `apps/api/routes/wm.js`)
- ✅ Generated typed client from spec (`src/wm/types.gen.ts` via `openapi-typescript`)
- ✅ `src/wmClient.ts` — uses `tg:<id>` lookup, no `/by-telegram` endpoint, slim `UserListItem` for list, `WritableUserFields` for PATCH
- ✅ `POST /webhooks/wm` — HMAC verify (timestamp in **seconds**), anti-replay 300s, idempotency by `X-WC-Delivery` (UUID)
- ✅ Webhook handler parses Wave Match envelope: `{event, deliveryId, createdAt, data}` with wrapped `data.user` for user.* events
- ✅ Listener: pulls WM profile, absorbs role/industry/location/hobbies into local fields, never tries to PATCH non-existent profile.* in WM
- ✅ CRM notes use `kind=system` + `[ai_*]` prefix in `body` + label-tags (matches deployed contract)
- ✅ `addCrmTag(userId, 'ai-profiling' | 'ai-qualified')` — soft signal to WM about AI-touched users (uses real PATCH endpoint with crmTags writable field)
- ✅ Welcome flow (7-min delay after `user.created`)
- ✅ Env aliases: `WAVE_CONNECT_*` and legacy `WM_*` both supported
- ✅ End-to-end signed webhook test passes — `200 OK` on first try

### Production env (Wave Chat → Railway `AI_ASS` service)
- ✅ `WAVE_CONNECT_BASE_URL` set
- ✅ `WAVE_CONNECT_API_TOKEN` set
- ✅ `WAVE_CONNECT_WEBHOOK_SECRET` set
- ✅ `WAVE_CONNECT_WEBHOOK_REPLAY_WINDOW=300`
- ✅ `ADMIN_USERNAME=roman_arctur`

---

## In progress 🟡

| Item | Side | What's left |
|------|------|-------------|
| **Real e2e** with Telegram-linked test user | WM | Create test user with real `telegramId` so we can verify welcome flow + reply → profile sync |
| **`subscription.changed` emitter on payments** | WM | Stub event handler exists on WC side, awaits real payload |
| **Phase 3 from WM TZ §5** | WM | Encryption `WebhookSubscription.secretEnc` at rest, `DELETE /api/wm/users/:id` (GDPR Art.17), webhooks status dashboard in `/admin` |

---

## Blocked / Needs from other side 🔴

_Currently nothing actively blocking — both sides moving in parallel._

Open coordination questions (not blocking, but should be answered):
- [ ] Who on the WM side is the integration counterpart (TG handle / email)?
- [ ] Does WM have a staging environment so we can test breaking changes there first?
- [ ] When will the first real `user.created` with a TG ID land?
- [ ] Plan for rotating `WAVE_CONNECT_API_TOKEN` and `WAVE_CONNECT_WEBHOOK_SECRET` after first stable e2e (both leaked into Telegram chat history during setup).

---

## Recently changed 📝

> Newest first. Format: `YYYY-MM-DD HH:MM UTC — [side] short summary (PR #N)`

- `2026-04-29 ~13:00 UTC` — **WC**: ALIGNMENT v1.2.0 — canon, types, wmClient, webhook handler, listener, server, runbook all aligned to deployed Wave Match per `WAVE_CHAT_ALIGNMENT_TZ.md`. Breaking changes: User schema, PATCH body (`WritableUserFields`), CRM notes `kind+body`, webhook envelope `deliveryId+createdAt+wrapped data`, `tg:<id>` lookup instead of `/by-telegram`.
- `2026-04-29 ~12:00 UTC` — **WC**: typed client generated from spec, `npm run gen:wm-types` script (PR #15)
- `2026-04-29 ~11:55 UTC` — **WC**: `docs/contract/` published as canonical OpenAPI source-of-truth (PR #14)
- `2026-04-29 ~11:50 UTC` — **WC**: admin's own messages now markAsRead before skipping — heartbeat ping works (PR #12)
- `2026-04-29 ~11:30 UTC` — **WC**: form-encoded parser, 415 path log, `ADMIN_USERNAME` env corrected on Railway, auto-unreject admin on boot (PR #11)
- `2026-04-29 ~11:10 UTC` — **WC**: fix HMAC timestamp comparison — Unix seconds, not ms (PR #10) — webhook receiver now accepts signed events
- `2026-04-29 09:50 UTC` — **WC**: support `WAVE_CONNECT_*` env naming alongside `WM_*` (PR #8)
- `2026-04-29 09:30 UTC` — **WC**: typed Wave Match integration shipped — wmClient + webhookHandler + `/webhooks/wm` + listener sync (PR #7)
- `2026-04-29 ~09:00 UTC` — **WM**: subscription registered, ID `5576edeb-...`, first PATCH `user.updated` delivered with HTTP 200 first-try
- `2026-04-29 ~08:30 UTC` — **WM**: PR #3 deployed — 6 endpoints + HMAC + retry worker + CLI for keys
- `2026-04-29 ~08:00 UTC` — **WC**: full project cleanup — Puppeteer-era code removed, deps trimmed 600 → 218 packages (PR #2)
- `2026-04-29 ~07:30 UTC` — **WC**: real-time admin panel shipped — auto-mode, scripted onboarding, Claude API, voice (Whisper), match engine, broadcast (PR #1)

---

## How to update this file

When you ship something integration-related on either side, edit this file in the same PR:

1. Move the item from **In progress** to **Working** (or vice versa)
2. Add a single bullet to **Recently changed** at the top of the timeline
3. Clear the **Blocked** section if your work unblocks anything

Don't try to keep the timeline pristine — append-only is fine. Quarterly trim to keep it readable.
