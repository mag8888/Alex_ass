# DNAI Studio Integration

Гибридная архитектура согласно `TZ-aiass-team.md`:
- **aiass-production** = execution layer (listener / Conversation Brain / KB / Match / pendingSends)
- **DNAI Studio** = control layer (review-chain Артур→Марк→Аида, project_memory)

## Активация на проде

Add Railway env vars (AI_ASS service → Variables):

```
DNAI_STUDIO_API_KEY=<64-hex-key-from-Roman>
DNAI_BASE_URL=https://dnai.up.railway.app   # уже default
DNAI_INTEGRATION_ENABLED=true                # по умолчанию ENABLED если есть key
DNAI_REVIEW_MODE=fallback                    # v2.0: fallback | strict (default fallback)
DNAI_STUDIO_TIMEOUT_MS=35000                 # default 35s per TZ
DNAI_ROLLOUT_PCT=100                         # 0-100 — % входящих, идущих через review (canary)
```

Per TZ §2.5: `enabled by default UNLESS explicitly set to "false"`. No key = effectively disabled.

### v2.0 — режимы review

- **`fallback`** (default per SETUP-aiass-final.md): если Anthropic вылетает (429 / 5xx / timeout), DNAI возвращает `verdict='GO_FALLBACK'` с нашим draft as-is — продолжаем работать автономно, юзер не блокируется.
- **`strict`**: при ошибке Anthropic DNAI возвращает 5xx — мы падаем в legacy flow (тоже отправляем наш draft, но без отметки fallback).

## Что происходит при включении

1. **При входящем USER-сообщении** listener генерит candidate draft (наш pipeline: 21 принцип + KB + Match Engine)
2. **Перед отправкой** → POST `/api/agents/arthur/review` с draft + recentMessages + clientContext + Idempotency-Key
3. **Verdict от DNAI:**
   - `GO` → отправляем `review.text` через pendingSends (auto-fire 30s)
   - `TWEAK` → отправляем `review.text` (уже исправленный)
   - `NO-GO` → НЕ отправляем, notifyAdmin Роману, маркируем `facts.awaitingHumanSince`, autoReply=false
   - `GO_FALLBACK` (v2.0) → DNAI side не смог завершить chain (Anthropic 429 / timeout) → `review.text` = наш draft as-is, отправляем как обычно. В логе помечаем `fallback=true`
4. **Fallback at error**: если DNAI сам 5xx/timeout/network — отправляем НАШ draft (legacy flow), не блокируем юзера

## Что отключить если что

```
DNAI_INTEGRATION_ENABLED=false
```

→ перезапуск Railway service → старый pipeline без DNAI review.

## Smoke test

После добавления env:

```bash
# Подтверждение что наш AI_ASS видит DNAI:
curl https://aiass-production.up.railway.app/admin/dnai/smoke | jq .

# Должно вернуть:
# {
#   "keyConfigured": true,
#   "ping":         { "ok": true,  ... },
#   "memoryProjects": { "ok": true, ... },
#   "memoryLoad":   { "ok": true,  ... },
#   "review":       { "ok": true, ... }
# }
```

Acceptance tests (9 штук per TZ §5 + v2.0 skipReviewChain):

```bash
DNAI_STUDIO_API_KEY=<key> npx tsx scripts/dnai-integration-test.ts
# Expected: 9/9 passed
```

Тест №9 проверяет v2.0 `skipReviewChain: true` — мгновенный возврат `GO_FALLBACK` (<2s) без обращения к Anthropic. Полезно для канарейки и health-probe.

## Endpoint shipping summary (наша сторона)

Public health (без auth) для probes DNAI:
- `GET /agent/health` → `{status, version, uptime, serverTime}`
- `GET /agent/integration-status` → `{enabled, fallbackMode, dnaiKeyConfigured, dnaiBaseUrl}`

Admin (без auth, behind URL):
- `GET /admin/dnai/smoke` → результат 4 capabilities (ping / memory-projects / memory-load / review)

Agent API (с `X-API-Key`, для других AI-агентов):
- `GET /agent/dialogs` / `GET /agent/dialogs/:id` / `GET /agent/users/:id` / `GET /agent/principles` / `POST /agent/draft`

## NO-GO handling

Когда review возвращает `NO-GO`:

1. **НЕ** отправляем `gptResult.reply` пользователю
2. `notifyAdmin` (DM в @Mag_88888888 → @roman_arctur) с шаблоном:
   ```
   🛑 NO-GO от Аиды (@username, d=<dialogueId>)
   Причина: <reason>
   Эскалация: @roman_arctur
   runId: <runId>
   Наш draft (НЕ отправлен): «<first 200 chars>»
   ```
3. `user.facts.awaitingHumanSince = now()`
4. `user.autoReply = false` — дальнейшие сообщения этого юзера не идут через автоответчик до явного включения

## Memory load / save (двусторонняя синхронизация)

Сейчас в listener `memoryLoad` НЕ вызывается перед каждым draft (для скорости). Если нужно — добавить hook:

```typescript
const topic = detectTopic(userText);  // moneo-game / alma-product / wm-rules / null
if (topic) {
    const mem = await memoryLoad('arthur', topic);
    // inject mem.items into gpt.ts kbItems
}
```

`memorySave` вызывается из Conversation Brain (LearnedScenario auto-mining) когда обнаружен новый паттерн — раз в день.

## Metrics target (per TZ §7)

| Метрика | Цель |
|---|---|
| Success rate `/review` | > 99% |
| p95 latency `/review` | < 30s |
| % NO-GO от всех verdicts | < 5% |
| % TWEAK от всех verdicts | 20-40% |
| % сообщений через интеграцию | > 95% |
| memorySave updates | 1-3/неделю |

Sync-call раз в неделю — сравниваем графики.

## Деливераблы (per TZ §1)

- [x] DnaiStudioClient — `src/dnaiClient.ts` (v2.0: `mode`, `GO_FALLBACK`, `runId: string|null`)
- [x] Hook в обработке входящего — `src/listener.ts` (review middleware с `mode: 'fallback'`)
- [x] NO-GO handler — notifyAdmin + facts.awaitingHumanSince + autoReply=false
- [x] GO_FALLBACK handler (v2.0) — log `fallback=true`, отправляем `review.text` (= наш draft)
- [x] memoryLoad hook в начале диалога — `detectTopic(userText)` + inject в gpt.ts kbItems
- [x] Idempotency-Key — `msg-<dialogId>-<lastUserMsgId>` (per-message dedup)
- [x] Feature flag — `DNAI_INTEGRATION_ENABLED`
- [x] Rollout gate — `DNAI_ROLLOUT_PCT` (0-100, canary)
- [x] Telemetry — console.log `[dnai-review] verdict=X runId=Y latencyMs=Z fallback=B`
- [x] README — этот файл
- [x] 9 интеграционных тестов — `scripts/dnai-integration-test.ts` (нужен API key для прогона)
- [x] Humanlike timing — fast/slow mode (75/25), markAsRead ≤1min до send (per Roman 2026-05-13)
