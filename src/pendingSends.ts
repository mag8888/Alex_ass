// ── Pending auto-send queue ───────────────────────────────────────────────
// Roman: "пуш в личку с кнопкой 'отправить', если я не отвечаю — через 10 мин
// сам отправляй". Userbot не может ставить настоящие inline-buttons (только
// бот-аккаунты могут), но Telegram автоматически делает HTTPS-ссылки
// кликабельными — это close enough к кнопке.
//
// Lifecycle:
//   1. createDraftMessage() → enqueuePending(msgId, scheduledAt = now + 10m)
//      + notifyAdmin с двумя ссылками (✅ Send / ❌ Cancel)
//   2. tickPendingSends() (раз в 30с) — отправляет дрфaты со scheduledAt < now
//   3. GET /qa/send/:id   — мгновенная отправка + cancel pending
//   4. GET /qa/cancel/:id — отмена pending
//   5. Юзер autoReply=true → пропускаем enqueue (бот сам шлёт мгновенно)

import prisma from './db';
import { sendDraftMessage } from './actions';
import { notifyAdmin } from './notify';

const COUNTDOWN_MS = 10 * 60 * 1000;
const TICK_MS = 30_000;

interface Pending {
    msgId: number;
    dialogueId: number;
    scheduledAt: number;
    cancelled: boolean;
}

const queue = new Map<number, Pending>();
let tickHandle: ReturnType<typeof setInterval> | null = null;

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://aiass-production.up.railway.app';

export function enqueuePending(msgId: number, dialogueId: number) {
    queue.set(msgId, {
        msgId,
        dialogueId,
        scheduledAt: Date.now() + COUNTDOWN_MS,
        cancelled: false,
    });
}

export function cancelPending(msgId: number): boolean {
    const p = queue.get(msgId);
    if (!p) return false;
    p.cancelled = true;
    queue.delete(msgId);
    return true;
}

export function isPending(msgId: number): boolean {
    return queue.has(msgId);
}

export function getPendingStatus() {
    return Array.from(queue.values()).map(p => ({
        msgId: p.msgId,
        dialogueId: p.dialogueId,
        secondsLeft: Math.max(0, Math.round((p.scheduledAt - Date.now()) / 1000)),
    }));
}

// Build admin DM with two clickable links.
export function buildPendingNotification(args: {
    msgId: number;
    dialogueId: number;
    firstName: string | null;
    username: string | null;
    userText: string | null;          // последняя реплика юзера (для контекста)
    draftText: string;
}): string {
    const who = args.firstName ? `${args.firstName}` : '@' + (args.username || '?');
    const handle = args.username ? `@${args.username}` : `id${args.dialogueId}`;
    const lines: string[] = [];
    lines.push(`📝 ${who} (${handle}) — драфт через 10 мин уйдёт автоматом:`);
    if (args.userText) lines.push(`\n💬 «${args.userText.slice(0, 200)}»`);
    lines.push(`\n🤖 «${args.draftText}»`);
    lines.push('');
    lines.push(`✅ Отправить сразу: ${PUBLIC_BASE_URL}/qa/send/${args.msgId}`);
    lines.push(`❌ Отменить: ${PUBLIC_BASE_URL}/qa/cancel/${args.msgId}`);
    return lines.join('\n');
}

// Send admin DM right after enqueueing.
export async function notifyAdminAboutPending(msgId: number, dialogueId: number, draftText: string) {
    try {
        const dlg = await prisma.dialogue.findUnique({
            where: { id: dialogueId },
            include: {
                user: true,
                messages: { where: { sender: 'USER' }, orderBy: { id: 'desc' }, take: 1 },
            },
        });
        if (!dlg) return;
        const text = buildPendingNotification({
            msgId,
            dialogueId,
            firstName: dlg.user.firstName,
            username: dlg.user.username,
            userText: dlg.messages[0]?.text || null,
            draftText,
        });
        await notifyAdmin(text, { rateLimitKey: `pending-${msgId}` });
    } catch (e: any) {
        console.warn('[pending] notify error:', e.message);
    }
}

// Background tick — fires every 30s, sends due drafts.
async function tick() {
    const now = Date.now();
    for (const p of Array.from(queue.values())) {
        if (p.cancelled) {
            queue.delete(p.msgId);
            continue;
        }
        if (p.scheduledAt > now) continue;

        // Verify draft still exists & is still DRAFT (not already sent manually)
        const msg = await prisma.message.findUnique({ where: { id: p.msgId } });
        if (!msg || msg.status !== 'DRAFT') {
            queue.delete(p.msgId);
            continue;
        }

        try {
            await sendDraftMessage(null, p.msgId);
            await notifyAdmin(`⏱ Авто-отправлено (10 мин истекло): драфт #${p.msgId}`, { rateLimitKey: `pending-sent-${p.msgId}` });
        } catch (e: any) {
            console.error(`[pending] auto-send failed msg=${p.msgId}:`, e.message);
            await notifyAdmin(`⚠️ Не смог авто-отправить драфт #${p.msgId}: ${e.message}`, { rateLimitKey: `pending-fail-${p.msgId}` });
        }
        queue.delete(p.msgId);
    }
}

export function startPendingSendsTick() {
    if (tickHandle) return;
    tickHandle = setInterval(() => {
        tick().catch(e => console.error('[pending] tick error:', e));
    }, TICK_MS);
    console.log(`[pending] started — countdown ${COUNTDOWN_MS / 60000}m, tick ${TICK_MS / 1000}s`);
}

export function stopPendingSendsTick() {
    if (tickHandle) {
        clearInterval(tickHandle);
        tickHandle = null;
    }
}
