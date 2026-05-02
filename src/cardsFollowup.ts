// ── Cards Follow-up Cron ─────────────────────────────────────────────────
// Roman: "если человек посмотрел визитки и ничего не ответил через 30 минут
// нужно отправить сообщение: подскажите какие люди вам сейчас нужны? я могу
// им отправить вашу визитку".
//
// Logic:
//   - Каждые 5 мин ищем юзеров где:
//     * facts.cardsDeliveredAt существует и старше 30 мин
//     * нет USER-сообщений после cardsDeliveredAt
//     * facts.cardsFollowupSent != true (одноразово)
//   - Отправляем re-engagement message (через sendMessageToUser → typing UX)
//   - Метим facts.cardsFollowupSent = true

import prisma from './db';
import { sendMessageToUser } from './actions';

const TICK_MS = 5 * 60 * 1000;            // каждые 5 мин
const SILENCE_THRESHOLD_MS = 30 * 60 * 1000; // 30 минут тишины
const PER_TICK_CAP = 5;

const FOLLOWUP_TEXT = 'Подскажите, какие люди Вам сейчас нужны? Могу им отправить Вашу визитку.';

let timer: ReturnType<typeof setInterval> | null = null;
let lastTickAt: Date | null = null;
let totalSent = 0;

export function getCardsFollowupStatus() {
    return {
        enabled: timer !== null,
        lastTickAt: lastTickAt?.toISOString() || null,
        totalSent,
        silenceMinutes: SILENCE_THRESHOLD_MS / 60_000,
        tickMinutes: TICK_MS / 60_000,
        perTickCap: PER_TICK_CAP,
    };
}

async function tick() {
    lastTickAt = new Date();
    const cutoff = new Date(Date.now() - SILENCE_THRESHOLD_MS);

    // Кандидаты: facts.cardsDeliveredAt < cutoff, cardsFollowupSent != true
    // Prisma не ищет по JSON напрямую; берём всех autoReply-юзеров с непустым facts
    // и фильтруем на месте.
    const candidates = await prisma.user.findMany({
        where: {
            status: { notIn: ['BLOCKED', 'REJECTED'] },
            facts: { not: null as any },
        },
        include: {
            dialogues: {
                include: {
                    messages: {
                        where: { sender: 'USER' },
                        orderBy: { id: 'desc' },
                        take: 1,
                    },
                },
            },
        },
        take: 200,
    });

    let sent = 0;
    for (const u of candidates) {
        if (sent >= PER_TICK_CAP) break;
        const facts = (u.facts as any) || {};
        if (!facts.cardsDeliveredAt) continue;
        if (facts.cardsFollowupSent) continue;

        const deliveredAt = new Date(facts.cardsDeliveredAt);
        if (deliveredAt > cutoff) continue;  // ещё рано

        // Был ли user-ответ после доставки?
        const hasUserReplyAfter = u.dialogues.some(d =>
            d.messages.some(m => new Date(m.createdAt) > deliveredAt),
        );
        if (hasUserReplyAfter) {
            // Юзер уже ответил — followup не нужен, помечаем как «сделано»
            facts.cardsFollowupSent = true;
            await prisma.user.update({ where: { id: u.id }, data: { facts: facts as any } }).catch(() => { });
            continue;
        }

        // Шлём follow-up
        try {
            await sendMessageToUser(u.id, FOLLOWUP_TEXT);
            facts.cardsFollowupSent = true;
            facts.cardsFollowupAt = new Date().toISOString();
            await prisma.user.update({ where: { id: u.id }, data: { facts: facts as any } });
            sent++;
            totalSent++;
            console.log(`[cards-followup] sent to @${u.username || u.telegramId}`);
        } catch (e: any) {
            console.warn(`[cards-followup] send fail @${u.username}: ${e.message}`);
        }
    }
}

export function startCardsFollowupCron() {
    if (timer) return;
    setTimeout(() => tick().catch(e => console.error('[cards-followup] err:', e)), 60_000);
    timer = setInterval(() => tick().catch(e => console.error('[cards-followup] err:', e)), TICK_MS);
    console.log(`[cards-followup] started — every ${TICK_MS / 60_000}m, threshold ${SILENCE_THRESHOLD_MS / 60_000}m`);
}

export function stopCardsFollowupCron() {
    if (timer) { clearInterval(timer); timer = null; }
}

export async function tickCardsFollowupNow() {
    await tick();
    return getCardsFollowupStatus();
}
