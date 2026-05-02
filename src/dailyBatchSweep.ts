// ── Working-Hours Outreach Sweep ──────────────────────────────────────────
// Roman: "запуск рассылки в рабочее время с 9.00 мск до 21.00 мск".
// Непрерывный sweep во всё окно 9-21 МСК (= 06:00-18:00 UTC). Каждые 30 мин:
// берёт 2-3 свежих WM-юзера, шлёт персонализированный welcome (warm 1 msg,
// cold 3-burst), ставит autoReply=true. Дневной лимит 30 — равномерно
// распределяется по 12-часовому окну. Полностью серверный, не зависит от
// локального компа.

import prisma from './db';
import { listUsers, getUserByTelegramId, isWMEnabled } from './wmClient';
import { ensureUserAndDialogue, sendMessageToUser, sendMultipart } from './actions';
import { detectGender } from './gender';
import { notifyAdmin } from './notify';
import { enrichProfile } from './profileEnricher';
import { buildWelcomeMessages } from './welcomeBuilder';

// Окно: 9-21 МСК = 06:00-18:00 UTC (Москва UTC+3, без DST)
const WINDOW_START_UTC = 6;              // 09:00 МСК
const WINDOW_END_UTC = 18;               // 21:00 МСК (exclusive)
const TICK_MS = 30 * 60 * 1000;          // тик каждые 30 мин
const PER_TICK_TARGET = 2;               // 2 юзера/тик → 24 тика × 2 = 48 потолок
const DAILY_TARGET = 30;                 // дневной лимит (мягкий cap)
const PER_USER_PACE_MS = 30_000;         // 30 сек между юзерами в одном тике

let dailyKeyUTC = '';                    // YYYY-MM-DD текущего дня (UTC)
let dailySent = 0;                       // отправлено за день
let timer: ReturnType<typeof setInterval> | null = null;
let lastTickAt: Date | null = null;
let lastBatchSummary: string | null = null;
let totalSent = 0;                       // lifetime
let isRunning = false;
let paused = false;                      // ручной стоп для emergency

export function pauseDailyBatchSweep() { paused = true; }
export function resumeDailyBatchSweep() { paused = false; }

export interface DailyBatchStatus {
    enabled: boolean;
    windowStartMSK: number;
    windowEndMSK: number;
    dailyTarget: number;
    perTickTarget: number;
    tickMinutes: number;
    dailyKeyUTC: string;
    dailySent: number;
    workingNow: boolean;
    moscowHour: number;
    lastTickAt: string | null;
    lastBatchSummary: string | null;
    totalSent: number;
    isRunning: boolean;
}

function todayKeyUTC(): string {
    return new Date().toISOString().slice(0, 10);
}

function moscowHour(): number {
    const utcH = new Date().getUTCHours();
    return (utcH + 3) % 24;
}

function inWorkingWindow(): boolean {
    const utcH = new Date().getUTCHours();
    return utcH >= WINDOW_START_UTC && utcH < WINDOW_END_UTC;
}

function ensureDailyCounter() {
    const k = todayKeyUTC();
    if (k !== dailyKeyUTC) {
        dailyKeyUTC = k;
        dailySent = 0;
    }
}

export function getDailyBatchStatus(): DailyBatchStatus {
    ensureDailyCounter();
    return {
        enabled: timer !== null,
        windowStartMSK: WINDOW_START_UTC + 3,
        windowEndMSK: WINDOW_END_UTC + 3,
        dailyTarget: DAILY_TARGET,
        perTickTarget: PER_TICK_TARGET,
        tickMinutes: TICK_MS / 60000,
        dailyKeyUTC,
        dailySent,
        workingNow: inWorkingWindow(),
        moscowHour: moscowHour(),
        lastTickAt: lastTickAt?.toISOString() || null,
        lastBatchSummary,
        totalSent,
        isRunning,
    };
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

    const hasContact = await prisma.message.count({
        where: { dialogueId: dialogue.id, sender: { in: ['OPERATOR', 'SIMULATOR'] } },
    });
    if (hasContact > 0) return { ok: false, warm: false, reason: 'already contacted' };

    if (user.gender === 'UNKNOWN' && wm.firstName) {
        const g = detectGender(wm.firstName);
        if (g !== 'UNKNOWN') await prisma.user.update({ where: { id: user.id }, data: { gender: g } });
    }

    await prisma.user.update({
        where: { id: user.id },
        data: { autoReply: true, lastBroadcastAt: new Date() },
    });

    // ── 3-stage welcome (Принцип #17) ────────────────────────────────────
    let warm = false;
    try {
        // Передаём telegramId явно — WM API requires it
        const enriched = await enrichProfile(wm.username!, wm.telegramId || undefined);
        // Fallback: если WM по какой-то причине не отдал firstName, берём из
        // preloaded data (которая уже была в pickCandidates)
        if (!enriched.firstName && wm.firstName) enriched.firstName = wm.firstName;
        const msgs = buildWelcomeMessages(enriched);

        const facts = (user.facts as any) || {};
        if (msgs.hasEnrichment && msgs.cardBrief && msgs.cardFull) {
            facts.pendingCardBrief = msgs.cardBrief;
            facts.pendingCardFull = msgs.cardFull;
            if (msgs.cardGaps) facts.pendingCardGaps = msgs.cardGaps;
            warm = true;
            await prisma.user.update({
                where: { id: user.id },
                data: { facts: facts as any },
            });
        }

        await sendMessageToUser(user.id, msgs.stage1);
        return { ok: true, warm, uid: user.id, firstName: enriched.firstName || wm.firstName || undefined };
    } catch (e: any) {
        return { ok: false, warm: false, reason: `send fail: ${e.message}` };
    }
}

