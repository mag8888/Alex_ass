// ── Согласование черновиков реакцией ───────────────────────────────────────
// Roman 2026-05-26: бот шлёт черновик Роману в Telegram → Роман реагирует
// ⚡ (энергия) = отправить клиенту / 💩 (какашка) = переделать.
// Детектим реакцию (UpdateMessageReactions) ИЛИ ответ-сообщение ⚡/💩 (фолбэк).
// Хранилище in-memory (Роман реагирует быстро; не деплоим пока ждём).

import { getClient } from './client';
import { ensureUserAndDialogue, sendMessageToUser } from './actions';
import prisma from './db';

export interface PendingApproval {
    msgId: number;            // id сообщения-черновика, отправленного Роману
    targetUsername: string;
    targetFirstName: string;
    targetAccessHash?: string;
    text: string;            // что отправить клиенту при ⚡
    botId: string;
    registerEfir: boolean;
    createdAt: number;
}

const pending = new Map<number, PendingApproval>();

export function addPending(p: PendingApproval) { pending.set(p.msgId, p); }
export function getPending(msgId: number) { return pending.get(msgId); }
export function removePending(msgId: number) { pending.delete(msgId); }
export function latestPending(): PendingApproval | undefined {
    let best: PendingApproval | undefined;
    for (const p of pending.values()) if (!best || p.createdAt > best.createdAt) best = p;
    return best;
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
        removePending(p.msgId);
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
    addPending({
        msgId, targetUsername: args.targetUsername, targetFirstName: args.targetFirstName,
        targetAccessHash: args.targetAccessHash, text: args.text, botId: args.botId,
        registerEfir: args.registerEfir, createdAt: Date.now(),
    });
    console.log(`[approval] черновик для @${args.targetUsername} отправлен Роману (msgId=${msgId})`);
    return msgId;
}
