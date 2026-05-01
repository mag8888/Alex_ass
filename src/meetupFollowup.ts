// ── Meetup follow-up scheduler ────────────────────────────────────────────
// Roman: каждый четверг online-встреча клуба со спикером. Низко-friction CTA
// для юзеров которые не отреагировали на welcome — спрашиваем темы для
// спикеров. Активирует пустые профили + собирает аудиторию для еженедельных
// митапов.
//
// Logic:
//   - Раз в 60 мин ищем юзеров где:
//     - lastBroadcastAt > 22 часов назад (welcome давно был)
//     - НЕТ user reply вообще (полная тишина)
//     - НЕ получали ещё meetup-инвайт
//   - Шлём через scenario wm_thursday_meetup_invite
//   - Помечаем `tags: ['meetup_invited']` чтобы не дёргать снова

import prisma from './db';
import { sendMessageToUser } from './actions';
import { applyGender } from './gender';

const TICK_MS = 60 * 60 * 1000;        // раз в час
const SILENT_HOURS = 22;                // 22ч молчания после welcome
const PER_TICK_CAP = 3;                 // не более 3 follow-up за тик

let timer: ReturnType<typeof setInterval> | null = null;
let lastTickAt: Date | null = null;
let totalSent = 0;

export function getMeetupFollowupStatus() {
    return { enabled: timer !== null, lastTickAt: lastTickAt?.toISOString() || null, totalSent, perTickCap: PER_TICK_CAP };
}

async function tick() {
    lastTickAt = new Date();
    const cutoff = new Date(Date.now() - SILENT_HOURS * 3600_000);

    // Получаем шаблон meetup
    const tpl = await prisma.template.findUnique({ where: { name: 'wm_thursday_meetup_invite' } });
    if (!tpl) {
        console.log('[meetup-followup] template not yet seeded — skipping');
        return;
    }

    // Кандидаты: получили welcome, но не ответили и не приглашались
    const candidates = await prisma.user.findMany({
        where: {
            lastBroadcastAt: { lt: cutoff },
            status: { notIn: ['BLOCKED', 'REJECTED'] },
            // Никаких user-сообщений в их диалогах
            dialogues: {
                some: {
                    messages: { none: { sender: 'USER' } },
                },
            },
        },
        take: PER_TICK_CAP * 5,  // overfetch — отфильтруем по тегу ниже
    });

    let sent = 0;
    for (const u of candidates) {
        if (sent >= PER_TICK_CAP) break;
        const tags = (u.tags as string[]) || [];
        if (Array.isArray(tags) && tags.includes('meetup_invited')) continue;

        const fn = (u.firstName || 'друг').split('|')[0].trim() || 'друг';
        const text = applyGender(tpl.content, u.gender).replace(/\{firstName\}/g, fn);
        try {
            await sendMessageToUser(u.id, text);
            await prisma.user.update({
                where: { id: u.id },
                data: { tags: [...tags, 'meetup_invited'] as any, lastBroadcastAt: new Date() },
            });
            sent++;
            totalSent++;
            console.log(`[meetup-followup] invited @${u.username || u.telegramId}`);
        } catch (e: any) {
            console.warn(`[meetup-followup] send fail @${u.username}: ${e.message}`);
        }
    }
}

export function startMeetupFollowupCron() {
    if (timer) return;
    setTimeout(() => tick().catch(e => console.error('[meetup-followup] err:', e)), 5 * 60 * 1000);
    timer = setInterval(() => tick().catch(e => console.error('[meetup-followup] err:', e)), TICK_MS);
    console.log(`[meetup-followup] started — every ${TICK_MS / 60000}m, after ${SILENT_HOURS}h silence, cap ${PER_TICK_CAP}/tick`);
}

export function stopMeetupFollowupCron() {
    if (timer) { clearInterval(timer); timer = null; }
}

export async function tickMeetupFollowupNow() {
    await tick();
    return getMeetupFollowupStatus();
}
