# TZ: Match Credits / Referrals / Subscriptions (Wave Match v1.4)

**Автор:** Wave Chat (`@Mag_88888888`) — для бек-команды Wave Match
**Версия:** 1.0 (draft)
**Цель:** ввести экономику матчей — каждому юзеру 10 бесплатных интро, дальше платно или через рефералов.

---

## 1. Бизнес-логика

| Сценарий | Эффект |
|---|---|
| Регистрация нового юзера | `matchCreditsRemaining = 10`, генерируется `referralCode` |
| Юзер согласился на интро ("да, познакомь") | `consume(-1)` у инициатора. Если у него 0 → 409 + paywall |
| Друг зарегался по `referralCode` | `+3` инвитеру (одноразово per друг) |
| Подписка $20 / мес | `+10` сразу + `+10` каждый месяц до отмены |
| Подписка $100 / мес | `+100` сразу + `+100` каждый месяц до отмены |
| Подписка `unlimited` (если нужна) | `consume` всегда `200`, без декремента |

**Когда списывается кредит:** только когда **юзер согласился** на конкретное интро ("да, познакомь Х"). Не списываем за предложение, не списываем за отказ.

---

## 2. Schema additions

Дополнить `User.profile` (или верхний уровень `User`, как удобнее WM):

```ts
{
  matchCreditsRemaining: number;     // default 10
  matchCreditsTotal: number;         // lifetime grants — для аналитики
  subscriptionTier: 'free' | 'basic' | 'pro' | 'unlimited';
  subscriptionUntil: string | null;  // ISO timestamp; null если free
  referralCode: string;              // e.g. "WM-A7K2", уникальный
  referredByCode: string | null;     // если зашёл по чужой ссылке
  referralsCount: number;            // сколько друзей привёл (для бейджа)
}
```

`subscriptionTier` enum:
- `free` — стартовый, 10 кредитов one-time
- `basic` — $20/мес → +10/мес
- `pro` — $100/мес → +100/мес
- `unlimited` — безлимит, `consume` не декрементит

---

## 3. Эндпоинты

### 3.1 `POST /api/wm/users/:id/credits/consume`
Атомарный декремент. Используется ботом когда юзер согласился на интро.

**Request:**
```json
{
  "reason": "intro_accepted",
  "matchedWithUserId": 208,
  "intentId": "wm-intro-202-208-2026-04-30"  // idempotency key
}
```

**Response 200:**
```json
{ "remaining": 9, "total": 10, "tier": "free" }
```

**Response 409 (нет кредитов и не unlimited):**
```json
{
  "error": "NO_CREDITS",
  "remaining": 0,
  "tier": "free",
  "paywall": {
    "subscribeUrl": "https://wavematch.app/subscribe?uid=...",
    "referralUrl": "https://wavematch.app/r/WM-A7K2"
  }
}
```

Idempotency: если `intentId` уже обработан — возвращаем тот же 200 без повторного декремента.

### 3.2 `POST /api/wm/users/:id/credits/grant`
Только server-to-server (наш бот ИЛИ платёжная система ИЛИ админ-CLI). Защищено HMAC.

```json
{
  "amount": 3,
  "reason": "referral" | "subscription_basic" | "subscription_pro" | "monthly_refill" | "manual" | "compensation",
  "metadata": { "referredUserId": 444 }   // для аудита
}
```
**Response 200:** `{ "remaining": 13, "total": 13 }`

### 3.3 `GET /api/wm/users/:id/credits`
Read-only, возвращает текущее состояние.
```json
{ "remaining": 9, "total": 10, "tier": "free", "until": null, "referralsCount": 0 }
```
Альтернатива: добавить эти поля в стандартный GET `/api/wm/users/:id?include=credits`.

### 3.4 `POST /api/wm/referral/redeem`
Вызывается при регистрации, если юзер пришёл по ссылке `wavematch.app/r/<code>`.

```json
{
  "newUserId": 444,
  "referralCode": "WM-A7K2"
}
```

**Логика на беке:**
1. Найти инвитера по `referralCode`.
2. Проверить что `newUser.referredByCode` ещё не установлен (нельзя дважды).
3. Записать `newUser.referredByCode = code`, увеличить `inviter.referralsCount + 1`.
4. Начислить инвитеру `+3` через `credits/grant` (`reason: 'referral'`).
5. Эмитнуть webhook `user.referral_redeemed`.

**Response 200:** `{ "inviterId": 123, "creditsGranted": 3 }`

### 3.5 Webhook events (новые)

Добавить к существующим:

| Event | Payload | Когда |
|---|---|---|
| `user.credits_depleted` | `{ userId, lastConsumeIntent }` | при достижении 0 |
| `user.subscription_started` | `{ userId, tier, until, amountUsd }` | после успешной оплаты |
| `user.subscription_cancelled` | `{ userId, effectiveUntil }` | отмена/неуспешный refill |
| `user.referral_redeemed` | `{ inviterId, newUserId, creditsGranted }` | новый friend зарегался |

Все — с тем же HMAC-SHA256 механизмом (`X-WC-Signature`, `X-WC-Timestamp`, `X-WC-Delivery`), что и текущие.

---

## 4. Подписочный flow (со стороны WM)

Когда платёж успешен (Stripe / PaySelection / etc.):
1. WM ставит `subscriptionTier = 'basic'|'pro'|'unlimited'`, `subscriptionUntil = now + 30d`.
2. Вызывает свой же `credits/grant` с правильным `amount` (10 или 100).
3. Эмитит webhook `user.subscription_started`.
4. Cron на WM (раз в сутки): для активных подписок где `subscriptionUntil > now` — выполняет monthly refill (если прошло 30д от последнего refill).

Бот (мы) — паблишит paywall ссылку. Сам процесс оплаты, веб-страница, чекаут — всё на стороне WM.

---

## 5. Paywall message (со стороны бота — для контекста)

Когда `consume` вернул 409, бот шлёт юзеру:

> Бесплатные 10 интро использованы — это была ваша десятая. Чтобы продолжить:
>
> 🎁 Пригласите друзей в Wave Match: за каждого зарегавшегося +3 интро.
> Ваша ссылка: https://wavematch.app/r/WM-A7K2
>
> 💎 Или подписка:
> • Basic — $20/мес = +10 интро/мес
> • Pro — $100/мес = +100 интро/мес
>
> Оформить: https://wavematch.app/subscribe?uid=123

`subscribeUrl` и `referralUrl` бот берёт из 409-ответа `paywall` блока — то есть генерация и подпись URL'ов остаётся на стороне WM (они могут включить токен/uid).

---

## 6. Открытые вопросы (нужны ответы от WM-команды)

1. **Кто хостит платёжную страницу?** Своё на wavematch.app или Stripe Checkout?
2. **Cancellation:** при отмене подписки — кредиты сгорают сразу или дотягивают до `subscriptionUntil`?
3. **Apple/Google in-app purchases:** релевантны для мобильного клиента WM или нет?
4. **Возврат / refund:** через WM-админку откатывает `grant`?
5. **Бот может ли вызвать `consume` с `reason='intro_accepted'` без оплаты?** Т.е. идём ли через credits всегда, или у нас есть "ручные" интро от оператора-человека (сейчас Roman сам ведёт некоторые диалоги).

---

## 7. Чеклист для бек-команды

- [ ] Schema migration: добавить 7 полей в `User`/`User.profile`
- [ ] `POST /credits/consume` (с idempotency)
- [ ] `POST /credits/grant` (HMAC-only)
- [ ] `GET /credits` (или `include=credits` в GET user)
- [ ] `POST /referral/redeem`
- [ ] Webhook'и: `credits_depleted`, `subscription_started`, `subscription_cancelled`, `referral_redeemed`
- [ ] Cron monthly refill для активных подписок
- [ ] Платёжная интеграция (Stripe/PaySelection)
- [ ] OpenAPI обновить до v1.4
- [ ] Уведомить нас (Wave Chat) о готовности — мы в течение 1-2 дней подключим на стороне бота

---

## 8. Бот-сторона (для справки)

После выкатки WM v1.4 мы подключим:

1. **OutreachQueue scheduler** — каждые 20 мин шлём DM новому юзеру из WM (просто `registered`, даже если профиль пуст). Эти outreach'и **не списывают кредиты** — это наш traffic, а не их интро.
2. **Match engine** — после каждого профильного апдейта (locale + interests + offer/need extracted) пересчитываем top-3 матча в локальной БД. Скоринг: offer↔need (вес 3) + hobby/interest overlap (вес 2) + city/country (вес 1).
3. **Intro proposal** — бот в диалоге: "У нас в базе есть Х, который ищет Y и предлагает Z. Хотите, познакомлю?". При "да" → `POST /credits/consume`. На 200 — шлём контакты обоим. На 409 — paywall message.

---

**ETA с нашей стороны:** 1-2 дня после готовности WM v1.4.
**Контакт:** @roman_arctur, @Mag_88888888.
