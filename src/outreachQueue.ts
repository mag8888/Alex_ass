// ── Auto-outreach scheduler ────────────────────────────────────────────────
// Каждые 20 минут (в окне 10:00-22:00 Москва) шлёт DM одному новому юзеру
// из WM, которого мы ещё не контактировали (или контактировали > 7д назад).
//
// Hard-cap: 36/сутки (UTC midnight reset). Источник кандидатов — WM listUsers,
// фильтр по локальной БД (lastBroadcastAt). Выбирает шаблон round-robin.

import prisma from './db';
import { listUsers, isWMEnabled } from './wmClient';
import { sendBroadcast } from './broadcast';
import { ensureUserAndDialogue } from './actions';
import { detectGender } from './gender';
import { notifyAdmin } from './notify';

const TICK_MS = 20 * 60 * 1000;          // 20 минут
const DAILY_CAP = 36;                     // макс DM/сутки
const COOLDOWN_DAYS = 7;                  // не трогать контактированных < 7д
const WORK_HOUR_START = 10;               // 10:00 МСК
const WORK_HOUR_END = 22;                 // до 22:00 МСК (exclusive)
const MOSCOW_OFFSET_H = 3;                // UTC+3, без DST

// ── State (in-memory, reset on restart) ─────────────────────────────────────

let dailySent = 0;
let dailyKeyUTC = '';                     // 'YYYY-MM-DD' UTC, для авто-reset
let paused = false;                       // ручная пауза через /outreach-queue/pause
let lastTickAt: Date | null = null;
let lastResult: string | null = null;
let timerHandle: ReturnType<typeof setInterval> | null = null;

function todayKeyUTC(): string {
    return new Date().toISOString().slice(0, 10);
}

function ensureDailyCounter() {
    const k = todayKeyUTC();
    if (k !== dailyKeyUTC) {
        dailyKeyUTC = k;
        dailySent = 0;
    }
}

function isWorkingHourMoscow(): boolean {
    const utcH = new Date().getUTCHours();
    const mskH = (utcH + MOSCOW_OFFSET_H) % 24;
    return mskH >= WORK_HOUR_START && mskH < WORK_HOUR_END;
}

// ── Public status / control ─────────────────────────────────────────────────

export interface OutreachQueueStatus {
    enabled: boolean;
    paused: boolean;
    dailySent: number;
    dailyCap: number;
    dailyKeyUTC: string;
    workingNow: boolean;
    moscowHour: number;
    lastTickAt: string | null;
    lastResult: string | null;
    nextTickEstMs: number;
}

export function getOutreachQueueStatus(): OutreachQueueStatus {
    ensureDailyCounter();
    const utcH = new Date().getUTCHours();
    return {
        enabled: timerHandle !== null,
        paused,
        dailySent,
        dailyCap: DAILY_CAP,
        dailyKeyUTC,
        workingNow: isWorkingHourMoscow(),
        moscowHour: (utcH + MOSCOW_OFFSET_H) % 24,
        lastTickAt: lastTickAt?.toISOString() || null,
        lastResult,
        nextTickEstMs: TICK_MS,
    };
}

export function pauseOutreachQueue() { paused = true; }
export function resumeOutreachQueue() { paused = false; }

// ── Candidate selection ─────────────────────────────────────────────────────

interface Candidate {
    telegramId: string;
    username: string | null;
    firstName: string;
    wmUserId: string;
}

/**
 * Идём по WM-юзерам страницами; первый, у кого:
 *   • есть telegramId
 *   • в локальной БД отсутствует ИЛИ lastBroadcastAt > 7д назад
 *   • status не BLOCKED/REJECTED
 * Возвращаем кандидата.
 */
async function pickNextCandidate(): Promise<Candidate | null> {
    if (!isWMEnabled()) return null;

    const cutoff = new Date(Date.now() - COOLDOWN_DAYS * 86400_000);
    let cursor: string | undefined;
    let scanned = 0;
    const SCAN_BUDGET = 200;  // safety cap

    while (scanned < SCAN_BUDGET) {
        const page = await listUsers({ limit: 50, cursor });
        if (!page.items || page.items.length === 0) break;

        for (const wmUser of page.items) {
            scanned++;
            const tgId = wmUser.telegramId;
            if (!tgId) continue;

            // Проверим локально
            const local = await prisma.user.findFirst({
                where: { OR: [{ telegramId: tgId }, { username: tgId }] },
            });
            if (local) {
                if (local.status === 'BLOCKED' || local.status === 'REJECTED') continue;
                if (local.lastBroadcastAt && local.lastBroadcastAt > cutoff) continue;
            }

            // Можем ли мы вообще DM-нуть этого юзера?
            // Числовой telegramId БЕЗ accessHash → Telegram не сможет резолвить.
            // Пропускаем (попадёт обратно в очередь только если в WM появится @username
            // или мы где-то получим accessHash).
            const isNumeric = /^\d+$/.test(tgId);
            const hasAccessHash = !!local?.accessHash;
            if (isNumeric && !hasAccessHash) {
                console.log(`[outreach-queue] skip ${tgId} — numeric ID without accessHash`);
                // Зафиксируем попытку чтобы не циклиться: проставим lastBroadcastAt только
                // если локальная запись есть (если нет — на следующем тике не выберем
                // т.к. итерация идёт по WM-странице с тем же cursor=undefined → но WM
                // может вернуть других тоже; всё равно будем циклиться. Создаём stub:
                if (!local) {
                    await prisma.user.create({
                        data: {
                            telegramId: tgId,
                            firstName: wmUser.firstName || null,
                            lastBroadcastAt: new Date(),  // в cooldown сразу
                        },
                    }).catch(() => { });
                } else {
                    await prisma.user.update({
                        where: { id: local.id },
                        data: { lastBroadcastAt: new Date() },
                    }).catch(() => { });
                }
                continue;
            }

            const firstName = wmUser.firstName || (typeof tgId === 'string' ? tgId : 'друг');
            return {
                telegramId: tgId,
                username: tgId.startsWith('@') ? tgId.slice(1) : (typeof tgId === 'string' ? tgId : null),
                firstName,
                wmUserId: wmUser.id,
            };
        }

        cursor = page.nextCursor || undefined;
        if (!cursor) break;
    }

    return null;
}

