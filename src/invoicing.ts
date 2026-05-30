// ── Биллинг через @wallet Артура (модель A) ────────────────────────────────
// Внешний агент дёргает наш API → создаём Invoice + Артур шлёт клиенту DM
// «оплати через @wallet». Клиент платит → @wallet-детектор ловит → матчим
// платёж к Invoice по (clientUsername+amount+currency) → webhook агенту +
// уведомление Романа/Алекса. Деньги остаются на @wallet Артура.

import crypto from 'crypto';
import prisma from './db';
import { ensureUserAndDialogue, sendMessageToUser } from './actions';

const INVOICE_EXPIRY_HOURS = 72;
const PAYMENT_RECEIVER_HANDLE = '@Mag_88888888'; // куда клиенту платить

/** Сгенерить безопасный API-ключ для агента. */
export function generateApiKey(): string {
    return 'wak_' + crypto.randomBytes(32).toString('hex');
}

/** Найти агента по API-ключу. */
export async function findAgentByApiKey(apiKey: string) {
    if (!apiKey) return null;
    return prisma.agent.findUnique({ where: { apiKey } });
}

/** Нормализовать username (без @, lowercase). */
export function normUsername(u: string): string {
    return (u || '').replace(/^@/, '').toLowerCase().trim();
}

/** Нормализовать сумму: уберём пробелы, запятую → точка. */
export function normAmount(a: string): string {
    return (a || '').toString().replace(/\s/g, '').replace(',', '.').trim();
}

/** Создать счёт (идемпотентно по agentId+orderId). */
export async function createInvoice(args: {
    agentId: number; orderId: string; clientUsername: string;
    amount: string; currency: string;
}) {
    const clientUsername = normUsername(args.clientUsername);
    const amount = normAmount(args.amount);
    const currency = (args.currency || '').toUpperCase().trim();

    // Идемпотентность: если такой (agentId, orderId) уже есть — вернуть его
    const existing = await prisma.invoice.findUnique({
        where: { agentId_orderId: { agentId: args.agentId, orderId: args.orderId } },
    });
    if (existing) return { invoice: existing, created: false };

    const expiresAt = new Date(Date.now() + INVOICE_EXPIRY_HOURS * 3600_000);
    const invoice = await prisma.invoice.create({
        data: {
            agentId: args.agentId, orderId: args.orderId, clientUsername,
            amount, currency, expiresAt,
        },
    });
    return { invoice, created: true };
}

/** Отправить клиенту DM-инструкцию по оплате (через бот). */
export async function sendInvoiceDM(invoice: any) {
    try {
        const { user } = await ensureUserAndDialogue(invoice.clientUsername, '', undefined, 'SCOUT');
        const text = [
            `💳 Счёт на оплату: ${invoice.amount} ${invoice.currency}`,
            '',
            `Оплатить через @wallet на аккаунт ${PAYMENT_RECEIVER_HANDLE}.`,
            'После оплаты сумма автоматически зачислится.',
            `Order: ${invoice.orderId}`,
        ].join('\n');
        await sendMessageToUser(user.id, text);
        console.log(`[invoice] DM послан @${invoice.clientUsername} (invoice #${invoice.id})`);
        return true;
    } catch (e: any) {
        console.warn(`[invoice] DM fail #${invoice.id}:`, e.message);
        return false;
    }
}

/** Отправить напоминание клиенту (n = 1..3). */
export async function sendInvoiceReminder(invoice: any, n: number) {
    try {
        const { user } = await ensureUserAndDialogue(invoice.clientUsername, '', undefined, 'SCOUT');
        const text = [
            `⏰ Напоминание (${n}/3): счёт на ${invoice.amount} ${invoice.currency} ждёт оплаты.`,
            `Оплатить через @wallet на ${PAYMENT_RECEIVER_HANDLE}.`,
            `Order: ${invoice.orderId}`,
        ].join('\n');
        await sendMessageToUser(user.id, text);
        await prisma.invoice.update({ where: { id: invoice.id }, data: { remindersSent: n } });
        console.log(`[invoice] reminder ${n}/3 → @${invoice.clientUsername} (#${invoice.id})`);
        return true;
    } catch (e: any) { console.warn(`[invoice] reminder fail #${invoice.id}:`, e.message); return false; }
}

/** Попытка связать платёж с PENDING-счётом клиента (совпадение amount+currency). */
export async function matchPaymentToInvoice(args: {
    paymentId: number; clientUsername: string; amount: string; currency: string;
}): Promise<any | null> {
    if (!args.clientUsername || !args.amount || !args.currency) return null;
    const client = normUsername(args.clientUsername);
    const amount = normAmount(args.amount);
    const currency = args.currency.toUpperCase();
    // Берём самый старый PENDING счёт под этого клиента с такой суммой+валютой
    const inv = await prisma.invoice.findFirst({
        where: { clientUsername: client, amount, currency, status: 'PENDING' },
        orderBy: { id: 'asc' },
    });
    if (!inv) return null;
    const updated = await prisma.invoice.update({
        where: { id: inv.id },
        data: { status: 'PAID', paidAt: new Date(), paymentId: args.paymentId },
    });
    console.log(`[invoice] matched payment #${args.paymentId} → invoice #${inv.id} (@${client}, ${amount} ${currency})`);
    return updated;
}

/** Отправить webhook агенту (ретрай 3 раза при 5xx/timeout). */
export async function fireWebhook(agent: any, payload: any) {
    if (!agent.webhookUrl) return;
    let attempt = 0;
    while (attempt < 3) {
        attempt++;
        try {
            const res = await fetch(agent.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(8000),
            });
            if (res.ok) { console.log(`[invoice-webhook] agent=${agent.id} delivered (attempt ${attempt})`); return; }
            if (res.status < 500) { console.warn(`[invoice-webhook] agent=${agent.id} non-retryable ${res.status}`); return; }
            console.warn(`[invoice-webhook] agent=${agent.id} ${res.status} (attempt ${attempt})`);
        } catch (e: any) {
            console.warn(`[invoice-webhook] agent=${agent.id} err (attempt ${attempt}):`, e.message);
        }
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt))); // 2s, 4s, 8s
    }
    console.error(`[invoice-webhook] agent=${agent.id} GAVE UP after 3 attempts`);
}

/** Полный пост-пэйментный флоу: апдейт invoice + webhook агенту. */
export async function onInvoicePaid(invoice: any) {
    const agent = await prisma.agent.findUnique({ where: { id: invoice.agentId } });
    if (!agent) return;
    await fireWebhook(agent, {
        event: 'invoice.paid',
        orderId: invoice.orderId,
        invoiceId: invoice.id,
        clientUsername: invoice.clientUsername,
        amount: invoice.amount,
        currency: invoice.currency,
        paymentId: invoice.paymentId,
        paidAt: invoice.paidAt?.toISOString(),
    });
}

/** Баланс клиента — сумма PAID-счетов в разбивке по валютам. */
export async function getClientBalance(clientUsername: string) {
    const client = normUsername(clientUsername);
    const paid = await prisma.invoice.findMany({
        where: { clientUsername: client, status: 'PAID' },
        select: { amount: true, currency: true },
    });
    const byCurrency: Record<string, number> = {};
    for (const p of paid) {
        const n = parseFloat(p.amount);
        if (Number.isFinite(n)) byCurrency[p.currency] = (byCurrency[p.currency] || 0) + n;
    }
    return { clientUsername: client, balance: byCurrency, paidInvoices: paid.length };
}
