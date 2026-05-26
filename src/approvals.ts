// ── Согласование черновиков реакцией ───────────────────────────────────────
// Roman 2026-05-26: бот шлёт черновик Роману в Telegram → Роман реагирует
// ⚡ (энергия) = отправить клиенту / 💩 (какашка) = переделать.
// Детектим реакцию (UpdateMessageReactions) ИЛИ ответ-сообщение ⚡/💩 (фолбэк).
// Хранилище in-memory (Роман реагирует быстро; не деплоим пока ждём).

import { getClient } from './client';
import { ensureUserAndDialogue, sendMessageToUser } from './actions';
import prisma from './db';

export interface PendingApproval {
    msgId: number;            // id сообщения-черновика, отправленного Роману (= romanMsgId)
    targetUsername: string;
    targetFirstName: string;
    targetAccessHash?: string;
    text: string;            // что отправить клиенту при ⚡
    botId: string;
    registerEfir: boolean;
}

// Персистентно в БД (Approval) — переживает редеплои.
function rowToPending(r: any): PendingApproval {
    return {
        msgId: r.romanMsgId, targetUsername: r.targetUsername, targetFirstName: r.targetFirstName || '',
        targetAccessHash: r.targetAccessHash || undefined, text: r.text, botId: r.botId, registerEfir: r.registerEfir,
    };
}

export async function getPending(msgId: number): Promise<PendingApproval | undefined> {
    const r = await prisma.approval.findFirst({ where: { romanMsgId: msgId, status: 'PENDING' }, orderBy: { id: 'desc' } });
    return r ? rowToPending(r) : undefined;
}
export async function removePending(msgId: number, status: 'SENT' | 'REDO' = 'SENT') {
    await prisma.approval.updateMany({ where: { romanMsgId: msgId, status: 'PENDING' }, data: { status } }).catch(() => { });
}
export async function latestPending(): Promise<PendingApproval | undefined> {
    const r = await prisma.approval.findFirst({ where: { status: 'PENDING' }, orderBy: { id: 'desc' } });
    return r ? rowToPending(r) : undefined;
}

const ENERGY = ['⚡', '⚡️', '💪', '🔥', '👍', '🤝'];   // «энергия / ок» — отправить
const POOP = ['💩', '👎'];                              // «переделать»

export function classifyReaction(emoji: string): 'send' | 'redo' | null {
    if (!emoji) return null;
    if (ENERGY.includes(emoji)) return 'send';
    if (POOP.includes(emoji)) return 'redo';
    return null;
}

/** Отправить черновик клиенту (при ⚡) + опц. записать на эфир + уведомить Романа. */
export async function executeApprovalSend(p: PendingApproval, notify: (t: string) => Promise<void>) {
    try {
        const { user } = await ensureUserAndDialogue(p.targetUsername, p.targetFirstName || '', p.targetAccessHash, 'SCOUT');
        await sendMessageToUser(user.id, p.text);
        if (p.registerEfir) {
            try {
                const { getActiveEfir } = await import('./efir');
                const { registerEfirAttendee } = await import('./booking');
                const efir = getActiveEfir();
                if (efir?.startUTC && new Date(efir.startUTC).getTime() > Date.now()) {
                    await registerEfirAttendee({ userId: user.id, botId: p.botId, efirStartISO: efir.startUTC, clientUsername: p.targetUsername, clientName: p.targetFirstName });
                }
            } catch (_) { /* эфир-регистрация best-effort */ }
        }
        await notify(`✅ Отправил @${p.targetUsername}${p.registerEfir ? ' + записал на эфир-напоминания' : ''}.`);
        console.log(`[approval] ⚡ → отправлено @${p.targetUsername}`);
    } catch (e: any) {
        await notify(`⚠️ Не смог отправить @${p.targetUsername}: ${e.message}`);
        console.warn(`[approval] send err:`, e.message);
    } finally {
        await removePending(p.msgId, 'SENT');
    }
}

/** Отправить Роману черновик на согласование. Возвращает msgId. */
export async function sendDraftForApproval(args: {
    adminUsername: string;
    targetUsername: string; targetFirstName: string; targetAccessHash?: string;
    text: string; botId: string; registerEfir: boolean;
}): Promise<number | null> {
    const client = getClient();
    if (!client || !client.connected) return null;
    const body =
        `📝 Черновик для @${args.targetUsername}:\n\n` +
        `${args.text}\n\n` +
        `———\n⚡ — отправить ей · 💩 — переделать\n(можно реакцией на это сообщение или ответом ⚡/💩)`;
    const sent: any = await client.sendMessage(args.adminUsername, { message: body });
    const msgId = sent?.id;
    if (!msgId) return null;
    await prisma.approval.create({
        data: {
            romanMsgId: msgId, targetUsername: args.targetUsername, targetFirstName: args.targetFirstName || null,
            targetAccessHash: args.targetAccessHash || null, text: args.text, botId: args.botId,
            registerEfir: args.registerEfir, status: 'PENDING',
        },
    });
    console.log(`[approval] черновик для @${args.targetUsername} отправлен Роману (msgId=${msgId}) [persisted]`);
    return msgId;
}
