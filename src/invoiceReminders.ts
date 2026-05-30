// ── Cron напоминаний по неоплаченным счетам ────────────────────────────────
// Шлёт до 3 напоминаний клиенту: +6ч / +24ч / +48ч после создания счёта.
// После 72ч (expiresAt) помечает EXPIRED. Запускается на Артуре (счета идут
// через него). Тик раз в 5 мин.

import prisma from './db';
import { sendInvoiceReminder } from './invoicing';

const TICK_MS = 5 * 60 * 1000;
const REMINDER_OFFSETS_MS = [6 * 3600_000, 24 * 3600_000, 48 * 3600_000];

let handle: ReturnType<typeof setInterval> | null = null;

async function tick() {
    const now = Date.now();
    try {
        // 1) EXPIRE по истечении срока
        const expired = await prisma.invoice.updateMany({
            where: { status: 'PENDING', expiresAt: { lt: new Date(now) } },
            data: { status: 'EXPIRED' },
        });
        if (expired.count > 0) console.log(`[invoice-cron] EXPIRED ${expired.count} счетов (72ч)`);

        // 2) Напоминания: ищем PENDING где remindersSent < expected
        const pending = await prisma.invoice.findMany({
            where: { status: 'PENDING', expiresAt: { gt: new Date(now) } },
            orderBy: { createdAt: 'asc' },
            take: 200,
        });
        for (const inv of pending) {
            const ageMs = now - inv.createdAt.getTime();
            // Сколько напоминаний должно было уйти на этот момент
            let expected = 0;
            for (const off of REMINDER_OFFSETS_MS) if (ageMs >= off) expected++;
            if (expected > inv.remindersSent && inv.remindersSent < 3) {
                const nextN = inv.remindersSent + 1;
                await sendInvoiceReminder(inv, nextN);
            }
        }
    } catch (e: any) {
        console.warn('[invoice-cron] tick err:', e.message);
    }
}

export function startInvoiceRemindersCron() {
    if (handle) return;
    handle = setInterval(() => { tick().catch(() => { }); }, TICK_MS);
    console.log('[invoice-cron] started (tick 5m)');
    tick().catch(() => { });
}
