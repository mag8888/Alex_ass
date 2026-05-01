// ── New WM Users Scanner ──────────────────────────────────────────────────
// Roman: webhook user.created не всегда доходит → ловим новых WM-юзеров
// поллингом раз в 30 минут. Полностью автономно: enrich профиль, подбираем
// тон welcome под уровень профиля, ставим autoReply=true чтобы дальше
// диалог шёл сам без участия оператора.

import prisma from './db';
import { listUsers, getUserByTelegramId, isWMEnabled } from './wmClient';
import { ensureUserAndDialogue, sendMessageToUser, sendMultipart } from './actions';
import { detectGender } from './gender';
import { notifyAdmin } from './notify';

const TICK_MS = 30 * 60 * 1000;       // 30 минут
const LOOKBACK_MS = 7 * 24 * 3600_000; // первый запуск — за 7 дней
const PER_TICK_CAP = 5;                // не более 5 welcome за тик (чтобы не флудить)

let lastScannedAt: Date | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastResult: string | null = null;
let lastTickAt: Date | null = null;
let totalSent = 0;

export interface ScannerStatus {
    enabled: boolean;
    lastTickAt: string | null;
    lastScannedAt: string | null;
    lastResult: string | null;
    totalSent: number;
    perTickCap: number;
    tickMinutes: number;
}

export function getNewUsersScannerStatus(): ScannerStatus {
    return {
        enabled: timer !== null,
        lastTickAt: lastTickAt?.toISOString() || null,
        lastScannedAt: lastScannedAt?.toISOString() || null,
        lastResult,
        totalSent,
        perTickCap: PER_TICK_CAP,
        tickMinutes: TICK_MS / 60000,
    };
}

// ── Personalized welcome builder ────────────────────────────────────────────
// Если у юзера в WM-профиле есть role/industry/location — строим ОДНО
// персонализированное сообщение (как с @batyaro). Если профиль пуст — fallback
// на стандартный 3-burst multipart welcome ("персональный менеджер").

interface FullWMUser {
    id: string;
    telegramId: string | null;
    username: string | null;
    firstName: string | null;
    profile?: { role?: string; industry?: string; location?: string; completion?: number } | null;
}

function buildPersonalizedWelcome(wm: FullWMUser): { text: string; isMultipart: boolean } {
    const firstName = wm.firstName || 'друг';
    const role = wm.profile?.role?.trim() || null;
    const industry = wm.profile?.industry?.trim() || null;
    const location = wm.profile?.location?.trim() || null;

    // Какие факты можем упомянуть в "помню Вас по..."
    const facts: string[] = [];
    if (role) facts.push(role);
    if (industry && industry !== role) facts.push(industry);
    if (location) facts.push(location);

    if (facts.length > 0) {
        // ОДНО сообщение в стиле @batyaro
        const factsStr = facts.slice(0, 2).join(', ');
        return {
            isMultipart: false,
            text: `${firstName}, добрый день! Это Wave Match — помню Вас по регистрации, ${factsStr}. Какие сейчас актуальные задачи: ищете клиентов, партнёров или спецов под проект?`,
        };
    }

    // Профиль пуст → 3-burst "персональный менеджер" multipart
    return {
        isMultipart: true,
        text: [
            `${firstName}, добрый день! Вы регистрировались у нас в Wave Match — я Ваш персональный менеджер по нетворкингу.`,
            `Могу помочь с двумя вещами: оформить Вашу визитку для подбора партнёров и познакомить с нужными людьми из базы.`,
            `Расскажите коротко — что сейчас актуально: клиенты, партнёры или спецы под задачу? Можно голосом 🎙️`,
        ].join('\n---SPLIT---\n'),
    };
}

// ── Per-user welcome flow ───────────────────────────────────────────────────

