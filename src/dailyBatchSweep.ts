// ── Daily Morning Batch Sweep ─────────────────────────────────────────────
// Roman: "завтра с 10.00 мск шлём, нужно выстроить так чтоб всё работало
// даже если отключить этот комп". Каждый день в 10:00 МСК (07:00 UTC) сервер
// сам берёт ~25 свежих WM-юзеров, шлёт персонализированный welcome
// (warm = 1 message, cold = 3-burst), ставит autoReply=true. Полностью
// серверная автономия — ничего не нужно с локального компа.

import prisma from './db';
import { listUsers, getUserByTelegramId, isWMEnabled } from './wmClient';
import { ensureUserAndDialogue, sendMessageToUser, sendMultipart } from './actions';
import { detectGender } from './gender';
import { notifyAdmin } from './notify';

const TARGET_HOUR_UTC = 7;              // 07:00 UTC = 10:00 МСК
const TICK_CHECK_MS = 5 * 60 * 1000;    // проверяем каждые 5 мин
const DAILY_TARGET = 25;                 // плановое количество приветствий/день
const PER_USER_PACE_MS = 60_000;        // 60 сек между каждой отправкой

let lastFiredKey = '';                   // 'YYYY-MM-DD' — даты последнего запуска
let timer: ReturnType<typeof setInterval> | null = null;
let lastTickAt: Date | null = null;
let lastBatchSummary: string | null = null;
let totalSent = 0;
let isRunning = false;

export interface DailyBatchStatus {
    enabled: boolean;
    targetHourUTC: number;
    targetHourMSK: number;
    dailyTarget: number;
    lastFiredKey: string;
    lastTickAt: string | null;
    lastBatchSummary: string | null;
    totalSent: number;
    isRunning: boolean;
}

export function getDailyBatchStatus(): DailyBatchStatus {
    return {
        enabled: timer !== null,
        targetHourUTC: TARGET_HOUR_UTC,
        targetHourMSK: TARGET_HOUR_UTC + 3,
        dailyTarget: DAILY_TARGET,
        lastFiredKey,
        lastTickAt: lastTickAt?.toISOString() || null,
        lastBatchSummary,
        totalSent,
        isRunning,
    };
}

function todayKeyUTC(): string {
    return new Date().toISOString().slice(0, 10);
}

interface FullWMUser {
    id: string;
    telegramId: string | null;
    username: string | null;
    firstName: string | null;
    profile?: { role?: string; industry?: string; location?: string; completion?: number } | null;
}

function cleanFirstName(raw: string | null): string {
    if (!raw) return 'друг';
    // Убираем эмодзи в начале / в конце, обрезаем по '|', берём первое слово
    let s = raw.split('|')[0].trim();
    s = s.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (!s || s.length > 30) return 'друг';
    return s;
}

function buildWelcome(wm: FullWMUser): { text: string; isMultipart: boolean; firstName: string } {
    const fn = cleanFirstName(wm.firstName);
    const facts: string[] = [];
    if (wm.profile?.role?.trim()) facts.push(wm.profile.role.trim());
    const industry = wm.profile?.industry?.trim();
    if (industry && industry !== wm.profile?.role) facts.push(industry);
    if (wm.profile?.location?.trim()) facts.push(wm.profile.location.trim());

    if (facts.length > 0) {
        const f2 = facts.slice(0, 2).join(', ');
        return {
            firstName: fn,
            isMultipart: false,
            text: `${fn}, добрый день! Это Wave Match — помню Вас по регистрации, ${f2}. Какие сейчас актуальные задачи: ищете клиентов, партнёров или спецов под проект?`,
        };
    }
    return {
        firstName: fn,
        isMultipart: true,
        text: [
            `${fn}, добрый день! Вы регистрировались у нас в Wave Match — я Ваш ассистент по нетворкингу.`,
            `Могу помочь с двумя вещами: оформить Вашу визитку для подбора партнёров и познакомить с нужными людьми из базы.`,
            `Расскажите коротко — что сейчас актуально: клиенты, партнёры или спецы под задачу? Можно голосом 🎙️`,
        ].join('\n---SPLIT---\n'),
    };
}

async function pickCandidates(target: number): Promise<FullWMUser[]> {
    if (!isWMEnabled()) return [];

    // Забираем большое окно (60 дней назад) и фильтруем
    const since = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    const page = await listUsers({ limit: 100, updatedSince: since });
    const items = page.items || [];

    // Уже контактированные (есть OPERATOR/SIMULATOR-сообщение в любом диалоге)
    const contactedIds = new Set<string>();
    const contactedUns = new Set<string>();
    const local = await prisma.user.findMany({
        where: {
            dialogues: {
                some: {
                    messages: { some: { sender: { in: ['OPERATOR', 'SIMULATOR'] } } },
                },
            },
        },
        select: { telegramId: true, username: true },
    });
    for (const u of local) {
        if (u.telegramId) contactedIds.add(u.telegramId);
        if (u.username) contactedUns.add(u.username.toLowerCase());
    }

    // Первый проход: дешёвый фильтр по telegramId
    const tgFreshIds = items
        .map((u: any) => u.telegramId)
        .filter((tg: string | null | undefined) => tg && !contactedIds.has(tg));

    // Enrichment: на лимит candidates делаем getUserByTelegramId
    const enriched: FullWMUser[] = [];
    for (const tg of tgFreshIds) {
        if (enriched.length >= target) break;
        try {
            const full: any = await getUserByTelegramId(tg!, 'profile');
            if (!full || !full.username) continue;
            if (contactedUns.has(full.username.toLowerCase())) continue;
            enriched.push({
                id: full.id,
                telegramId: full.telegramId,
                username: full.username,
                firstName: full.firstName,
                profile: full.profile || null,
            });
        } catch (_) { /* skip */ }
    }
    return enriched;
}

