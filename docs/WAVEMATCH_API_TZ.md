# ТЗ: Wave Match ↔ Wave Chat (AI-ассистент)

**Версия:** 1.1
**Аудитория:** команда разработки Wave Match
**Цель:** определить контракт между Wave Match (WM) и Wave Chat (WC, AI-ассистент в Telegram), чтобы бот мог вести нативные диалоги с клиентами без ручной перезаливки данных.

---

## §1. Архитектура

```
┌─────────────────────┐                          ┌──────────────────────┐
│                     │   1. REST pull (read)    │                      │
│     Wave Chat       │ ────────────────────────►│     Wave Match       │
│   (Telegram bot)    │   GET /api/wm/users/...  │   (платформа, CRM)   │
│                     │                          │                      │
│                     │   2. REST push (write)   │                      │
│                     │ ────────────────────────►│                      │
│                     │   PATCH /api/wm/users/:id│                      │
│                     │   POST  /notes           │                      │
│                     │                          │                      │
│                     │   3. Webhooks (events)   │                      │
│                     │ ◄────────────────────────│                      │
│                     │   POST /webhooks/wm      │                      │
└─────────────────────┘                          └──────────────────────┘
```

**Контур безопасности:**
- Все запросы по HTTPS
- WC → WM: `Authorization: Bearer <SERVICE_TOKEN>` (длительный сервисный токен)
- WM → WC (webhooks): подпись `X-WM-Signature: sha256=<hmac>` от тела + `WEBHOOK_SECRET`
- ETag/If-Match для PATCH — защита от race-conditions при одновременной правке
- Все PII (email, phone) **не логируются** на стороне WC

**SLA / производительность:**
| Endpoint | Ожидаемая нагрузка | Latency p95 |
|----------|---------------------|-------------|
| `GET /users/:id` | до 50 RPS (входящие сообщения) | < 200 ms |
| `GET /users` | до 1 RPS (рассылки) | < 1 s |
| `PATCH /users/:id` | до 10 RPS | < 300 ms |
| Webhook delivery | гарантия + retry × 3 экспоненциально | — |

---

## §2. Endpoints

### 2.1. `GET /api/wm/users/:id`

Полный профиль пользователя со слоями (`include`-параметр).

**Request:**
```
GET /api/wm/users/wm_user_a1b2c3?include=profile,clubs,subscription,stats
Header: Authorization: Bearer <SERVICE_TOKEN>
```

**Параметры:**
| Параметр | Тип | Default | Описание |
|----------|-----|---------|----------|
| `include` | csv | `profile` | Какие слои подгрузить: `profile`, `clubs`, `subscription`, `stats`, `notes` |
| `byTelegramId` | string | — | Альтернативный lookup по TG ID вместо WM ID |
| `byUsername` | string | — | Альтернативный lookup по @username |

**Response 200:**
```json
{
  "id": "wm_user_a1b2c3",
  "telegramId": "123456789",
  "username": "ivan_petrov",
  "firstName": "Иван",
  "lastName": "Петров",
  "gender": "MALE",
  "phone": "+79991234567",
  "email": "ivan@example.com",
  "locale": "ru",
  "registeredAt": "2024-09-12T14:23:00Z",
  "lastActiveAt": "2025-04-25T10:14:00Z",
  "etag": "W/\"42-abc123\"",

  "profile": {
    "city": "Москва",
    "activity": "Маркетинг и реклама",
    "businessCard": "Помогаю...",
    "bestClients": "...",
    "requests": "Ищу клиентов в B2B",
    "hobbies": "Путешествия",
    "currentIncome": "500к-1М",
    "desiredIncome": "1М-3М",
    "networkingGoal": "Найти 3 партнёров до конца квартала",
    "tags": ["b2b", "marketing"]
  },

  "clubs": [
    { "slug": "b2b-pro", "joinedAt": "2024-10-01T...", "role": "MEMBER" },
    { "slug": "moscow", "joinedAt": "2024-09-15T...", "role": "MEMBER" }
  ],

  "subscription": {
    "tier": "PRO",
    "status": "ACTIVE",
    "currentPeriodStart": "2025-04-01T00:00:00Z",
    "currentPeriodEnd": "2025-05-01T00:00:00Z",
    "marketingOptIn": true
  },

  "stats": {
    "lifetimeValue": 47800,
    "matchesCount": 12,
    "lastMatchAt": "2025-04-20T..."
  }
}
```

