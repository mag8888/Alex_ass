# ТЗ для агента «Логос» — интеграция с биллингом Wave Match

**Версия:** 1.0
**Дата:** 30.05.2026
**Контакт со стороны WM:** @roman_arctur
**Бот-источник DM:** @Mag_88888888 (далее — «Артур»)
**Боевой API:** `https://aiass-production.up.railway.app`

---

## 1. Что строим

«Логос» интегрируется с биллинговым API проекта Wave Match. Артур выставляет счета клиентам «Логоса» через Telegram @wallet и пробрасывает «Логосу» webhook'и об оплате.

**Модель A:** деньги остаются на @wallet Артура. «Логос» получает только подтверждение факта оплаты. Сверка и выплата «Логосу» — отдельным процессом (вне ТЗ).

```
┌─────────┐   API: createInvoice    ┌───────────────┐  DM @wallet  ┌────────┐
│ Логос   │ ──────────────────────► │ Wave Match    │ ───────────► │ Клиент │
│ (агент) │                         │ (Артур-бот)   │              └────┬───┘
│         │ ◄────────────────────── │               │ ◄──────────────── │
└─────────┘   webhook invoice.paid  └───────────────┘   @wallet оплата
```

---

## 2. Onboarding (одноразово)

1. Со стороны WM Роман делает `POST /admin/agents` → выдаёт «Логосу» `apiKey` формата `wak_<64hex>`.
2. «Логос» сообщает WM `webhookUrl` — URL, который принимает POST с JSON, доступен по HTTPS, без auth со стороны WM (опционально HMAC-подпись, см. §6).
3. Все вызовы — с заголовком `X-Agent-Api-Key: wak_...`. Без ключа → `401`.

---

## 3. API эндпоинты

### 3.1 `POST /api/v1/invoice` — создать счёт

**Headers:** `X-Agent-Api-Key`, `Content-Type: application/json`

**Body:**
```json
{
  "orderId": "logos-2026-05-30-0001",
  "clientUsername": "@example_user",
  "amount": "150",
  "currency": "USDT"
}
```

| Поле | Тип | Обязательное | Описание |
|---|---|---|---|
| `orderId` | string | ✓ | Ключ идемпотентности на стороне «Логоса». Повторный POST с тем же `orderId` НЕ создаёт дубликат — вернёт существующий + `created:false` |
| `clientUsername` | string | ✓ | Telegram username клиента (с `@` или без). Нормализуется в lowercase |
| `amount` | string \| number | ✓ | Сумма строкой (запятая → точка, пробелы убираются). Любая точность |
| `currency` | string | ✓ | `USDT` \| `TON` \| `BTC` \| `ETH` \| `NOT` \| `USDC` (matched регексом @wallet-уведомления) |

**Response 200:**
```json
{
  "id": 42,
  "orderId": "logos-2026-05-30-0001",
  "status": "PENDING",
  "clientUsername": "example_user",
  "amount": "150",
  "currency": "USDT",
  "expiresAt": "2026-06-02T09:15:00.000Z",
  "created": true
}
```

**Побочный эффект:** при `created:true` Артур асинхронно (fire-and-forget) шлёт клиенту DM:

> 💳 Счёт на оплату: 150 USDT
>
> Оплатить через @wallet на аккаунт @Mag_88888888.
> После оплаты сумма автоматически зачислится.
> Order: logos-2026-05-30-0001

**Errors:**
- `400` — отсутствует обязательное поле
- `401` — невалидный/отсутствующий `X-Agent-Api-Key`
- `500` — внутренняя ошибка

### 3.2 `GET /api/v1/invoice/:id` — статус счёта

**Headers:** `X-Agent-Api-Key`

**Response 200:**
```json
{
  "id": 42,
  "orderId": "logos-2026-05-30-0001",
  "status": "PAID",
  "clientUsername": "example_user",
  "amount": "150",
  "currency": "USDT",
  "paidAt": "2026-05-30T09:22:00.000Z",
  "paymentId": 88,
  "expiresAt": "2026-06-02T09:15:00.000Z",
  "remindersSent": 1
}
```

Эндпоинт scoped по агенту: чужие счета → `404`.

### 3.3 `GET /api/v1/balance/:clientUsername` — оплаченные итоги

**Headers:** `X-Agent-Api-Key`

**Response 200:**
```json
{
  "clientUsername": "example_user",
  "balance": { "USDT": 200, "TON": 5 },
  "paidInvoices": 3
}
```

