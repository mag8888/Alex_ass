# Wave Match × Wave Chat — Runbook активации интеграции

**Аудитория:** команда Wave Match
**Статус нашей стороны (Wave Chat):** готова, контракт реализован, env-переменные выставлены, endpoint живой
**Что осталось:** 3 шага ниже + e2e проверка

> Полная спека контракта — [`docs/WAVEMATCH_API_TZ.md`](./WAVEMATCH_API_TZ.md). Здесь только action items.

---

## §1. Что у нас уже работает

| Компонент | Статус | Подтверждение |
|---|---|---|
| `POST /webhooks/wm` принимает события | ✅ | Тест с правильно подписанным запросом → `200 {"ok":true}` |
| HMAC-SHA256 verify (`X-WC-Signature`, `X-WC-Timestamp`) | ✅ | Skew check в **секундах**, окно 300s, anti-replay по eventId |
| Идемпотентность доставки | ✅ | Помним последние 1000 `eventId`, дубли молча игнорируем |
| Bearer-токен на запросы к WM API | ✅ | `WAVE_CONNECT_API_TOKEN` настроен на нашем Railway |
| Кэш профиля 10 мин по telegramId+id | ✅ | В коде, дёргается на каждое входящее TG-сообщение |
| PATCH назад с ETag (412 → invalidate cache) | ✅ | После того как GPT извлёк новые поля профиля |
| Welcome через 7 минут после `user.created` | ✅ | Ловится листенером, GPT генерит фразу в нашем тоне |
| CRM notes при квалификации/матче | ✅ | `ai_qualification_done`, `ai_match_proposed`, `ai_churn_signal` |

**Наш webhook URL:** `https://aiass-production.up.railway.app/webhooks/wm`
**Наш health endpoint:** `https://aiass-production.up.railway.app/status` (200 = живой)

---

## §2. Что нужно сделать вам — 3 шага

### Шаг 1. Подписаться на webhook (одноразово)

```bash
curl -X POST https://api-production-b682a.up.railway.app/api/wm/webhooks \
  -H "Authorization: Bearer <ваш_admin_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://aiass-production.up.railway.app/webhooks/wm",
    "events": [
      "user.created",
      "user.updated",
      "profile.updated",
      "club.joined",
      "club.left",
      "subscription.changed"
    ],
    "secret": "a141dc7b1b42715b42f8c058153a4a5f8fe8249adddf1306015aef606237249a"
  }'
```

**Важно:** `secret` должен совпадать с тем, что у нас лежит в `WAVE_CONNECT_WEBHOOK_SECRET` (мы его сгенерировали и передали — он указан выше). Если генерили со своей стороны — обновим у себя.

**Проверка**:
```bash
curl https://api-production-b682a.up.railway.app/api/wm/webhooks \
  -H "Authorization: Bearer <ваш_admin_token>"
```
В ответе должна быть подписка с нашим URL.

### Шаг 2. Триггернуть тестовое событие

Любой `PATCH` тестового юзера эмиттнет `user.updated`:

```bash
# Только writable-поля (profile.* НЕ принимаются — вернёт 400 readonly_field)
curl -X PATCH https://api-production-b682a.up.railway.app/api/wm/users/<test_user_id> \
  -H "Authorization: Bearer <ваш_admin_token>" \
  -H "If-Match: <etag_from_GET>" \
  -H "Content-Type: application/json" \
  -d '{"crmTags": ["alignment-test-2026-04-29"]}'
```

Полный список writable-полей: `email`, `phone`, `firstName`, `lastName`, `notifPrefs`, `marketingOptIn`, `marketingOptInUpdatedAt`, `crmTags`, `locale`. См. `WritableUserFields` в `docs/contract/openapi.yaml`.

→ В наших логах должно появиться:
```
[wm-webhook] event=user.updated, eventId=...
[wm] invalidated cache for ...
```

### Шаг 3. Полный e2e тест регистрации

1. Создать тестового юзера в Wave Match с **реальным `telegramId`** (например, ваш собственный TG ID).
2. WM эмиттит `user.created` → летит к нам.
3. Через **7 минут** наш бот пишет в Telegram приветствие в стиле Wave Match:
   > «Привет, {имя}! Это Wave Match. Расскажи, какие у тебя сейчас актуальные запросы — может, нужны клиенты или партнёры? Можно голосом 🎙️»
