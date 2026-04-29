# ТЗ: интеграция AI-Ассистента с Wave Match API

> Документ для команды разработки Wave Match. Описывает endpoints и поля,
> которые AI-ассистент должен получать/обновлять, чтобы вести диалоги с уже
> зарегистрированными клиентами без ручной перезаливки данных.

## 1. Цель интеграции

AI-ассистент общается в Telegram с клиентами Wave Match. Цели:

1. **Видеть актуальный профиль** клиента из Wave Match (источник правды)
2. **Понимать что заполнено, чего не хватает** — задавать в диалоге только недостающие вопросы
3. **Обновлять Wave Match** новыми данными, которые удалось собрать в диалоге
4. **Получать уведомления** о новых регистрациях / изменениях статуса для проактивной коммуникации

## 2. Аутентификация

```
GET  /api/v1/...
Header: Authorization: Bearer <SERVICE_TOKEN>
```

- Сервисный токен длительного действия (без OAuth-флоу), привязан к роли «AI Assistant»
- Опциональный refresh: `POST /api/v1/auth/refresh` если токены ротируются

## 3. Endpoints

### 3.1. Получить пользователя по Telegram ID или username

```
GET /api/v1/users/by-telegram?telegramId=123456789
GET /api/v1/users/by-telegram?username=ivan_petrov
```

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
  "city": "Москва",
  "registeredAt": "2024-09-12T14:23:00Z",
  "subscriptionTier": "PRO",
  "subscriptionExpiresAt": "2025-12-31T23:59:59Z",
  "profile": {
    "activity": "Маркетинг и реклама",
    "businessCard": "Помогаю...",
    "bestClients": "...",
    "requests": "Ищу клиентов в B2B",
    "hobbies": "Путешествия, лыжи",
    "currentIncome": "500к-1М",
    "desiredIncome": "1М-3М",
    "networkingGoal": "Найти 3 партнёров до конца квартала"
  },
  "tags": ["b2b", "marketing", "moscow"],
  "lastActivityAt": "2025-04-25T10:14:00Z"
}
```

**404** если такого юзера нет в базе Wave Match.

**Поведение AI**: при первом сообщении в Telegram бот вызывает этот endpoint,
получает профиль, кэширует на 10 минут. На основе `profile.*` определяет
какие поля **уже заполнены** и не задаёт по ним вопросы повторно.

### 3.2. Получить список пользователей (для рассылок)

```
GET /api/v1/users?status=active&minProfileCompleteness=0.5&page=1&pageSize=200
```

Параметры:
- `status` — `active` / `paused` / `churned` / `all`
- `subscriptionTier` — `FREE` / `PRO` / `PREMIUM`
- `minProfileCompleteness` — 0.0..1.0
- `lastActivityBefore` / `lastActivityAfter` — для реактивации спящих
- `tags[]` — фильтр по тегам
- `page` / `pageSize` — пагинация (max pageSize = 500)

**Response 200:**
```json
{ "total": 1234, "page": 1, "pageSize": 200, "items": [/* массив как 3.1 */] }
```

**Поведение AI**: используется в Broadcast-фиче. Сегментируем базу для
выбора аудитории (например «PRO юзеры с заполнением < 50%, активные за 30
дней»).

### 3.3. Обновить профиль пользователя

```
PATCH /api/v1/users/{id}/profile
Body: { "city": "Санкт-Петербург", "activity": "FinTech" }
```

**Response 200:** `{ "ok": true, "updatedFields": ["city", "activity"] }`

Семантика: бот в диалоге узнал что `city = "Санкт-Петербург"`, шлёт PATCH.
Wave Match использует это как источник истины и обновляет UI на сайте.

### 3.4. История диалогов / заметки CRM

```
POST /api/v1/users/{id}/notes
Body: { "type": "ai_dialog", "summary": "Уточнили: ищет клиентов в B2B", "tags": ["b2b"] }
```

Каждый раз когда AI завершает значимый этап (`QUALIFICATION` → `CLOSED`,
успешный матч и т.д.), отправляет короткую заметку в CRM Wave Match.

### 3.5. Webhook: уведомления о событиях из Wave Match → AI

Wave Match шлёт **POST на наш webhook** при событиях:

```
POST https://aiass-production.up.railway.app/webhooks/wavematch
Header: X-WM-Signature: <hmac-sha256 of body using shared secret>
Body:
{
  "event": "user.registered" | "user.subscription_renewed" | "user.profile_updated" | "user.churn_risk",
  "userId": "wm_user_a1b2c3",
  "telegramId": "123456789",
  "occurredAt": "2025-04-29T08:14:00Z",
  "payload": { ... event-specific data ... }
}
```

**Реакция AI на каждое событие:**
| Event | Действие AI-ассистента |
|-------|------------------------|
| `user.registered` | Welcome-сообщение через 5 минут после регистрации |
| `user.subscription_renewed` | Спросить актуальные запросы, предложить матчи |
| `user.profile_updated` | Инвалидировать кэш профиля |
| `user.churn_risk` | Запустить scenario `wm_soft_checkin` |

### 3.6. Match-данные (если Wave Match сам рассчитывает матчи)

```
GET /api/v1/users/{id}/matches?limit=5
```

Если Wave Match сам ведёт логику матчинга, AI использует её результаты
вместо своего keyword-scoring. Если такой логики нет — оставляем работу за
ботом.

## 4. Поля профиля — синхронизация

| AI-Ассистент (Prisma) | Wave Match API (предлагается) | Комментарий |
|-----------------------|-------------------------------|-------------|
| `firstName`            | `firstName`                  | source-of-truth = Wave Match |
| `lastName`             | `lastName`                   | source-of-truth = Wave Match |
| `gender` (auto-detect) | `gender`                     | если в WM пусто — пушим из бота после авто-детекта |
| `city`                 | `profile.city`               | bidirectional |
| `activity`             | `profile.activity`           | bidirectional |
| `businessCard`         | `profile.businessCard`       | bidirectional |
| `bestClients`          | `profile.bestClients`        | bidirectional |
| `requests`             | `profile.requests`           | bidirectional |
| `hobbies`              | `profile.hobbies`            | bidirectional |
| `currentIncome`        | `profile.currentIncome`      | bidirectional, free-form (Wave Match хранит как enum?) |
| `desiredIncome`        | `profile.desiredIncome`      | bidirectional |
| `networkingGoal`       | `profile.networkingGoal`     | bidirectional |
| `subscriptionTier`     | `subscriptionTier`           | read-only из WM |
| `revenue`              | `lifetimeValue`              | read-only из WM |

**Правило конфликтов**: если значение есть и в боте и в WM, побеждает WM
(он источник правды). Если бот собрал новое значение — пушит в WM
немедленно (`PATCH /users/{id}/profile`).

## 5. Auto-detect gender по имени

Бот делает локальный авто-детект по `firstName` (Russian heuristic).
Если в Wave Match `gender = null`, бот после первого диалога делает
`PATCH` с обнаруженным значением. Wave Match помечает поле как
`autoDetected: true` чтобы пользователь мог его исправить в своём кабинете.

## 6. Логика "что не хватает" в диалоге

Псевдокод бота:

```
on incoming message from user U:
    profile = WM.getUser(U.telegramId).profile
    missing = PROFILE_FIELDS.filter(f => !profile[f] || profile[f] === '')
    
    if missing contains 'activity':
        ask "Чем сейчас занимаешься?"
    elif missing contains 'city':
        ask "Из какого ты города?"
    elif missing contains 'requests':
        ask "С какими задачами к тебе чаще всего приходят?"
    ...
    
    when user answers — extract value, PATCH WM, refresh cache.
