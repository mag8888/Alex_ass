// ── Booking: запись на созвон с Романом ────────────────────────────────────
// Roman 2026-05-26: если клиент хочет пообщаться с ЖИВЫМ человеком — бот
// предлагает свободные 30-мин слоты 13:00–17:00 МСК, бронит, уведомляет
// Романа + напоминает утром и за 15 мин до встречи.
//
// МСК = UTC+3. Слоты: 13:00,13:30,...,16:30 МСК (последний до 17:00) = 8/день.

import prisma from './db';

const MSK_OFFSET_H = 3;
const SLOT_START_MSK = 13;   // первый слот 13:00 МСК
const SLOT_END_MSK = 17;     // последний слот заканчивается в 17:00 → начала до 16:30
const SLOT_MIN = 30;
const DAYS_AHEAD = 7;        // на сколько дней вперёд предлагать

// Хочет живого человека / созвон / лично.
const LIVE_HUMAN_RE = new RegExp(
    [
        'жив\\p{L}*\\s+человек',
        'с\\s+\\P{L}*(человеком|менеджером|романом)',
        'поговорить\\s+\\P{L}*(лично|вживую|с\\s+кем)',
        'созвон', 'созвонит', 'голосом\\s+пообщат', 'на\\s+связь\\s+с',
        'можно\\s+\\P{L}*(позвонить|звонок|с\\s+кем)',
        'хочу\\s+\\P{L}*(пообщаться|поговорить)\\s+\\P{L}*(с\\s+человеком|лично|вживую)',
        'не\\s+с\\s+ботом', 'с\\s+реальным',
    ].join('|'),
    'iu',
);

export function detectLiveHumanRequest(text: string): boolean {
    return !!text && LIVE_HUMAN_RE.test(text);
}

export interface Slot { iso: string; label: string; }

/** Свободные слоты на ближайшие DAYS_AHEAD дней (исключая занятые). */
export async function getFreeSlots(limit = 12): Promise<Slot[]> {
    const now = Date.now();
    // занятые слоты (BOOKED/напомненные) на будущее
    const booked = await prisma.meeting.findMany({
        where: { scheduledAt: { gte: new Date(now) }, status: { in: ['BOOKED', 'REMINDED_MORNING', 'REMINDED_15'] } },
        select: { scheduledAt: true },
    });
    const bookedSet = new Set(booked.map(b => b.scheduledAt.getTime()));

    const slots: Slot[] = [];
    const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    for (let d = 0; d < DAYS_AHEAD && slots.length < limit; d++) {
        // дата в МСК
        const base = new Date(now + d * 86400_000);
        for (let h = SLOT_START_MSK; h < SLOT_END_MSK && slots.length < limit; h++) {
            for (const m of [0, SLOT_MIN]) {
                // UTC время начала слота: МСК - 3ч
                const utc = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h - MSK_OFFSET_H, m, 0, 0));
                if (utc.getTime() <= now + 30 * 60_000) continue;      // только будущее (+30мин буфер)
                if (bookedSet.has(utc.getTime())) continue;            // занят
                const mskDow = days[new Date(utc.getTime() + MSK_OFFSET_H * 3600_000).getUTCDay()];
                const dd = String(base.getUTCDate()).padStart(2, '0');
                const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
                const hh = String(h).padStart(2, '0');
                const mn = String(m).padStart(2, '0');
                slots.push({ iso: utc.toISOString(), label: `${dd}.${mm} (${mskDow}) ${hh}:${mn} МСК` });
                if (slots.length >= limit) break;
            }
        }
    }
    return slots;
}

/** Создать бронь созвона (CALL — напоминаем Роману) + вернуть запись. */
export async function createMeeting(args: {
    userId: number; dialogueId?: number; botId: string; scheduledAtISO: string;
    clientUsername?: string | null; clientName?: string | null;
}) {
    return prisma.meeting.create({
        data: {
            userId: args.userId,
            dialogueId: args.dialogueId ?? null,
            botId: args.botId,
            kind: 'CALL',
            scheduledAt: new Date(args.scheduledAtISO),
            clientUsername: args.clientUsername ?? null,
            clientName: args.clientName ?? null,
        },
    });
}

/** Зарегистрировать клиента на ЭФИР (EFIR — напоминаем КЛИЕНТУ).
 *  Дедуп: не плодим записи если уже зарегистрирован на тот же старт. */
export async function registerEfirAttendee(args: {
    userId: number; dialogueId?: number; botId: string; efirStartISO: string;
    clientUsername?: string | null; clientName?: string | null;
}) {
    const when = new Date(args.efirStartISO);
    const exists = await prisma.meeting.findFirst({
        where: { userId: args.userId, kind: 'EFIR', scheduledAt: when, status: { not: 'CANCELLED' } },
    });
    if (exists) return exists;
    return prisma.meeting.create({
        data: {
            userId: args.userId,
            dialogueId: args.dialogueId ?? null,
            botId: args.botId,
            kind: 'EFIR',
            scheduledAt: when,
            clientUsername: args.clientUsername ?? null,
            clientName: args.clientName ?? null,
        },
    });
}

/** МСК-строка для уведомлений. */
export function fmtMsk(d: Date): string {
    const msk = new Date(d.getTime() + MSK_OFFSET_H * 3600_000);
    const dd = String(msk.getUTCDate()).padStart(2, '0');
    const mm = String(msk.getUTCMonth() + 1).padStart(2, '0');
    const hh = String(msk.getUTCHours()).padStart(2, '0');
    const mn = String(msk.getUTCMinutes()).padStart(2, '0');
    return `${dd}.${mm} ${hh}:${mn} МСК`;
}

/** Гайд для GPT: предложить слоты и при подтверждении вернуть bookingSlotISO. */
export function buildBookingPrompt(slots: Slot[]): string {
    if (slots.length === 0) {
        return [
            '=== ЗАПИСЬ НА СОЗВОН ===',
            'Человек хочет поговорить с живым человеком (Роман). Свободных слотов сейчас нет — скажи что передашь Роману и он свяжется.',
        ].join('\n');
    }
    const list = slots.slice(0, 8).map((s, i) => `${i + 1}. ${s.label}  [iso:${s.iso}]`).join('\n');
    return [
        '=== ЗАПИСЬ НА СОЗВОН С РОМАНОМ ===',
        'Человек хочет пообщаться с живым человеком. Предложи 2-4 ближайших слота (по 30 мин, Роман свободен 13:00–17:00 МСК) и попроси выбрать удобный. Не вываливай весь список — 2-4 варианта.',
        'Свободные слоты (НЕ показывай клиенту [iso:...], это для системы):',
        list,
        '',
        'КОГДА человек подтвердил конкретный слот — в JSON-ответе обязательно верни поле "bookingSlotISO" со значением iso выбранного слота (из списка выше). Это забронирует встречу. Подтверди клиенту человеческим текстом дату/время.',
        'Если клиент назвал время которого нет в списке — предложи ближайшее свободное.',
    ].join('\n');
}