4. Юзер отвечает текстом или голосом.
5. Бот извлекает фразы про сферу/запросы → шлёт `PATCH /api/wm/users/{id}` с обновлённым `profile`.
6. На сайте Wave Match в кабинете юзера обновляются поля `activity` / `requests`.
7. Когда профиль заполнен достаточно → бот шлёт `POST /api/wm/users/{id}/notes` с типом `ai_qualification_done`.

---

## §3. Что мы хотим увидеть в логах вашей стороны

После Шага 1 и Шага 2:

```
[webhook] dispatched event=user.updated to https://aiass-production.up.railway.app/webhooks/wm
[webhook] delivery_id=... status=200 latency=120ms
```

После Шага 3:

```
[api] PATCH /api/wm/users/{id}/profile by Bearer:wave-chat-prod
       updatedFields=[activity, requests]
       new_etag=W/"v3-..."

[api] POST /api/wm/users/{id}/notes by Bearer:wave-chat-prod
       type=ai_qualification_done
```

---

## §4. Если что-то пошло не так

| Ошибка | Что проверить |
|---|---|
| **401 invalid signature, reason=signature mismatch** | `secret` различается на двух сторонах |
| **401 reason=timestamp skew** | `X-WC-Timestamp` должен быть **Unix epoch в секундах** (не в мс). У нас окно 300s. |
| **412 Precondition Failed на PATCH** | Кэш ETag устарел — мы автоматически invalidate и retry'имся на следующем сообщении |
| **Наш webhook возвращает 401 reason=missing signature** | Проверьте что шлёте оба заголовка: `X-WC-Signature: sha256=<hex>` и `X-WC-Timestamp: <secs>` |
| **404 на GET /users/by-telegram?telegramId=...** | OK — у нас есть fallback на локальные данные, диалог продолжится |
| **5xx от нашего endpoint** | Дайте `delivery_id` — посмотрим в наших Railway логах. retry от вас приветствуется. |

---

## §5. Production rollout — финальный чеклист

Когда e2e тест прошёл:

- [ ] Webhook subscription активна с production-URL `https://aiass-production.up.railway.app/webhooks/wm`
- [ ] Все 6 events подписаны: `user.created`, `user.updated`, `profile.updated`, `club.joined`, `club.left`, `subscription.changed`
- [ ] `subscriptionTier`, `subscriptionStatus`, `marketingOptIn` отдаются в `GET /users/:id` (для broadcast-фильтрации)
- [ ] CRM notes (`/notes`) видны менеджерам Wave Match в кабинете юзера
- [ ] Rate-limits согласованы (мы держим 50 RPS на read, 10 RPS на PATCH в пике)
- [ ] **Ротировали** Bearer-токен после первого успешного теста (старый утёк в чат разработки)
- [ ] Retry-расписание включено (1m → 5m → 30m → 2h → 6h → 24h → dead)

---

## §6. Что дальше можно расширить (не блокирует первый запуск)

Из спеки §1.1 / §6, но не требуется в Этапе 1:

- `subscription.changed` — уже подписаны, ждём первый платёж
- `DELETE /api/wm/users/:id/ai-dialogs` — для GDPR (когда пользователь удалит аккаунт в WM)
- `getUserById?include=stats` — нужно когда добавим funnel-дашборд на нашей стороне
- AI-метки автодетекта (`genderAutoDetected: true` в WM, чтобы юзер мог исправить)

---

## §7. Контакты

| Роль | Кто | Что |
|---|---|---|
| Owner Wave Chat | Roman (`xqrmedia@gmail.com`, TG `@roman_arctur`) | Решения, токены, прод |
| Wave Chat repo | `mag8888/AI_ASS` (приватный) | Код интеграции, логи, конфиг |
| Wave Chat URL | `https://aiass-production.up.railway.app` | API + webhook receiver |
| Wave Match URL | `https://api-production-b682a.up.railway.app` | API + webhook subscription mgmt |

**Открытые вопросы для координации:**

1. Кто на стороне WM ведёт интеграцию (TG/email)?
2. Есть ли у WM staging-environment, чтобы первые тесты прогнать не на проде?
3. Когда реально появится первый тестовый `user.created` — сегодня/завтра?

---

🟢 **Со стороны Wave Chat всё готово.** Ждём Шаг 1 (subscription) — дальше всё пойдёт автоматически.
