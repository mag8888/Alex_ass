# TZ: Bulk User Export для Wave Chat-интеграции (Wave Match v1.5)

**Автор:** Wave Chat (`@Mag_88888888`)
**Версия:** 1.0 (draft)
**Цель:** дать боту Wave Chat возможность получать актуальную базу зарегистрированных юзеров со всеми контактными данными, чтобы делать **персонализированные таргетированные рассылки** (приглашения на ивенты, тематические intro по запросам клуба, broadcast по локациям / интересам).

---

## 1. Проблемы текущей интеграции

| # | Что не так сейчас | Эффект |
|---|---|---|
| 1 | `GET /api/wm/users` (lightweight) **не возвращает `username`** — только `id` + `telegramId` + `firstName` | На каждого юзера нужен отдельный `GET /api/wm/users/:id` для получения `username` — 100+ HTTP запросов на каждый sweep |
| 2 | Нет `accessHash` для юзеров без `@username` | Не можем DM-нуть ~30% базы (юзеры с числовым `telegramId` без публичного handle) |
| 3 | Нет фильтрации по `marketingOptIn` | Не знаем кому юридически разрешено слать рассылки |
| 4 | Нет фильтрации по локации / нише / тегам | Не можем сделать таргет «Bali entrepreneurs» или «AI-experts» |
| 5 | Webhook `user.created` не всегда доходит (см. Katya, Egor, Alex кейсы) | Пропускаем 20-30% свежих регистраций |
| 6 | `listUsers` имеет `updatedSince` но не `createdSince` | Любое обновление профиля «закрывает» юзера от sweep по дате регистрации |

---

## 2. Что нужно добавить

### 2.1. Расширить `WMUserListItem` schema

Поля которые должны быть в **list-ответе** (без дополнительных GET-запросов):

```ts
WMUserListItem {
  id: string;
  telegramId: string;        // уже есть
  username: string | null;   // ★ ДОБАВИТЬ — @handle если есть
  firstName: string | null;
  lastName: string | null;   // ★ ДОБАВИТЬ
  accessHash: string | null; // ★ ДОБАВИТЬ — для DM без @username
  registered: boolean;       // ★ ДОБАВИТЬ — финализирована ли регистрация
  createdAt: string;         // ★ ДОБАВИТЬ (ISO)
  updatedAt: string;         // уже есть
  marketingOptIn: boolean;   // ★ ДОБАВИТЬ — разрешение на рассылки
  subscriptionTier: SubscriptionTier;
  // Lightweight profile preview
  profile: {
    role: string | null;
    industry: string | null;
    location: string | null;
    completion: number;       // % заполнения
  } | null;
}
```

### 2.2. Новый эндпоинт: `GET /api/wm/users/export`

Bulk-export с фильтрами и пагинацией.

**Query params:**
- `registered` (`true|false|any`) — default `true`
- `marketingOptIn` (`true|false|any`) — default `true` (compliance)
- `createdAfter` (ISO timestamp) — фильтр по дате регистрации
- `updatedAfter` (ISO timestamp) — фильтр по последнему апдейту
- `location` (substring match по profile.location, case-insensitive) — например `?location=Бали`
- `roles` (CSV) — например `?roles=Предприниматель,Investor`
- `tags` (CSV) — фильтр по `profile.tags`
- `withAccessHash` (`true|false`) — default `true`, нужно для DM
- `limit` (default 100, max 1000)
- `cursor` (для пагинации)

**Response:**
```json
{
  "items": [ /* WMUserListItem[] с полным набором полей выше */ ],
  "nextCursor": "abc123",
  "total": 1247
}
```

**Example use cases:**

```bash
# Все Bali-предприниматели зарегистрированные за последние 30 дней
GET /api/wm/users/export?roles=Предприниматель&location=Бали&createdAfter=2026-04-10T00:00Z

# Все юзеры с marketing opt-in для broadcast приглашения на event
GET /api/wm/users/export?marketingOptIn=true&limit=500
```

