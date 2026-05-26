// ── Напоминания: созвоны (Роману) + эфир (клиентам) ────────────────────────
// Roman:
//   CALL — созвон с Романом: уведомление при записи (listener) + утром
//          (сводка) + за 15 мин. Шлём РОМАНУ. Только на одном сервисе (arthur).
//   EFIR — участие клиента в эфире: утром + за 15 мин до эфира + ссылка.
//          Шлём КЛИЕНТУ через его же бота. Каждый сервис — свой botId.
// Крон тикает раз в 2 мин, запускается на ОБОИХ сервисах.

import prisma from './db';
import { notifyAdmin } from './notify';
import { sendMessageToUser } from './actions';
import { fmtMsk } from './booking';
import { persona } from './persona';
import { getActiveEfir } from './efir';

const TICK_MS = 2 * 60 * 1000;
const MSK_OFFSET_MS = 3 * 3600_000;
const MORNING_MSK_HOUR = 9;

let handle: ReturnType<typeof setInterval> | null = null;

function efirLinkLine(): string {
    const efir = getActiveEfir();
    return efir?.link ? `Ссылка: ${efir.link}` : 'Ссылку пришлю перед самым началом.';
}

async function tickCallReminders(now: number) {
    // Только arthur-сервис шлёт Роману (без дублей).
    if (!persona.runsOutreachCrons) return;

    const soon = await prisma.meeting.findMany({
        where: { kind: 'CALL', status: { in: ['BOOKED', 'REMINDED_MORNING'] }, reminded15: false,
            scheduledAt: { gt: new Date(now), lte: new Date(now + 16 * 60_000) } },
    });
    for (const m of soon) {
        await notifyAdmin(`⏰ Через 15 мин созвон!\n${fmtMsk(m.scheduledAt)} (30 мин)\n${m.clientName || ''} @${m.clientUsername || '—'}`,
            { rateLimitKey: `meet15-${m.id}` });
        await prisma.meeting.update({ where: { id: m.id }, data: { reminded15: true, status: 'REMINDED_15' } });
        console.log(`[reminder] CALL 15-min → Роману meetingId=${m.id}`);
    }

    const mskNow = new Date(now + MSK_OFFSET_MS);
    if (mskNow.getUTCHours() >= MORNING_MSK_HOUR) {
        const startMs = Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate(), 0, 0, 0) - MSK_OFFSET_MS;
        const endMs = startMs + 86400_000;
        const todays = await prisma.meeting.findMany({
            where: { kind: 'CALL', status: 'BOOKED', remindedMorning: false,
                scheduledAt: { gte: new Date(Math.max(startMs, now)), lt: new Date(endMs) } },
            orderBy: { scheduledAt: 'asc' },
        });
        if (todays.length > 0) {
            const lines = todays.map(m => `• ${fmtMsk(m.scheduledAt)} — ${m.clientName || ''} @${m.clientUsername || '—'}`).join('\n');
            await notifyAdmin(`☀️ Созвоны на сегодня (${todays.length}):\n${lines}`, { rateLimitKey: `meet-morning-${mskNow.getUTCDate()}` });
            await prisma.meeting.updateMany({ where: { id: { in: todays.map(m => m.id) } }, data: { remindedMorning: true, status: 'REMINDED_MORNING' } });
            console.log(`[reminder] CALL morning → Роману (${todays.length})`);
        }
    }
}

async function tickEfirReminders(now: number) {
    // Каждый сервис напоминает СВОИМ клиентам (botId = persona.botId).
    // За 15 мин до эфира.
    const soon = await prisma.meeting.findMany({
        where: { kind: 'EFIR', botId: persona.botId, status: { in: ['BOOKED', 'REMINDED_MORNING'] }, reminded15: false,
            scheduledAt: { gt: new Date(now - 60_000), lte: new Date(now + 16 * 60_000) } },
    });
    for (const m of soon) {
        try {
            await sendMessageToUser(m.userId, `Через 15 минут начинается эфир! ${efirLinkLine()}`);
            await prisma.meeting.update({ where: { id: m.id }, data: { reminded15: true, status: 'REMINDED_15' } });
            console.log(`[reminder] EFIR 15-min → клиенту @${m.clientUsername} (meetingId=${m.id})`);
        } catch (e: any) { console.warn(`[reminder] EFIR 15-min fail ${m.id}:`, e.message); }
    }

    // Утром в день эфира (после 09:00 МСК).
    const mskNow = new Date(now + MSK_OFFSET_MS);
    if (mskNow.getUTCHours() >= MORNING_MSK_HOUR) {
        const startMs = Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate(), 0, 0, 0) - MSK_OFFSET_MS;
        const endMs = startMs + 86400_000;
        const todays = await prisma.meeting.findMany({
            where: { kind: 'EFIR', botId: persona.botId, status: 'BOOKED', remindedMorning: false,
                scheduledAt: { gte: new Date(Math.max(startMs, now)), lt: new Date(endMs) } },
        });
        for (const m of todays) {
            try {
                await sendMessageToUser(m.userId, `Доброе утро! Сегодня эфир по ИИ — напомню за 15 минут до начала. ${efirLinkLine()}`);
                await prisma.meeting.update({ where: { id: m.id }, data: { remindedMorning: true, status: 'REMINDED_MORNING' } });
                console.log(`[reminder] EFIR morning → клиенту @${m.clientUsername} (meetingId=${m.id})`);
            } catch (e: any) { console.warn(`[reminder] EFIR morning fail ${m.id}:`, e.message); }
        }
    }
}

async function tick() {
    const now = Date.now();
    try { await tickCallReminders(now); } catch (e: any) { console.warn('[reminder] CALL err:', e.message); }
    try { await tickEfirReminders(now); } catch (e: any) { console.warn('[reminder] EFIR err:', e.message); }
}

export function startBookingRemindersCron() {
    if (handle) return;
    handle = setInterval(() => { tick().catch(() => { }); }, TICK_MS);
    console.log(`[reminder] cron started (tick 2m, persona=${persona.botId})`);
    tick().catch(() => { });
}