```

Этот флоу уже реализован у нас — нужны только endpoints выше.

## 7. Rate limits / производительность

- `GET /users/by-telegram` — ожидаем до 50 RPS в пике (входящие сообщения)
- `GET /users` — до 1 RPS (Broadcast preview)
- `PATCH /users/{id}/profile` — до 10 RPS
- Webhook → ассистенту — гарантированная доставка с retry × 3 (exponential backoff)
- Идемпотентность webhook: каждый event имеет `eventId`, бот хранит последние 1000 ID для дедупликации

## 8. План внедрения по этапам

### Этап 1 — read-only интеграция (1-2 недели)
- 3.1 (`GET by-telegram`)
- 3.2 (`GET /users`)
- 3.5 (`webhook user.registered`)

→ Бот видит профили, делает welcome-рассылки, работает по принципу «уточнить недостающее».

### Этап 2 — bidirectional синхронизация (1 неделя)
- 3.3 (`PATCH profile`)
- 3.4 (`POST notes`)

→ Всё, что бот собирает, оседает в Wave Match. Менеджеры видят CRM-историю.

### Этап 3 — расширенная аналитика (по необходимости)
- 3.6 (Wave Match's own matches)
- Дополнительные events в webhook
- Sync revenue / lifetime value

## 9. Безопасность

- Все запросы по HTTPS
- Service token не логируется (масковать в логах как `Bearer ***`)
- Webhook подписывается HMAC-SHA256, секрет в env
- PII (телефоны, email) не попадает в логи AI-ассистента
- При запросе пользователя (GDPR) — endpoint `DELETE /users/{id}/ai-dialogs` чтобы стереть историю в боте

## 10. Тестовый сценарий end-to-end

1. Тестовый юзер регистрируется на Wave Match
2. Wave Match шлёт webhook `user.registered` боту
3. Бот через 5 минут пишет в Telegram: «Привет, Иван! Wave Match здесь...»
4. Юзер отвечает: «Привет! Я ищу клиентов в B2B»
5. Бот извлекает `requests = "клиенты в B2B"`, шлёт `PATCH /users/{id}/profile`
6. На сайте Wave Match в кабинете Ивана появляется новое значение в "Текущие запросы"
7. Бот пишет в CRM: `POST /users/{id}/notes` с summary диалога
8. Через час у Ивана score-3 матч в боте — он получает интро-сообщение

---

**Контакты**: `<email лида проекта AI-ассистента>`
**Среда тестирования**: `https://aiass-production.up.railway.app/`
**Repo интеграционного слоя**: `mag8888/AI_ASS` (приватный)
