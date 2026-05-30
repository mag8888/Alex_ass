// ── Приём оплат через Telegram @wallet ─────────────────────────────────────
// Roman 2026-05-26: клиент платит через @wallet → приходит сообщение ЧЕРЕЗ
// @wallet (via-bot) вида «✅ Перевод криптовалюты: 1 USDT ~1.00 USD».
// Ловим, парсим, фиксируем платёж + уведомляем Романа И Алекса «оплата ✅».

import prisma from './db';
import { getClient } from './client';

// Кому слать уведомления об оплате — ФИКСИРОВАННО оба (с любого бота).
const PAY_NOTIFY = ['roman_arctur', 'alex_hardi1'];

/** Парсим сумму/валюту из текста @wallet. «1 USDT ~1.00 USD». */
function parseWalletText(text: string): { amount?: string; currency?: string; usd?: string } {
    const out: { amount?: string; currency?: string; usd?: string } = {};
    // «1 USDT» / «10.5 TON» / «1 000 USDT»
    const m = text.match(/([0-9][0-9\s.,]*)\s*(USDT|TON|BTC|ETH|NOT|USDC)\b/i);
    if (m) { out.amount = m[1].replace(/\s/g, '').replace(',', '.'); out.currency = m[2].toUpperCase(); }
    // «~1.00 USD»
    const u = text.match(/~?\s*([0-9][0-9\s.,]*)\s*USD\b/i);
    if (u) out.usd = u[1].replace(/\s/g, '').replace(',', '.');
    return out;
}

async function notifyBoth(text: string) {
    const client = getClient();
    if (!client || !client.connected) return;
    for (const target of PAY_NOTIFY) {
        try { await client.sendMessage(target, { message: text }); }
        catch (e: any) { console.warn(`[wallet] notify ${target} err:`, e.message); }
    }
}

export async function handleWalletNotification(text: string, botId: string, fromHandle = '') {
    console.log(`[wallet] payment (${botId}) from ${fromHandle}: ${text.replace(/\n/g, ' | ').slice(0, 200)}`);

    const p = parseWalletText(text);
    const sumLine = p.amount ? `${p.amount} ${p.currency || ''}${p.usd ? ` (~$${p.usd})` : ''}` : '(сумма не распозналась)';

    // Уведомление Роману + Алексу
    await notifyBoth(
        `💰 Оплата прошла ✅\n` +
        `Сумма: ${sumLine}\n` +
        (fromHandle ? `От: ${fromHandle}\n` : '') +
        `Бот: ${botId}`,
    );

    // Фиксация в БД + возврат id для линковки с Invoice
    let paymentId: number | null = null;
    try {
        const rows: any = await prisma.$queryRawUnsafe(
            `INSERT INTO "Payment" ("botId","amount","currency","fromUser","rawText","createdAt")
             VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP) RETURNING "id"`,
            botId, p.amount || null, p.currency || null, fromHandle || null, text.slice(0, 1000),
        );
        paymentId = rows?.[0]?.id ?? null;
        console.log('[wallet] платёж зафиксирован в БД, paymentId=', paymentId);
    } catch (e: any) { console.warn('[wallet] DB insert err:', e.message); }

    // Попытка связать с PENDING-счётом и дёрнуть webhook агенту
    if (paymentId && p.amount && p.currency && fromHandle) {
        try {
            const { matchPaymentToInvoice, onInvoicePaid } = await import('./invoicing');
            const inv = await matchPaymentToInvoice({
                paymentId, clientUsername: fromHandle, amount: p.amount, currency: p.currency,
            });
            if (inv) await onInvoicePaid(inv);
        } catch (e: any) { console.warn('[wallet] invoice match err:', e.message); }
    }
}