async function welcomeNewUser(wm: FullWMUser): Promise<{ ok: boolean; reason?: string; userId?: number }> {
    if (!wm.telegramId) return { ok: false, reason: 'no telegramId' };
    if (!wm.username) return { ok: false, reason: 'no @username (cannot DM cold)' };

    // Создаём/находим юзера + диалог
    const { user, dialogue } = await ensureUserAndDialogue(
        wm.username,
        wm.firstName || wm.username,
        undefined,
        'INBOUND',
    );

    // Уже было касание? (любой OPERATOR/SIMULATOR message) — пропускаем
    const hasContact = await prisma.message.count({
        where: { dialogueId: dialogue.id, sender: { in: ['OPERATOR', 'SIMULATOR'] } },
    });
    if (hasContact > 0) return { ok: false, reason: 'already contacted' };

    // Включаем autoReply сразу — диалог дальше идёт автономно
    await prisma.user.update({
        where: { id: user.id },
        data: { autoReply: true, lastBroadcastAt: new Date() },
    });

    // Гендер из имени для будущих ответов
    if (user.gender === 'UNKNOWN' && wm.firstName) {
        const g = detectGender(wm.firstName);
        if (g !== 'UNKNOWN') {
            await prisma.user.update({ where: { id: user.id }, data: { gender: g } });
        }
    }

    const built = buildPersonalizedWelcome(wm);

    try {
        if (built.isMultipart) {
            const parts = built.text.split(/---SPLIT---/g).map(p => p.trim()).filter(Boolean);
            await sendMultipart(user.id, parts);
        } else {
            await sendMessageToUser(user.id, built.text);
        }
        return { ok: true, userId: user.id };
    } catch (e: any) {
        console.warn(`[new-users-scanner] send failed for ${wm.username}: ${e.message}`);
        return { ok: false, reason: `send failed: ${e.message}` };
    }
}

// ── Main tick ───────────────────────────────────────────────────────────────

async function tick() {
    lastTickAt = new Date();
    if (!isWMEnabled()) {
        lastResult = 'WM not configured';
        return;
    }

    const since = (lastScannedAt || new Date(Date.now() - LOOKBACK_MS)).toISOString();
    let page;
    try {
        page = await listUsers({ updatedSince: since, limit: 50 });
    } catch (e: any) {
        lastResult = `listUsers err: ${e.message}`;
        return;
    }

    const items = page.items || [];
    if (items.length === 0) {
        lastResult = 'no recent WM updates';
        lastScannedAt = new Date();
        return;
    }

    let processed = 0;
    let sent = 0;
    const skipped: string[] = [];
    const sentNames: string[] = [];

    for (const item of items) {
        if (sent >= PER_TICK_CAP) break;
        if (!item.telegramId) continue;

        // Уже в нашей БД с касанием — пропускаем
        const existing = await prisma.user.findFirst({
            where: { telegramId: item.telegramId },
            include: { dialogues: { include: { messages: { where: { sender: { in: ['OPERATOR', 'SIMULATOR'] } }, take: 1 } } } },
        });
        const hasContact = existing?.dialogues?.some(d => d.messages.length > 0);
        if (hasContact) continue;

        processed++;

        // Enrich: подтягиваем username + profile
        let full: any;
        try {
            full = await getUserByTelegramId(item.telegramId, 'profile');
        } catch (_) { /* skip */ }
        if (!full || !full.username) {
            skipped.push(`${item.telegramId} (no username)`);
            continue;
        }

        const result = await welcomeNewUser({
            id: full.id,
            telegramId: full.telegramId,
            username: full.username,
            firstName: full.firstName,
            profile: full.profile,
        });

        if (result.ok) {
            sent++;
            totalSent++;
            sentNames.push(`@${full.username}`);
        } else {
            skipped.push(`@${full.username}: ${result.reason}`);
        }
    }

    lastScannedAt = new Date();
    lastResult = `processed=${processed} sent=${sent} skipped=${skipped.length}`;

    if (sent > 0) {
        await notifyAdmin(
            `🆕 Welcome отправлен ${sent} новым WM-юзерам: ${sentNames.join(', ')}. autoReply=on, диалог пойдёт автономно.`,
            { rateLimitKey: 'new-users-batch' },
        );
    }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export function startNewUsersScanner() {
    if (timer) return;
    if (!isWMEnabled()) {
        console.log('[new-users-scanner] WM not configured — disabled');
        return;
    }
    // Первый запуск через 60 сек после старта (даём системе подняться)
    setTimeout(() => tick().catch(e => console.error('[new-users-scanner] tick err:', e)), 60_000);
    timer = setInterval(() => {
        tick().catch(e => console.error('[new-users-scanner] tick err:', e));
    }, TICK_MS);
    console.log(`[new-users-scanner] started — every ${TICK_MS / 60000}m, cap ${PER_TICK_CAP}/tick`);
}

export function stopNewUsersScanner() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

export async function tickNewUsersScannerNow() {
    await tick();
    return getNewUsersScannerStatus();
}
