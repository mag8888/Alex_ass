# Wave Match — Agent API

Read-only + draft-create API для внешних AI-агентов / помощников.

## Auth

Все эндпоинты требуют header:

```
X-API-Key: <key>
```

Ключ хранится в env `AGENT_API_KEY` на сервере. Без правильного ключа — `401 invalid api key`.

Без env вообще — `503 AGENT_API_KEY not configured on server`.

## Base URL

```
https://aiass-production.up.railway.app
```

## Endpoints

### `GET /agent/dialogs`

Список диалогов.

Query params:
- `status` — `ACTIVE` / `CLOSED` / etc (опционально)
- `limit` — макс 200 (default 50)
- `sinceHours` — фильтр по `updatedAt > now - N часов` (опционально)

Returns: `[ { id, stage, status, outcome, updatedAt, user: {...}, messageCount } ]`

### `GET /agent/dialogs/:id`

Полный диалог + сообщения + WM-профиль юзера.

Returns:
```json
{
  "id": 123,
  "stage": "QUALIFICATION",
  "status": "ACTIVE",
  "outcome": "IN_PROGRESS",
  "user": { ... },
  "wmProfile": { "id": "...", "firstName": "...", "profile": { "role": "...", "hobbies": [...] } },
  "messages": [ { "id", "sender", "status", "text", "createdAt" } ]
}
```

`sender`: `OPERATOR` (исходящие от бота/Романа) / `USER` (входящие от юзера) / `SIMULATOR` (драфты).

### `GET /agent/users/:id`

Детали юзера: `{ local: <UserRow>, wm: <WMUser|null> }`.

### `GET /agent/principles`

Контекст (наши правила) — ссылки на gpt.ts и memory.

### `POST /agent/draft`

Агент предлагает черновик ответа. Создаётся `DRAFT` в БД, Роману приходит DM с кнопками ✅/❌, через 10 мин авто-отправляется если ничего не нажато.

Body:
```json
{
  "dialogueId": 123,
  "text": "Текст предлагаемого ответа",
  "reasoning": "(опционально) почему именно такой ответ"
}
```

Returns: `{ success: true, draftId: <id>, willAutoSendIn: '10min...' }`

## Принципы (must-follow для агента)

См. `src/gpt.ts` на main + `.claude/.../memory/` (локально). Ключевые:

1. **Всегда «Вы»** — никогда «ты» без явного разрешения юзера
2. **Никаких фейковых данных** — не выдумывай примеры карточек, цены, имена. Если не знаешь — `null` text → silent escalation
3. **Brevity** — 1-3 предложения максимум, один action per turn (ответ ИЛИ вопрос ИЛИ предложение)
4. **No mirror** — не повторять контент юзера дословно
5. **Партнёрство/тариф** → «Давайте Zoom с сооснователем» (не цитировать цены)
6. **Self-description** — «Ассистент команды Wave Match», никогда «бот» / «AI» / «сервисный аккаунт»

## Примеры

### Получить активные диалоги за последний час

```bash
curl -H "X-API-Key: <KEY>" \
  "https://aiass-production.up.railway.app/agent/dialogs?status=ACTIVE&sinceHours=1&limit=20"
```

### Прочитать диалог 256

```bash
curl -H "X-API-Key: <KEY>" \
  "https://aiass-production.up.railway.app/agent/dialogs/256"
```

### Предложить draft в диалог 256

```bash
curl -X POST -H "X-API-Key: <KEY>" -H "Content-Type: application/json" \
  -d '{"dialogueId":256,"text":"Принято. Какая ниша Вашего бизнеса?"}' \
  https://aiass-production.up.railway.app/agent/draft
```

## Rate limiting

Сейчас не настроено. Если агент делает >100 RPS — Railway может ограничить.

## Версионирование

API под текущей версией не версионируется (v1). Breaking changes будут анонсированы заранее.
