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
```

Per TZ §2.5: `enabled by default UNLESS explicitly set to "false"`. No key = effectively disabled.

## Что происходит при включении

1. **При входящем USER-сообщении** listener генерит candidate draft (наш pipeline: 21 принцип + KB + Match Engine)
2. **Перед отправкой** → POST `/api/agents/arthur/review` с draft + recentMessages + clientContext + Idempotency-Key
3. **Verdict от DNAI:**
   - `GO` → отправляем `review.text` через pendingSends (auto-fire 30s)
   - `TWEAK` → отправляем `review.text` (уже исправленный)
   - `NO-GO` → НЕ отправляем, notifyAdmin Роману, маркируем `facts.awaitingHumanSince`, autoReply=false
4. **Fallback at error**: если DNAI 5xx/timeout — отправляем НАШ draft (legacy flow), не блокируем юзера

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

Acceptance tests (8 штук per TZ §5):

```bash
DNAI_STUDIO_API_KEY=<key> npx tsx scripts/dnai-integration-test.ts
# Expected: 8/8 passed
```

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

- [x] DnaiStudioClient — `src/dnaiClient.ts`
- [x] Hook в обработке входящего — `src/listener.ts` (review middleware)
- [x] NO-GO handler — notifyAdmin + facts.awaitingHumanSince + autoReply=false
- [ ] memoryLoad hook в начале (TODO — добавить когда DNAI backend будет жив, чтобы можно было тестировать)
- [x] Idempotency-Key — `msg-<dialogId>-<lastUserMsgId>` (per-message dedup)
- [x] Feature flag — `DNAI_INTEGRATION_ENABLED`
- [x] Telemetry — console.log `[dnai-review] verdict=X runId=Y latencyMs=Z`
- [x] README — этот файл
- [ ] 8 интеграционных тестов прогон — нужен API key (script готов: `scripts/dnai-integration-test.ts`)