// Один тик: до PER_TICK_TARGET юзеров с пейсингом
async function runOneTick(force: boolean = false) {
    if (isRunning) {
        console.log('[ws] tick skip — already running');
        return;
    }
    ensureDailyCounter();

    if (!force) {
        if (paused) {
            lastBatchSummary = 'paused';
            return;
        }
        if (!inWorkingWindow()) {
            lastBatchSummary = `outside-window (msk=${moscowHour()}:00)`;
            return;
        }
        if (dailySent >= DAILY_TARGET) {
            lastBatchSummary = `daily-cap-${DAILY_TARGET}`;
            return;
        }
    }

    isRunning = true;
    lastTickAt = new Date();

    try {
        const remaining = Math.max(0, DAILY_TARGET - dailySent);
        const want = Math.min(PER_TICK_TARGET, remaining || PER_TICK_TARGET);
        const candidates = await pickCandidates(want);
        console.log(`[ws] tick candidates=${candidates.length} (want=${want}, sent today=${dailySent})`);

        if (candidates.length === 0) {
            lastBatchSummary = `no fresh (sent today=${dailySent}/${DAILY_TARGET})`;
            return;
        }

        const sentNames: string[] = [];
        const failNames: string[] = [];

        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            const r = await welcomeOne(c);
            if (r.ok) {
                dailySent++;
                totalSent++;
                sentNames.push(`@${c.username}`);
            } else {
                failNames.push(`@${c.username}: ${r.reason}`);
            }
            if (i < candidates.length - 1) {
                await new Promise(res => setTimeout(res, PER_USER_PACE_MS));
            }
        }

        lastBatchSummary = `tick: sent=${sentNames.length} fail=${failNames.length} | day=${dailySent}/${DAILY_TARGET}`;

        if (sentNames.length > 0) {
            await notifyAdmin(
                `📤 Outreach tick: +${sentNames.length} (${sentNames.join(', ')}). Сегодня ${dailySent}/${DAILY_TARGET}.`,
                { rateLimitKey: 'ws-tick-' + dailyKeyUTC + '-' + Math.floor(dailySent / 5) },
            );
        }
    } catch (e: any) {
        console.error('[ws] tick err:', e);
        lastBatchSummary = `error: ${e.message}`;
    } finally {
        isRunning = false;
    }
}

export function startDailyBatchSweep() {
    if (timer) return;
    if (!isWMEnabled()) {
        console.log('[ws] WM not configured — disabled');
        return;
    }
    dailyKeyUTC = todayKeyUTC();
    timer = setInterval(() => {
        runOneTick().catch(e => console.error('[ws] tick err:', e));
    }, TICK_MS);
    console.log(`[ws] started — every ${TICK_MS / 60000}m, window ${WINDOW_START_UTC + 3}-${WINDOW_END_UTC + 3} MSK, target ${DAILY_TARGET}/day, ${PER_TICK_TARGET}/tick`);
}

export function stopDailyBatchSweep() {
    if (timer) { clearInterval(timer); timer = null; }
}

export async function tickDailyBatchNow(): Promise<DailyBatchStatus> {
    await runOneTick(true);  // force = bypass window/cap (manual trigger)
    return getDailyBatchStatus();
}
