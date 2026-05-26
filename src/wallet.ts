// ── Приём оплат через Telegram @wallet ─────────────────────────────────────
// Roman 2026-05-26: клиент платит через @wallet на аккаунт бота → @wallet
// шлёт уведомление «вы получили X» → фиксируем платёж + уведомляем Романа и
// Алекса «оплата прошла ✅».
//
// Сначала ЗАХВАТ формата (форвардим полный текст Роману) — точные шаблоны
// @wallet увидим на тест-оплате, потом донастроим парсинг.

import prisma from './db';
import { notifyAdmin } from './notify';

// Попытка вытащить сумму + валюту + отправителя из текста уведомления @wallet.
// Шаблоны @wallet могут отличаться (RU/EN) — парсим по нескольким паттернам.
function parseWalletText(text: string): { amount?: string; currency?: string; from?: string } {
    const out: { amount?: string; currency?: string; from?: string } = {};
    // «10 USDT», «10.5 TON», «$10»
    const m = text.match(/([0-9][0-9\s.,]*)\s*(USDT|TON|BTC|ETH|USD|EUR|RUB|₽|\$)/i);
    if (m) { out.amount = m[1].replace(/\s/g, '').replace(',', '.'); out.currency = m[2].toUpperCase(); }
    // отправитель: @username или «от Имя»
    const u = text.match(/@([A-Za-z][A-Za-z0-9_]{3,31})/);
    if (u) out.from = '@' + u[1];
    return out;
}

export async function handleWalletNotification(text: string, botId: string) {
    console.log(`[wallet] notification (${botId}): ${text.replace(/\n/g, ' | ').slice(0, 300)}`);

    const parsed = parseWalletText(text);
    // Похоже на ВХОДЯЩУЮ оплату? (есть сумма + слова про получение)
    const looksIncoming = /получ|received|пополн|incoming|зачисл/i.test(text) && !!parsed.amount;

    // ЗАХВАТ: всегда форвардим Роману+Алексу полный текст, чтобы видеть формат
    // (notifyAdmin шлёт всем adminTargets текущей персоны).
    const head = looksIncoming ? '💰 Оплата через @wallet прошла ✅' : '🔔 @wallet уведомление';
    const sum = parsed.amount ? `\nСумма: ${parsed.amount} ${parsed.currency || ''}` : '';
    const from = parsed.from ? `\nОт: ${parsed.from}` : '';
    await notifyAdmin(`${head}${sum}${from}\n\n— текст —\n${text.slice(0, 500)}`, { rateLimitKey: `wallet-${Date.now()}` });

    // Фиксируем платёж в БД (best-effort) если похоже на входящую оплату
    if (looksIncoming) {
        try {
            await prisma.$executeRawUnsafe(
                `INSERT INTO "Payment" ("botId","amount","currency","fromUser","rawText","createdAt") VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)`,
                botId, parsed.amount || null, parsed.currency || null, parsed.from || null, text.slice(0, 1000),
            );
            console.log('[wallet] платёж зафиксирован в БД');
        } catch (e: any) { console.warn('[wallet] DB insert err:', e.message); }
    }
}