Сумма по валютам всех счетов в статусе `PAID`. `clientUsername` идёт ключом — счета РАЗНЫХ агентов одному юзеру суммируются (это фича: показывает общий вклад клиента).

---

## 4. Жизненный цикл счёта

```
PENDING ──(оплата матчится)──► PAID ──(webhook)──► «Логос»
   │
   ├─(+6ч, +24ч, +48ч от createdAt)─► reminderN DM клиенту
   │
   └─(+72ч от createdAt)─► EXPIRED
```

| Статус | Значение | Webhook? |
|---|---|---|
| `PENDING` | счёт выставлен, ждём оплаты | — |
| `PAID` | платёж смэтчен по `(clientUsername, amount, currency)` | ✓ `invoice.paid` |
| `EXPIRED` | прошло 72ч, оплата не пришла | (нет в v1) |
| `CANCELLED` | отменён вручную (endpoint в v1.1) | (нет в v1) |

**Матчинг платежа:** Артур ловит @wallet-уведомление с `username` отправителя, парсит сумму и валюту, ищет САМЫЙ СТАРЫЙ `PENDING` счёт с такими `(clientUsername, amount, currency)`. Если совпадение — переводит в `PAID`, шлёт webhook.

**Граничный кейс:** если у одного клиента два счёта на одинаковую сумму+валюту — закроется тот, что создан раньше. Для устранения двусмысленности «Логос» может варьировать сумму на копейки (`150.00` vs `150.01`) либо отслеживать порядок и не выставлять параллельных дубликатов.

---

## 5. Webhook от Wave Match → «Логос»

При смене статуса счёта на `PAID` Артур шлёт `POST` на `webhookUrl` агента.

**Headers:** `Content-Type: application/json`

**Body:**
```json
{
  "event": "invoice.paid",
  "orderId": "logos-2026-05-30-0001",
  "invoiceId": 42,
  "clientUsername": "example_user",
  "amount": "150",
  "currency": "USDT",
  "paymentId": 88,
  "paidAt": "2026-05-30T09:22:00.000Z"
}
```

**Ретраи:** 3 попытки с backoff `2s / 4s / 8s`.
- HTTP `2xx` → считаем доставленным
- HTTP `4xx` → НЕ ретраим (лог `non-retryable`)
- HTTP `5xx` / timeout (>8s) → следующая попытка
- После 3 фейлов → лог `GAVE UP`, ручной разбор у Романа

**Требования к «Логосу»:**
- Эндпоинт идемпотентен — один `invoiceId` могут доставить дважды на стыке ретраев
- Отвечает за ≤ 8 с (иначе timeout)
- Возвращает `200` ДО запуска долгой бизнес-логики (логику делать асинхронно)
- Хранит у себя `invoiceId` + `paymentId` для аудита

---

## 6. Безопасность

| Что | Как |
|---|---|
| Auth Логос → WM (запрос API) | Заголовок `X-Agent-Api-Key` |
| Auth WM → Логос (webhook) | v1: только знание `webhookUrl` (держать в секрете). v1.1 опционально: HMAC-подпись `X-Wave-Signature: sha256=<hex>` от тела + shared secret |
| Транспорт | HTTPS обязательно |
| Ротация ключа | Через Романа: новый `POST /admin/agents` → старый ключ инвалидировать (v1.1) |
| Утечка | При компрометации `apiKey` — немедленно сообщить @roman_arctur, ключ инвалидируется |

---

## 7. Что делает «Логос» (TODO на стороне Логоса)

1. **БД:** таблица-зеркало
   ```sql
   wm_invoices (
     id PRIMARY KEY,
     wm_invoice_id INTEGER UNIQUE NOT NULL,  -- = invoiceId из WM
     order_id TEXT NOT NULL,
     client_username TEXT NOT NULL,
     amount TEXT NOT NULL,
     currency TEXT NOT NULL,
     status TEXT NOT NULL,                   -- PENDING | PAID | EXPIRED
     created_at TIMESTAMP NOT NULL,
     paid_at TIMESTAMP NULL,
     wm_payment_id INTEGER NULL,
     metadata JSONB NULL
   )
   ```
2. **Сервис `WaveMatchClient`:** обёртка над 3 эндпоинтами + кеш `apiKey` в ENV.
3. **Эндпоинт `POST /webhooks/wave-match`:**
   - Idempotency-проверка по `invoiceId` (если уже `PAID` — сразу `200`)
   - Запись `wm_invoices.status = PAID`, `paid_at`, `wm_payment_id`
   - Триггер бизнес-логики (выдача доступа / нотификация и т.п.)
   - Ответ `200 {ok:true}` за <1 с
