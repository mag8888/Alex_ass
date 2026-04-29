# ТЗ для команды Wave Match — расширение `PATCH /api/wm/users/{id}` для profile.*

**Документ:** `docs/WM_PROFILE_WRITE_TZ.md` (mirror в `mag8888/AI_ASS`)
**Версия:** 1.0
**Дата:** 2026-04-29
**Аудитория:** разработчик `mag8888/Wave_Connect`
**Авторитет:** Wave Chat owner (`@roman_arctur`)

---

## 0. Зачем

Сейчас `PATCH /api/wm/users/{id}` принимает только `WritableUserFields`:
```
email, phone, firstName, lastName, notifPrefs, marketingOptIn,
marketingOptInUpdatedAt, crmTags, locale
```

Любая попытка прислать `profile.*` → silently игнорируется (см. acceptance §4 alignment TZ).

**Реальный кейс:**
Wave Chat в живом диалоге извлекает из ответов пользователя `role`, `industry`, `location`, `skills`, `hobbies` и т.д. (Principle #10 нашего prompt'а — drip-fill через диалог). Мы хотим, чтобы эти данные **немедленно появлялись в WM-кабинете пользователя**, увеличивая `profile.completion%` без ручного захода в @wave_match_bot.

**Бизнес-логика**: пользователь зарегистрировался, но не дозаполнил профиль (психологический барьер «анкеты»). Через диалог в Telegram Wave Chat собирает данные легче — но без write-эндпоинта они застревают у нас.

---

## 1. Контракт

### 1.1. Расширить `PATCH /api/wm/users/{id}`

Добавить ключ `profile` в request body. Принимать вложенный partial-объект, поля проверять по новой allowlist `WritableProfileFields`.

```diff
  WritableUserFields:
    type: object
    additionalProperties: false
    properties:
      email: { type: string, format: email, nullable: true }
      phone: { type: string, nullable: true }
      firstName: { type: string }
      lastName: { type: string, nullable: true }
      notifPrefs: { type: string, enum: [all, weekly, off] }
      marketingOptIn: { type: boolean }
      marketingOptInUpdatedAt: { type: string, format: date-time }
      crmTags: { type: array, items: { type: string } }
      locale: { type: string }
+     profile:
+       $ref: '#/components/schemas/WritableProfileFields'

+ WritableProfileFields:
+   type: object
+   additionalProperties: false
+   description: Profile fields editable by partner integrations (Wave Chat).
+   properties:
+     role:        { type: string, maxLength: 200, nullable: true }
+     industry:    { type: string, maxLength: 200, nullable: true }
+     location:    { type: string, maxLength: 200, nullable: true }
+     company:     { type: string, maxLength: 200, nullable: true }
+     gender:      { type: string, enum: [M, F, Other], nullable: true }
+     tags:
+       type: array
+       maxItems: 50
+       items: { type: string, maxLength: 50 }
+     skills:
+       type: array
+       maxItems: 50
+       items: { type: string, maxLength: 50 }
+     hobbies:
+       type: array
+       maxItems: 30
+       items: { type: string, maxLength: 50 }
```

`profile.completion` — НЕ writable, рассчитывается на стороне WM (как сейчас).

### 1.2. Поведение

- Partial update: переданные ключи перезаписывают, отсутствующие — не трогаются.
- Массивы (`tags`, `skills`, `hobbies`) — **replace, не merge** (если WC хочет добавить — пусть пришлёт текущий список + новые элементы).
- `null` → очистка поля. Пустой массив `[]` → очистка массива.
- Любой ключ вне allowlist (включая `completion`, `verified`, etc.) → `400 readonly_field` с указанием отдельных под-полей в `fields`:
  ```json
  { "error": "readonly_field", "fields": ["profile.completion"], "allowedFields": [...] }
  ```

### 1.3. ETag

`If-Match` — тот же что для всего User'а (формат `"v{version}-{unix_seconds}"`). При изменении ANY profile-поля версия инкрементируется → ETag обновляется. На 412 возвращаем `{ error: 'precondition_failed', current: <full User with profile> }`.

### 1.4. Response

Ровно тот же что у текущего PATCH: возвращаем **полный User объект** (с include=profile уровнем заполнения) + **новый ETag в HTTP-заголовке**. Никаких `{ ok, updatedFields }` — клиент сам диффает если нужно.

### 1.5. Webhook

После успешного сохранения эмиттим существующий `profile.updated` event. Payload — текущий формат:
```json
{
  "event": "profile.updated",
  "deliveryId": "<uuid>",
  "createdAt": "<iso>",
  "data": {
    "userId": "<uuid>",
    "profile": { /* full updated Profile */ },
    "isFirstTime": false  // true только если до этого Profile был null
  }
}
```

Wave Chat у себя инвалидирует кэш и продолжает диалог.

### 1.6. AuditLog

Запись в `WMApiAuditLog` как для остальных PATCH-вызовов. В `meta` приложить:
```json
{
  "updatedFields": ["profile.role", "profile.skills"],
  "byScope": "write",
  "byKey": "wave-chat-prod"
}
```

---

## 2. Curl-тесты приёмки

```bash
export TOKEN="${WAVE_CONNECT_API_TOKEN}"
export BASE="https://api-production-b682a.up.railway.app"
USER_ID="<uuid тестового юзера>"

# 1. PATCH с profile.role
ETAG=$(curl -sI -H "Authorization: Bearer $TOKEN" "$BASE/api/wm/users/$USER_ID" \
  | grep -i '^etag:' | awk '{print $2}' | tr -d '\r')
curl -i -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "If-Match: $ETAG" \
  -d '{"profile":{"role":"Маркетолог","industry":"B2B SaaS"}}' \
  "$BASE/api/wm/users/$USER_ID"
# Ожидание: 200 + ETag header (новый) + body содержит profile.role="Маркетолог", profile.industry="B2B SaaS"

# 2. PATCH partial — обновить только skills
ETAG=$(curl -sI ... | ...)
curl -i -X PATCH ... -d '{"profile":{"skills":["paid-ads","growth"]}}' "$BASE/api/wm/users/$USER_ID"
# Ожидание: 200; role/industry с прошлого PATCH сохранены; skills заменён массивом из 2 элементов

# 3. PATCH несуществующего поля — должен упасть
curl -i -X PATCH ... -d '{"profile":{"completion":100}}' "$BASE/api/wm/users/$USER_ID"
# Ожидание: 400 readonly_field, fields:["profile.completion"]

# 4. Сочетание User + Profile полей в одном запросе
curl -i -X PATCH ... -d '{"crmTags":["ai-enriched"],"profile":{"location":"Москва"}}' \
  "$BASE/api/wm/users/$USER_ID"
# Ожидание: 200; оба обновлены; ETag новый

# 5. Webhook
# После шага 4 наш receiver на https://aiass-production.up.railway.app/webhooks/wm
# должен получить событие profile.updated с data.profile.location="Москва" и подписью HMAC.
# Проверить delivery в WebhookDelivery — status=200, attempts=1.
```

---

## 3. Валидация и ошибки

| Случай | Status | Body |
|---|---|---|
| Любое profile-поле валидно | 200 | full User с обновлёнными полями + ETag header |
| `profile` содержит ключ вне allowlist | 400 | `{error:"readonly_field", fields:["profile.X"], allowedFields:[...]}` |
| `profile.role` > 200 chars | 400 | `{error:"invalid_input", fields:["profile.role"], reason:"max length 200"}` |
| `profile.tags.length` > 50 | 400 | `{error:"invalid_input", fields:["profile.tags"], reason:"max items 50"}` |
| `profile.gender` не из enum | 400 | `{error:"invalid_value", fields:["profile.gender"], allowed:["M","F","Other"]}` |
| `If-Match` устарел | 412 | `{error:"precondition_failed", current: <full User>}` |
| Bearer без `write` scope | 403 | `{error:"insufficient_scope", required:"write"}` |
| Юзера нет | 404 | `{error:"not_found"}` |

---

## 4. Backfill / migration

Существующие пользователи: ничего не трогать. Schema уже хранит `profile.*` как nullable. Просто новые PATCH'и начнут заполнять то, что было `null`.

`profile.completion` пересчитывается WM-стороной автоматически при любом изменении profile-полей (как сейчас при заполнении из @wave_match_bot).

---

## 5. План внедрения

| Этап | Задача | Объём |
|---|---|---|
| 1 | Добавить `WritableProfileFields` schema в YAML канон | 1 PR в Wave_Connect |
| 2 | Расширить routes/wm.js — обработка `body.profile`, валидация, save через Prisma | ~50 строк + тесты |
| 3 | Эмиссия `profile.updated` после save (если ещё не работает на этом пути) | 5 строк |
| 4 | Прогнать §2 acceptance | manual |
| 5 | Wave Chat обновляет канон у себя + меняет PATCH-флоу с локальной записи на полную: local → WM PATCH | мы сделаем |

**Сроки на Wave Match стороне**: 1 день.
**После этого Wave Chat**: 1 день, чтобы переключить.

---

## 6. После внедрения — что Wave Chat будет делать

Сейчас (до этого ТЗ):
```
listener.ts → GPT extract profile поля → сохранили локально
                                       → addCrmTag('ai-profiling')
```

После (целевая архитектура):
```
listener.ts → GPT extract profile поля → сохранили локально
                                       → patchUser(id, etag, { profile: {role, industry, ...} })
                                       → completion% растёт у юзера в WM кабинете
                                       → profile.updated webhook → у нас опять обновился кэш
```

Это закрывает loop: разговор → обогащение профиля в обоих системах → лучшие матчи на стороне WM.

---

## 7. Открытые вопросы

1. **Conflict resolution.** Если WC прислал `profile.role = "Маркетолог"`, а пользователь параллельно через @wave_match_bot задал `profile.role = "Founder"` — кто побеждает? Предложение: last-write-wins по `updatedAt`. Если хотите гибче — `If-Match` уже даёт линию защиты, можем добавить opt-in `mode=overwrite|fill_only` (fill_only: пишем только если поле было null).

2. **Partial extraction confidence.** Wave Chat иногда извлекает поле с низкой уверенностью (юзер сказал «занимаюсь AI», мы неуверенно ставим `industry = "AI"`). Хотим ли отдельный флаг "tentative" в Profile? (МVP: нет, full ownership за last-write-wins.)

3. **Profile.tags vs User.crmTags.** Wave Match различает: `tags` — публичные теги для поиска и матчинга (видны другим пользователям); `crmTags` — внутренние CRM-метки (видны только админам). Wave Chat должен пушить пользовательские интересы в `profile.tags`, а свои AI-метки (`ai-profiling`, `qualified`) в `crmTags`. Это логика на нашей стороне, обычно для документации.

---

## 8. Контакты

- Wave Chat owner: `xqrmedia@gmail.com`, TG `@roman_arctur`
- Этот документ изменяется через PR в `mag8888/AI_ASS/docs/WM_PROFILE_WRITE_TZ.md`
- Вопросы → reply-комментарий на строку в YAML PR

---

**Конец ТЗ. Минимальная версия реализации (без opt-in mode, без tentative-флага) — 1 рабочий день.**