**Response 404** если юзера нет.

**Поведение WC:** при первом сообщении в Telegram бот вызывает endpoint, кэширует на 10 минут (по ETag — обновляет когда изменился). Поля из `profile` определяют **что уже заполнено** — бот не задаёт повторных вопросов.

---

### 2.2. `PATCH /api/wm/users/:id`

Изменение "мягких" полей профиля. ETag обязателен для concurrency control.

**Request:**
```
PATCH /api/wm/users/wm_user_a1b2c3
Header: Authorization: Bearer <SERVICE_TOKEN>
Header: If-Match: W/"42-abc123"
Body: {
  "profile": {
    "city": "Санкт-Петербург",
    "activity": "FinTech",
    "tags": ["b2b", "fintech"]
  }
}
```

**Дозволенные к изменению поля:**
- `profile.city`, `profile.activity`, `profile.businessCard`,
  `profile.bestClients`, `profile.requests`, `profile.hobbies`,
  `profile.currentIncome`, `profile.desiredIncome`,
  `profile.networkingGoal`, `profile.tags`
- `gender` — только если в WM `null` (auto-detect от WC)

**Запрещено**: phone, email, subscription, registeredAt, clubs (управляется только из WM)

**Response 200:** `{ "ok": true, "updatedFields": ["city", "activity"], "etag": "W/\"43-def456\"" }`
**Response 412:** `Precondition Failed` — ETag устарел, WC должен заново прочитать профиль

---

### 2.3. `GET /api/wm/users` (список с фильтрами)

Используется в Broadcast-фиче — выбираем сегмент базы для рассылки.

**Request:**
```
GET /api/wm/users
  ?subscriptionTier=PRO
  &clubSlug=b2b-pro
  &marketingOptIn=true
  &lastActiveAfter=2025-03-01T00:00:00Z
  &hasEmail=true
  &locale=ru
  &page=1
  &pageSize=200
```

**Параметры:**
| Параметр | Тип | Описание |
|----------|-----|----------|
| `subscriptionTier` | enum | `FREE` / `PRO` / `PREMIUM` |
| `subscriptionStatus` | enum | `ACTIVE` / `PAUSED` / `CANCELLED` |
| `clubSlug` | string | Член указанного клуба |
| `marketingOptIn` | bool | Согласие на рассылки (GDPR/CCPA) |
| `lastActiveAfter` / `lastActiveBefore` | ISO date | Окно активности |
| `hasEmail` / `hasTelegram` | bool | Доступные каналы связи |
| `locale` | string | `ru` / `en` |
| `minProfileCompleteness` | float 0..1 | Порог заполненности профиля |
| `page` | int | Страница (от 1) |
| `pageSize` | int | До 500 |

**Response 200:**
```json
{
  "total": 1234,
  "page": 1,
  "pageSize": 200,
  "items": [/* как §2.1 без `clubs/stats` */]
}
```

---

### 2.4. `POST /api/wm/users/:id/notes`

CRM-заметка о значимом событии в диалоге (квалификация, матч, отказ, закрытие).

**Request:**
```
POST /api/wm/users/wm_user_a1b2c3/notes
Body: {
  "type": "ai_dialog",
  "summary": "Уточнили: ищет клиентов в B2B fintech, бюджет 200к/мес",
  "tags": ["b2b", "fintech", "ready-to-buy"],
  "linkedDialogId": "tg_dialog_99"
}
```

**Типы событий (`type`):**
- `ai_dialog` — общая заметка из диалога
- `ai_qualification_done` — профиль заполнен на нужный уровень
- `ai_match_proposed` — ассистент предложил матч
- `ai_match_accepted` / `ai_match_rejected` — реакция на матч
- `ai_churn_signal` — сигналы оттока ("больше не нужно", негативная реакция)