// ── Template rotation: round-robin по выбранным сценариям ──────────────────

const ROTATION_NAMES = [
    'wm_welcome_after_registration',
    'wm_profile_assist',
    'wm_match_proposal',
    'wm_lead_qualified_followup',
    'wm_after_no_reply',
];

let rotationIdx = 0;

async function pickNextTemplateId(): Promise<number | null> {
    for (let attempt = 0; attempt < ROTATION_NAMES.length; attempt++) {
        const name = ROTATION_NAMES[(rotationIdx + attempt) % ROTATION_NAMES.length];
        const t = await prisma.template.findUnique({ where: { name } });
        if (t) {
            rotationIdx = (rotationIdx + attempt + 1) % ROTATION_NAMES.length;
            return t.id;
        }
    }
    // Fallback: первый попавшийся шаблон
    const any = await prisma.template.findFirst();
    return any?.id || null;
}

// ── Tick ────────────────────────────────────────────────────────────────────

export async function tickOutreachQueue(force = false): Promise<{ skipped?: string; sent?: { userId: number; templateId: number; firstName: string } }> {
    ensureDailyCounter();
    lastTickAt = new Date();

    if (paused && !force) {
        lastResult = 'paused';
        return { skipped: 'paused' };
    }
    if (!isWorkingHourMoscow() && !force) {
        lastResult = 'outside-working-hours';
        return { skipped: 'outside-working-hours' };
    }
    if (dailySent >= DAILY_CAP && !force) {
        lastResult = `daily-cap-${DAILY_CAP}`;
        return { skipped: `daily-cap-${DAILY_CAP}` };
    }

    const cand = await pickNextCandidate();
    if (!cand) {
        lastResult = 'no-eligible-candidate';
        return { skipped: 'no-eligible-candidate' };
    }

    // Создаём/находим локального юзера и диалог
    const username = cand.username || cand.telegramId;
    const { user, dialogue } = await ensureUserAndDialogue(
        username,
        cand.firstName,
        undefined,
        'INBOUND',
    );

    // Гендер если ещё неизвестен
    if (user.gender === 'UNKNOWN' && cand.firstName) {
        const g = detectGender(cand.firstName);
        if (g !== 'UNKNOWN') {
            await prisma.user.update({ where: { id: user.id }, data: { gender: g } });
        }
    }

    const templateId = await pickNextTemplateId();
    if (!templateId) {
        lastResult = 'no-template';
        return { skipped: 'no-template' };
    }

    const result = await sendBroadcast({
        templateId,
        userIds: [user.id],
        mode: 'auto',
        silent: true,  // sched сам пишет персональный notifyAdmin при успехе
    });

    if (result.sent > 0) {
        dailySent++;
        lastResult = `sent uid=${user.id} t=${templateId} (${dailySent}/${DAILY_CAP})`;
        await notifyAdmin(`📤 Auto-outreach: ${cand.firstName} (@${username}) — шаблон #${templateId}. ${dailySent}/${DAILY_CAP} сегодня.`);
        return { sent: { userId: user.id, templateId, firstName: cand.firstName } };
    } else {
        const errMsg = result.failed[0]?.error || 'unknown';
        lastResult = `failed: ${errMsg}`;
        console.warn(`[outreach-queue] send failed for uid=${user.id}: ${errMsg}`);
        // Cooldown тоже на фейле — иначе тот же юзер выпадет на следующем тике.
        await prisma.user.update({
            where: { id: user.id },
            data: { lastBroadcastAt: new Date() },
        }).catch(() => { });
        return { skipped: `send-failed: ${errMsg}` };
    }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export function startOutreachQueue() {
    if (timerHandle) return;
    if (!isWMEnabled()) {
        console.log('[outreach-queue] WM not configured — scheduler disabled');
        return;
    }
    dailyKeyUTC = todayKeyUTC();
    timerHandle = setInterval(() => {
        tickOutreachQueue().catch(e => console.error('[outreach-queue] tick error:', e));
    }, TICK_MS);
    console.log(`[outreach-queue] started — interval ${TICK_MS / 60000}m, cap ${DAILY_CAP}/day, hours ${WORK_HOUR_START}-${WORK_HOUR_END} MSK`);
}

export function stopOutreachQueue() {
    if (timerHandle) {
        clearInterval(timerHandle);
        timerHandle = null;
    }
}
