// ── Напоминания о созвонах ─────────────────────────────────────────────────
// Roman: уведомление при записи (в listener) + напоминание УТРОМ (сводка дня)
// и ЗА 15 МИН до встречи. Крон тикает раз в 2 мин. Запускается ТОЛЬКО на
// одном сервисе (arthur) — он видит все Meeting в общей БД и шлёт Роману,
// чтобы не было дублей.

import prisma from './db';
import { notifyAdmin } from './notify';
import { fmtMsk } from './booking';

const TICK_MS = 2 * 60 * 1000;
const MSK_OFFSET_MS = 3 * 3600_000;
const MORNING_MSK_HOUR = 9;     // утреннюю сводку шлём после 09:00 МСК

let handle: ReturnType<typeof setInterval> | null = null;

async function tick() {
    const now = Date.now();
    try {
        // ── За 15 мин до встречи ──
        const soon = await prisma.meeting.findMany({
            where: {
                status: { in: ['BOOKED', 'REMINDED_MORNING'] },
                reminded15: false,
                scheduledAt: { gt: new Date(now), lte: new Date(now + 16 * 60_000) },
            },
        });
        for (const m of soon) {
            await notifyAdmin(
                `⏰ Через 15 мин созвон!\n` +
                `${fmtMsk(m.scheduledAt)} (30 мин)\n` +
                `${m.clientName || ''} @${m.clientUsername || '—'}`,
                { rateLimitKey: `meet15-${m.id}` },
            );
            await prisma.meeting.update({ where: { id: m.id }, data: { reminded15: true, status: 'REMINDED_15' } });
            console.log(`[booking-reminder] 15-min reminder sent meetingId=${m.id}`);
        }

        // ── Утренняя сводка (после 09:00 МСК, один раз на встречу) ──
        const mskNow = new Date(now + MSK_OFFSET_MS);
        if (mskNow.getUTCHours() >= MORNING_MSK_HOUR) {
            // границы сегодняшнего дня по МСК → в UTC
            const startMskMs = Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate(), 0, 0, 0) - MSK_OFFSET_MS;
            const endMskMs = startMskMs + 86400_000;
            const todays = await prisma.meeting.findMany({
                where: {
                    status: { in: ['BOOKED'] },
                    remindedMorning: false,
                    scheduledAt: { gte: new Date(Math.max(startMskMs, now)), lt: new Date(endMskMs) },
                },
                orderBy: { scheduledAt: 'asc' },
            });
            if (todays.length > 0) {
                const lines = todays.map(m => `• ${fmtMsk(m.scheduledAt)} — ${m.clientName || ''} @${m.clientUsername || '—'}`).join('\n');
                await notifyAdmin(`☀️ Созвоны на сегодня (${todays.length}):\n${lines}`, { rateLimitKey: `meet-morning-${mskNow.getUTCDate()}` });
                await prisma.meeting.updateMany({
                    where: { id: { in: todays.map(m => m.id) } },
                    data: { remindedMorning: true, status: 'REMINDED_MORNING' },
                });
                console.log(`[booking-reminder] morning summary sent (${todays.length} meetings)`);
            }
        }
    } catch (e: any) {
        console.warn('[booking-reminder] tick err:', e.message);
    }
}

export function startBookingRemindersCron() {
    if (handle) return;
    handle = setInterval(() => { tick().catch(() => { }); }, TICK_MS);
    console.log('[booking-reminder] cron started (tick 2m)');
    tick().catch(() => { });  // первый прогон сразу
}