**Response 201:** `{ "id": "note_xy", "createdAt": "..." }`

---

### 2.5. `GET /api/wm/users/:id/notes`

История заметок для контекста при открытии диалога оператором.

```
GET /api/wm/users/wm_user_a1b2c3/notes?limit=20&type=ai_dialog,ai_match_proposed
```

**Response 200:** массив заметок отсортированных по `createdAt DESC`.

---

### 2.6. `POST/GET/DELETE /api/wm/webhooks` (subscriptions)

WC регистрирует свой URL, чтобы получать события от WM.

**`POST /api/wm/webhooks`** — подписаться:
```json
{
  "url": "https://aiass-production.up.railway.app/webhooks/wm",
  "events": [
    "user.created", "user.updated",
    "profile.updated",
    "club.joined", "club.left",
    "subscription.changed"
  ],
  "secret": "<32-byte hex>"
}
```

**`GET /api/wm/webhooks`** — посмотреть текущие подписки.

**`DELETE /api/wm/webhooks/:id`** — отписаться.

### 2.6.1. Доставка events (WM → WC)

```
POST https://aiass-production.up.railway.app/webhooks/wm
Header: X-WM-Signature: sha256=<hmac of body using shared secret>
Header: X-WM-Event-Id: evt_a1b2c3 (для дедупликации)
Body: {
  "event": "user.created",
  "occurredAt": "2025-04-29T08:14:00Z",
  "data": { /* event-specific payload */ }
}
```

**6 событий и реакция WC:**

| Event | Payload | Что делает WC |
|-------|---------|---------------|
| `user.created` | `{ userId, telegramId, locale }` | Через 5-10 мин welcome-сообщение в Telegram (если есть TG) |
| `user.updated` | `{ userId, changedFields[] }` | Инвалидирует кэш профиля |
| `profile.updated` | `{ userId, fields }` | Перечитывает профиль, использует свежие данные в следующем диалоге |
| `club.joined` | `{ userId, clubSlug }` | Если клуб релевантный — запускает scenario с упоминанием клуба |
| `club.left` | `{ userId, clubSlug }` | Логирует, не пишет |
| `subscription.changed` | `{ userId, oldTier, newTier, status }` | На upgrade — поздравляет; на cancellation — soft check-in |

WC отвечает `200 OK` за < 5 сек. Если ошибка — WM ретраит exponentially x3.

---

## §3. Field mapping (22 поля)

| # | Wave Chat (Prisma)                | Wave Match path             | Source-of-truth | Direction |
|---|-----------------------------------|------------------------------|-----------------|-----------|
| 1 | `User.telegramId`                 | `telegramId`                 | WM              | WM → WC |
| 2 | `User.username`                   | `username`                   | WM              | WM → WC |
| 3 | `User.firstName`                  | `firstName`                  | WM              | WM → WC |
| 4 | `User.lastName`                   | `lastName`                   | WM              | WM → WC |
| 5 | `User.gender`                     | `gender`                     | WC (auto-detect) если в WM null, иначе WM | WM ⇄ WC |
| 6 | `User.bio`                        | `profile.bio` (если есть)    | WM              | WM ⇄ WC |
| 7 | `User.city`                       | `profile.city`               | WM              | WM ⇄ WC |
| 8 | `User.activity`                   | `profile.activity`           | WM              | WM ⇄ WC |
| 9 | `User.businessCard`               | `profile.businessCard`       | WM              | WM ⇄ WC |
|10 | `User.bestClients`                | `profile.bestClients`        | WM              | WM ⇄ WC |
|11 | `User.requests`                   | `profile.requests`           | WM              | WM ⇄ WC |
|12 | `User.hobbies`                    | `profile.hobbies`            | WM              | WM ⇄ WC |
|13 | `User.currentIncome`              | `profile.currentIncome`      | WM              | WM ⇄ WC |
|14 | `User.desiredIncome`              | `profile.desiredIncome`      | WM              | WM ⇄ WC |
|15 | `User.networkingGoal`             | `profile.networkingGoal`     | WM              | WM ⇄ WC |
|16 | `User.tags` (JSON)                | `profile.tags[]`             | WM              | WM ⇄ WC |
|17 | `User.revenue`                    | `stats.lifetimeValue`        | WM              | WM → WC |
|18 | `User.status` (NEW/CHAT/LEAD/...) | computed from `subscription.tier` + WC dialog stage | mixed | bidirectional via events |
|19 | `User.autoReply`                  | (только в WC)                | WC              | local |
|20 | `User.lastBroadcastAt`            | (только в WC)                | WC              | local |
|21 | `Dialogue.stage`                  | (только в WC)                | WC              | local |
|22 | `Message.text` (история)          | (только в WC)                | WC              | local; экспорт через `POST /notes` |