### 2.3. Webhook reliability fix

Текущий webhook `user.created` пропускает регистрации. Что нужно:

1. **Idempotent retry** на стороне WM: если наш endpoint вернул не-2xx — повторить 3 раза с exponential backoff (1с, 30с, 5мин).
2. **Delivery log** доступ через `GET /api/wm/webhooks/deliveries?eventType=user.created&since=ISO` — мы можем проверить какие события пытались дойти и не дошли (для debug).
3. **Replay endpoint**: `POST /api/wm/webhooks/replay/:deliveryId` — повторно отправить failed delivery (для ручного recovery).

### 2.4. `marketingOptIn` управление

Сейчас непонятно как юзер opt-in / opt-out из рассылок. Нужно:

- Поле `User.marketingOptIn: boolean` (default по политике WM)
- Эндпоинт `POST /api/wm/users/:id/opt-out` — юзер пишет «отпишите меня», бот вызывает этот эндпоинт
- Webhook `user.marketing_opt_changed` — чтобы локально синхронизироваться

---

## 3. Безопасность

- Endpoint требует тот же Bearer-token что и текущие WM API
- Rate limit: 60 запросов/мин на bulk export (хватит для нормального sync)
- `accessHash` — чувствительные данные, логировать только в audit (не в обычные логи)
- Pagination cursor должен быть подписан (HMAC) чтобы юзер не мог манипулировать им

---

## 4. Use cases с нашей стороны

После выкатки v1.5 мы будем:

1. **Раз в час** делать `GET /api/wm/users/export?updatedAfter=<last_sync>&limit=200` — синхронизировать локальную копию для холодного outreach
2. **Перед каждой рассылкой** (event invite, тематический broadcast) — фильтровать через `?roles=` / `?location=` / `?tags=` — получать только релевантную аудиторию
3. **Опт-аут**: когда юзер пишет «отпишите меня» → бот вызывает `POST /opt-out` → WM сразу обновляет, наш cron больше его не включает
4. **Webhook recovery**: каждое утро в 09:00 МСК — `GET /webhook/deliveries?since=yesterday&status=failed` → replay пропущенных регистраций

---

## 5. Чеклист для бек-команды WM

- [ ] Расширить `WMUserListItem` schema (8 новых полей)
- [ ] Реализовать `GET /api/wm/users/export` с фильтрами
- [ ] Добавить `marketingOptIn` в `User` + `POST /opt-out` + `user.marketing_opt_changed` webhook
- [ ] Webhook retry policy (3 попытки с backoff)
- [ ] `GET /webhook/deliveries` для debug
- [ ] `POST /webhook/replay/:id` для recovery
- [ ] Обновить OpenAPI до v1.5
- [ ] Передать список изменений нам — мы за 1-2 дня подключим

---

## 6. Приоритет

**P0 (критично, нужно срочно):**
- 2.1 — username в listUsers (блокирует автоматизацию)
- 2.3.1 — webhook retry (пропускаем 20% регистраций)

**P1 (важно, в ближайший спринт):**
- 2.2 — bulk export с фильтрами
- 2.4 — marketingOptIn (compliance перед массовыми рассылками)

**P2 (полезно, в течение месяца):**
- 2.3.2-3 — delivery log + replay

---

## 7. Открытые вопросы к WM-команде

1. У вас уже есть `marketingOptIn`-флаг или нужно его вводить?
2. `accessHash` хранится в вашей БД или вы получаете его на лету из Telegram при каждом обращении?
3. Сколько юзеров в базе сейчас (~) — это влияет на дизайн пагинации?
4. Как сейчас юзер opt-in/opt-out из рассылок — через UI или через бот @wave_match_bot?
5. Webhook retry — у вас уже реализован какой-то механизм?

---

**ETA с нашей стороны:** 1-2 дня после готовности v1.5.
**Контакты:** @roman_arctur, @Mag_88888888.