4. **Алёрты:**
   - Логос не получил webhook за `expiresAt - 24h` → human alert (вероятен EXPIRED-сценарий)
   - 3 подряд `5xx` от WM API → alert
   - Webhook пришёл на несуществующий `orderId` → alert + сохранить в дед-летер
5. **ENV-конфиг:**
   ```
   WAVE_MATCH_API_BASE=https://aiass-production.up.railway.app
   WAVE_MATCH_API_KEY=wak_<выдаст Роман>
   ```

---

## 8. Примеры

### 8.1 curl — выставить счёт

```bash
curl -X POST https://aiass-production.up.railway.app/api/v1/invoice \
  -H "X-Agent-Api-Key: $WAVE_MATCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "logos-2026-05-30-0001",
    "clientUsername": "@example_user",
    "amount": "150",
    "currency": "USDT"
  }'
```

### 8.2 curl — статус

```bash
curl https://aiass-production.up.railway.app/api/v1/invoice/42 \
  -H "X-Agent-Api-Key: $WAVE_MATCH_API_KEY"
```

### 8.3 TypeScript/Node — клиент

```ts
const BASE = process.env.WAVE_MATCH_API_BASE!;
const KEY  = process.env.WAVE_MATCH_API_KEY!;

export async function createInvoice(args: {
  orderId: string; clientUsername: string; amount: string; currency: string;
}) {
  const res = await fetch(`${BASE}/api/v1/invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Api-Key': KEY },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`WM invoice ${res.status}: ${await res.text()}`);
  return res.json();
}
```

### 8.4 Express — приёмник webhook'а

```ts
app.post('/webhooks/wave-match', express.json(), async (req, res) => {
  const { event, invoiceId, orderId, paymentId, paidAt } = req.body;
  // 1) Idempotency
  const exists = await db.wm_invoices.findOne({ wm_invoice_id: invoiceId });
  if (exists?.status === 'PAID') return res.json({ ok: true, already: true });
  // 2) Mark paid (fast path)
  await db.wm_invoices.update({ wm_invoice_id: invoiceId },
    { status: 'PAID', paid_at: paidAt, wm_payment_id: paymentId });
  res.json({ ok: true });        // <-- ОТВЕЧАЕМ СРАЗУ
  // 3) Бизнес-логика — в очередь
  jobQueue.enqueue('grantAccess', { orderId, invoiceId });
});
```

---

## 9. План тестирования

| # | Сценарий | Ожидание |
|---|---|---|
| 1 | Создать invoice на тест-юзера, оплатить через @wallet 0.01 USDT | `PAID` за <30 с, webhook доставлен |
| 2 | Повторный POST с тем же `orderId` | `created:false`, тот же `id` |
| 3 | Оплата другой суммой (не совпадает) | Счёт остаётся `PENDING`, отдельный платёж не привязывается |
| 4 | Webhook URL временно возвращает `500` | 3 ретрая с задержкой, потом `GAVE UP` |
| 5 | Webhook URL отвечает `200` после первого ретрая | Один `invoice.paid` дойдёт, idempotency сохранена |
| 6 | Не оплачивать 72 ч | `EXPIRED`, webhook'а нет |
| 7 | POST без `X-Agent-Api-Key` | `401` |
| 8 | POST с обязательным полем = пусто | `400` |
| 9 | GET чужого счёта (другой apiKey) | `404` |
| 10 | Два счёта на одного клиента на одинаковую сумму, одна оплата | Закроется самый старый |

---

## 10. Открытые вопросы / v1.1

- [ ] `POST /api/v1/invoice/:id/cancel` — отмена счёта со стороны агента
- [ ] HMAC-подпись webhook'а (`X-Wave-Signature: sha256=...`)
- [ ] Ротация `apiKey` без даунтайма
- [ ] Поле `metadata: {...}` в invoice, прокидывается в webhook
- [ ] Поддержка валют сверх списка из §3.1
- [ ] Webhook `invoice.expired` для авто-cleanup на стороне Логоса
- [ ] Sandbox-окружение
- [ ] Webhook `invoice.reminded` (опционально — чтобы Логос знал, что клиенту улетело напоминание)

---

## 11. Контакты

| Роль | Контакт |
|---|---|
| Product (WM) | @roman_arctur |
| Bot (источник DM и уведомлений) | @Mag_88888888 |
| Bug reports / incidents | DM Роману |