**Правило конфликтов:**
- Если значение есть и в WM и в WC, побеждает **WM** (он source-of-truth)
- WC обновляет в WM немедленно, как только узнает что-то новое из диалога: `PATCH /users/:id`
- Local-only поля (статусы диалогов, авто-режим, история сообщений) хранятся ТОЛЬКО в WC

---

## §4. Auto-detect gender по имени

WC делает локальный детект по `firstName` (Russian heuristic: exact lists + suffix rules). Поле в Prisma: `User.gender = MALE | FEMALE | UNKNOWN`.

**Логика синхронизации:**
1. WC получает юзера от WM. Если `gender = null` в WM — запускает auto-detect.
2. Если результат ≠ `UNKNOWN` — `PATCH /users/:id { gender: "MALE" }`.
3. WM помечает поле флагом `genderAutoDetected: true`, чтобы юзер мог исправить в кабинете.

---

## §5. Логика "что не хватает" в диалоге

```
on incoming message from user U:
    profile = WM.getUser(U.telegramId, include=profile).profile  # cached 10 min
    history = local.messages(dialogId, limit=10)

    # Список незаполненных полей профиля
    missing = PROFILE_FIELDS.filter(f => !profile[f] || profile[f] === '')

    # Бот НЕ задаёт вопросы по уже заполненным полям. Использует их в фразах.
    # Бот задаёт МАКСИМУМ 1 вопрос за сообщение. По текущему критическому missing.
    # При длинном ответе (особенно voice transcript) — экстракт всех полей сразу.

    reply, extracted = GPT.generate(history, profile, missing[0])
    if extracted: WM.PATCH(U.id, profile=extracted)
```

---

## §6. План внедрения по этапам

### Этап 1 — read-only (1-2 недели)
- 2.1 (`GET /users/:id`)
- 2.3 (`GET /users`) с фильтрами для рассылок
- 2.6 webhook на `user.created`

→ WC видит профили, делает welcome-рассылки, уточняет недостающее в диалоге.

### Этап 2 — bidirectional (1 неделя)
- 2.2 (`PATCH /users/:id`) с ETag
- 2.4 (`POST /notes`) для CRM-истории
- Webhooks: `user.updated`, `profile.updated`, `subscription.changed`

→ Всё, что WC собирает в диалоге, оседает в WM. Менеджеры WM видят CRM-историю и метки.

### Этап 3 — расширенная синхронизация (по необходимости)
- Webhooks `club.joined/left` для club-aware сценариев
- 2.5 (`GET /notes`) для отображения истории в WC-админке
- Dual-channel рассылка: если у юзера нет TG, отправлять в email через WM

---

## §7. Безопасность и приватность

- **HTTPS only.** `http://` отклоняется на уровне gateway.
- **Service token** не логируется (мaскируется как `Bearer ***`).
- **Webhook signature** проверяется на стороне WC; невалидные — `401`.
- **Idempotency.** Каждый webhook event имеет `eventId`, WC хранит последние 1000 ID.
- **PII isolation.** Email, phone — НЕ попадают в логи AI-ассистента, не передаются в GPT-prompt.
- **GDPR/CCPA endpoint:** `DELETE /api/wm/users/:id/ai-dialogs` — стирает в WC всю историю для юзера; WC обязан реагировать в течение 24ч.
- **Marketing opt-in.** Broadcast-фича читает `subscription.marketingOptIn` и фильтрует автоматически — не пишем тем, кто запретил рассылки.