async function welcomeOne(wm: FullWMUser): Promise<{ ok: boolean; warm: boolean; reason?: string; uid?: number; firstName?: string }> {
    if (!wm.username) return { ok: false, warm: false, reason: 'no username' };

    const { user, dialogue } = await ensureUserAndDialogue(
        wm.username,
        wm.firstName || wm.username,
        undefined,
        'INBOUND',
    );

    // Skip if already contacted
    const hasContact = await prisma.message.count({
        where: { dialogueId: dialogue.id, sender: { in: ['OPERATOR', 'SIMULATOR'] } },
    });
    if (hasContact > 0) return { ok: false, warm: false, reason: 'already contacted' };

    // Гендер
    if (user.gender === 'UNKNOWN' && wm.firstName) {
        const g = detectGender(wm.firstName);
        if (g !== 'UNKNOWN') await prisma.user.update({ where: { id: user.id }, data: { gender: g } });
    }

    // autoReply=on — диалог дальше идёт автономно
    await prisma.user.update({
        where: { id: user.id },
        data: { autoReply: true, lastBroadcastAt: new Date() },
    });

    const built = buildWelcome(wm);
    try {
        if (built.isMultipart) {
            const parts = built.text.split(/---SPLIT---/g).map(p => p.trim()).filter(Boolean);
            await sendMultipart(user.id, parts);
        } else {
            await sendMessageToUser(user.id, built.text);
        }
        return { ok: true, warm: !built.isMultipart, uid: user.id, firstName: built.firstName };
    } catch (e: any) {
        return { ok: false, warm: false, reason: `send fail: ${e.message}` };
    }
}

async function runBatch() {
    if (isRunning) {
        console.log('[daily-batch] already running, skip');
        return;
    }
    isRunning = true;
    lastTickAt = new Date();
    const startedAt = Date.now();

    try {
        await notifyAdmin(`☀️ Утренний batch стартовал в ${new Date().toLocaleString('ru')}. План: ${DAILY_TARGET} приветствий с пейсингом 60с (~${Math.round(DAILY_TARGET * 60 / 60)} мин).`, { rateLimitKey: 'daily-batch-start' });

        const candidates = await pickCandidates(DAILY_TARGET);
        console.log(`[daily-batch] candidates: ${candidates.length}`);

        if (candidates.length === 0) {
            lastBatchSummary = 'no fresh candidates in WM';
            await notifyAdmin('⚠️ Утренний batch: нет свежих кандидатов в WM. Возможно нужно дождаться новых регистраций.', { rateLimitKey: 'daily-batch-empty' });
            return;
        }

        let warmOk = 0, coldOk = 0, fail = 0;
        const sentNames: string[] = [];
        const failNames: string[] = [];

        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            const r = await welcomeOne(c);
            if (r.ok) {
                if (r.warm) warmOk++; else coldOk++;
                totalSent++;
                sentNames.push(`@${c.username}`);
            } else {
                fail++;
                failNames.push(`@${c.username}: ${r.reason}`);
            }
            if (i < candidates.length - 1) {
                await new Promise(res => setTimeout(res, PER_USER_PACE_MS));
            }
        }

        const durMin = Math.round((Date.now() - startedAt) / 60_000);
        lastBatchSummary = `warm=${warmOk} cold=${coldOk} fail=${fail} (${durMin}m)`;

        await notifyAdmin(
            `✅ Утренний batch завершён за ${durMin} мин.\n\n` +
            `🟢 Warm (1 msg): ${warmOk}\n` +
            `🟡 Cold (3-burst): ${coldOk}\n` +
            `❌ Fail: ${fail}\n\n` +
            (sentNames.length > 0 ? `Отправлено: ${sentNames.join(', ')}\n` : '') +
            (failNames.length > 0 ? `Не доставлено: ${failNames.slice(0, 5).join(' | ')}` : ''),
            { rateLimitKey: 'daily-batch-done' },
        );
    } catch (e: any) {
        console.error('[daily-batch] err:', e);
        lastBatchSummary = `error: ${e.message}`;
        await notifyAdmin(`⚠️ Утренний batch упал: ${e.message}`, { rateLimitKey: 'daily-batch-err' });
    } finally {
        isRunning = false;
    }
}

function shouldFire(): boolean {
    const now = new Date();
    const key = todayKeyUTC();
    if (lastFiredKey === key) return false;
    return now.getUTCHours() === TARGET_HOUR_UTC;
}

async function tick() {
    if (shouldFire()) {
        lastFiredKey = todayKeyUTC();
        await runBatch();
    }
}

export function startDailyBatchSweep() {
    if (timer) return;
    if (!isWMEnabled()) {
        console.log('[daily-batch] WM not configured — disabled');
        return;
    }
    timer = setInterval(() => {
        tick().catch(e => console.error('[daily-batch] tick err:', e));
    }, TICK_CHECK_MS);
    console.log(`[daily-batch] started — fires daily at ${TARGET_HOUR_UTC}:00 UTC (= ${TARGET_HOUR_UTC + 3}:00 MSK), target ${DAILY_TARGET}/day`);
}

export function stopDailyBatchSweep() {
    if (timer) { clearInterval(timer); timer = null; }
}

export async function tickDailyBatchNow(): Promise<DailyBatchStatus> {
    await runBatch();
    return getDailyBatchStatus();
}