---

## §8. End-to-end тестовый сценарий

1. Тестовый юзер регистрируется на Wave Match.
2. WM шлёт webhook `user.created` → WC.
3. WC через 5 минут пишет в Telegram welcome-сообщение в стиле scenario `wm_reactivation_general`.
4. Юзер отвечает голосовым: "Привет! Я в маркетинге. Ищу клиентов в B2B".
5. WC транскрибирует через Whisper, извлекает `activity = "Маркетинг"`, `requests = "клиенты в B2B"`.
6. WC шлёт `PATCH /users/:id { profile: { activity: "Маркетинг", requests: "клиенты в B2B" } }`.
7. На сайте Wave Match в кабинете юзера обновляются поля.
8. WC шлёт `POST /notes { type: "ai_qualification_done", summary: "Маркетолог, ищет B2B клиентов" }`.
9. Через час Match-Engine WC находит совпадение — создаёт интро-черновик.
10. WC после отправки интро шлёт `POST /notes { type: "ai_match_proposed", linkedDialogId: ... }`.

---

## §9. Открытые вопросы / на согласование

- [ ] Используется ли в WM email-канал параллельно? Если да — добавить флаг `User.preferredChannel`.
- [ ] Есть ли в WM понятие "корпоративных" аккаунтов (несколько TG привязаны к одному WM-аккаунту)?
- [ ] Структура `clubs` — есть ли там "тематика клуба" чтобы WC мог использовать в matching score?
- [ ] Нужна ли двойная аутентификация для критичных операций (например `DELETE /ai-dialogs`) — отдельный admin token?
- [ ] Соглашение по rate limits: 429 + `Retry-After` или WM делает мягкий throttling?

---

---

## §10. Что передать команде Wave Chat для запуска интеграции

После того как Wave Match выкатил API, нам (Wave Chat) нужно три значения, чтобы включить интеграцию. Их кладём в Railway → Variables:

| Env переменная | Что | Откуда взять |
|----------------|-----|--------------|
| `WM_API_BASE_URL` | Базовый URL Wave Match API | например `https://api.wavematch.com` |
| `WM_API_TOKEN` | Bearer-токен для нашего сервиса | сгенерировать на стороне WM: `node apps/api/scripts/wm-issue-key.js wave-chat-prod write` — **показать токен ровно один раз** |
| `WM_WEBHOOK_SECRET` | HMAC-секрет для подписи webhook'ов | случайные 32 байта (`openssl rand -hex 32`); тот же секрет передать в WM при подписке через `POST /api/wm/webhooks` |

**Опциональные:**
| Env | Default | Что |
|-----|---------|------|
| `WM_TIMEOUT_MS` | 5000 | Таймаут на каждый запрос к WM |
| `WM_CACHE_TTL_MS` | 600000 | TTL кэша профиля (10 мин) |
| `WM_WELCOME_DELAY_MS` | 420000 | Задержка перед welcome-сообщением (7 мин) |

**Пуш-URL для webhook'а** (Wave Match шлёт сюда события):
```
https://aiass-production.up.railway.app/webhooks/wm
```
Подписка делается одним запросом со стороны WM:
```http
POST /api/wm/webhooks
{
  "url": "https://aiass-production.up.railway.app/webhooks/wm",
  "events": ["user.created", "user.updated", "profile.updated", "club.joined", "club.left", "subscription.changed"],
  "secret": "<тот же WM_WEBHOOK_SECRET>"
}
```

После этих 3 шагов интеграция работает: сразу же на `user.created` бот пишет welcome через 7 мин, а на каждое входящее в Telegram — подгружает профиль из Wave Match (с 10-мин кешем) и обновляет его обратно через PATCH когда узнаёт новые поля в диалоге.

---

**Контакты:** `<email лида проекта Wave Chat>`
**Среда тестирования:** `https://aiass-production.up.railway.app/`
**Repo Wave Chat:** `mag8888/AI_ASS` (приватный)
