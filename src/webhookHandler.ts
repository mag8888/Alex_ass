import crypto from 'crypto';
import prisma from './db';
import { invalidateCache, addNote } from './wmClient';
import { notifyAdmin } from './notify';
import { ensureUserAndDialogue, sendMessageToUser, createDraftMessage } from './actions';
import { generateResponse } from './gpt';
import { emitEvent } from './events';

const WEBHOOK_SECRET = process.env.WAVE_CONNECT_WEBHOOK_SECRET || process.env.WM_WEBHOOK_SECRET || '';
// REPLAY_WINDOW expressed in SECONDS (Wave Match team convention).
// Falls back to legacy MS env, then to 300s (5 min).
const REPLAY_WINDOW_MS = (() => {
    const sec = Number(process.env.WAVE_CONNECT_WEBHOOK_REPLAY_WINDOW);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
    const ms = Number(process.env.WM_WEBHOOK_REPLAY_WINDOW_MS);
    if (Number.isFinite(ms) && ms > 0) return ms;
    return 5 * 60 * 1000;
})();
const seenEventIds = new Set<string>();
const SEEN_LIMIT = 1000;

function rememberEventId(id: string) {
    if (seenEventIds.size >= SEEN_LIMIT) {
        // drop oldest 100 to keep memory bounded
        const it = seenEventIds.values();
        for (let i = 0; i < 100; i++) seenEventIds.delete(it.next().value!);
    }
    seenEventIds.add(id);
}

// ── HMAC signature verification ──────────────────────────────────────────────
// Wave Match sends:
//   X-WC-Signature: sha256=<hex>
//   X-WC-Timestamp: <unix epoch ms>
// HMAC payload = `${timestamp}.${rawBody}`

export function verifySignature(rawBody: string, signature: string, timestamp: string): { ok: boolean; reason?: string } {
    if (!WEBHOOK_SECRET) {
        return { ok: false, reason: 'WM_WEBHOOK_SECRET not configured on receiver' };
    }
    if (!signature || !timestamp) {
        return { ok: false, reason: 'missing signature or timestamp header' };
    }

    // Anti-replay: timestamp must be within REPLAY_WINDOW_MS
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed timestamp' };
    const skew = Math.abs(Date.now() - ts);
    if (skew > REPLAY_WINDOW_MS) return { ok: false, reason: `timestamp skew ${skew}ms > ${REPLAY_WINDOW_MS}ms` };

    const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const expected = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

    // timing-safe compare
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'sig length mismatch' };
    return crypto.timingSafeEqual(a, b)
        ? { ok: true }
        : { ok: false, reason: 'signature mismatch' };
}

// ── Event dispatcher ─────────────────────────────────────────────────────────

export interface WMEvent {
    eventId: string;
    event: string;
    occurredAt: string;
    data: any;
}

export async function handleWMEvent(evt: WMEvent): Promise<{ ok: boolean; reason?: string }> {
    if (!evt.eventId) return { ok: false, reason: 'missing eventId' };

    if (seenEventIds.has(evt.eventId)) {
        return { ok: true, reason: 'duplicate (idempotent)' };
    }
    rememberEventId(evt.eventId);

    try {
        switch (evt.event) {
            case 'user.created':         return await onUserCreated(evt.data);
            case 'user.updated':         return await onUserUpdated(evt.data);
            case 'profile.updated':      return await onProfileUpdated(evt.data);
            case 'club.joined':          return await onClubJoined(evt.data);
            case 'club.left':            return await onClubLeft(evt.data);
            case 'subscription.changed': return await onSubscriptionChanged(evt.data);
            default:
                console.log(`[wm-webhook] unknown event ${evt.event}, ignored`);
                return { ok: true, reason: 'unknown event' };
        }
    } catch (e: any) {
        console.error(`[wm-webhook] handler error for ${evt.event}:`, e.message);
        return { ok: false, reason: e.message };
    }
}

// ── Concrete event handlers ─────────────────────────────────────────────────

// 1) user.created — fresh registration on Wave Match.
//    React: send welcome scenario via Telegram after a 5-10 minute delay.
async function onUserCreated(data: { userId: string; telegramId?: string; firstName?: string; locale?: string }) {
    if (!data.telegramId) return { ok: true, reason: 'no TG id, nothing to do' };

    // Delay so it doesn't feel automated; default 7 min
    const delayMs = Number(process.env.WAVE_CONNECT_WELCOME_DELAY_MS || process.env.WM_WELCOME_DELAY_MS || 7 * 60 * 1000);
    setTimeout(() => sendWelcome(data).catch(e => console.error('[welcome] error:', e.message)), delayMs);
    return { ok: true };
}

async function sendWelcome(data: { userId: string; telegramId?: string; firstName?: string }) {
    if (!data.telegramId) return;
    const { user, dialogue } = await ensureUserAndDialogue(
        data.telegramId,
        data.firstName || 'друг',
        undefined,
        'INBOUND',
    );

    // Generate via GPT so the welcome stays in voice
    const result = await generateResponse(
        [{ sender: 'USER', text: '(новая регистрация на Wave Match — поприветствуй, спроси про текущие запросы)' }],
        'DISCOVERY',
        user,
        {},
        [],
        'Юзер только что зарегистрировался на Wave Match. Поприветствуй коротко (1-2 предложения), скажи что я Wave Match, и спроси одним открытым вопросом — какие сейчас актуальные запросы (клиенты, команда, партнёры). Можно намекнуть что отвечать удобно голосом.',
        [],
    );

    const text = result?.reply || `Привет, ${data.firstName || 'друг'}! Это Wave Match. Расскажи, какие у тебя сейчас актуальные запросы — может, нужны клиенты или партнёры? Можно голосом 🎙️`;

    // Auto-send if user has autoReply, otherwise create draft for operator review
    if (user.autoReply) {
        await sendMessageToUser(user.id, text);
    } else {
        await createDraftMessage(dialogue.id, text);
    }

    await notifyAdmin(`👋 Welcome к новому WM-юзеру @${user.username || data.telegramId}: ${user.autoReply ? 'отправлено' : 'черновик создан'}`);
}

async function onUserUpdated(data: { userId: string; telegramId?: string; changedFields?: string[] }) {
    if (data.userId) invalidateCache(data.userId);
    if (data.telegramId) invalidateCache(data.telegramId);
    return { ok: true };
}

async function onProfileUpdated(data: { userId: string; telegramId?: string; fields?: any }) {
    if (data.userId) invalidateCache(data.userId);
    if (data.telegramId) invalidateCache(data.telegramId);
    // Optionally pull our local copy in sync
    if (data.telegramId && data.fields) {
        try {
            const local = await prisma.user.findUnique({ where: { telegramId: data.telegramId } });
            if (local) {
                const safe: any = {};
                for (const k of ['city', 'activity', 'businessCard', 'bestClients', 'requests', 'hobbies', 'currentIncome', 'desiredIncome', 'networkingGoal']) {
                    if (data.fields[k] !== undefined) safe[k] = data.fields[k];
                }
                if (Object.keys(safe).length) await prisma.user.update({ where: { id: local.id }, data: safe });
            }
        } catch (_) { }
    }
    return { ok: true };
}

async function onClubJoined(data: { userId: string; telegramId?: string; clubSlug: string }) {
    if (!data.telegramId) return { ok: true };
    await notifyAdmin(`🎉 @${data.telegramId} вступил в клуб ${data.clubSlug} (Wave Match)`, { silent: true });
    if (data.userId) {
        await addNote(data.userId, 'ai_dialog', `Клиент вступил в клуб ${data.clubSlug}`, { tags: ['club_join', data.clubSlug] });
    }
    return { ok: true };
}

async function onClubLeft(data: { userId: string; clubSlug: string }) {
    if (data.userId) {
        await addNote(data.userId, 'ai_churn_signal', `Покинул клуб ${data.clubSlug}`, { tags: ['club_left', data.clubSlug] });
    }
    return { ok: true };
}

async function onSubscriptionChanged(data: { userId: string; telegramId?: string; oldTier: string; newTier: string; status: string }) {
    if (!data.telegramId) return { ok: true };

    if (data.status === 'CANCELLED') {
        await notifyAdmin(`📉 @${data.telegramId} отменил подписку (${data.oldTier} → CANCELLED)`);
        if (data.userId) {
            await addNote(data.userId, 'ai_churn_signal', `Подписка отменена (${data.oldTier} → CANCELLED)`, { tags: ['churn'] });
        }
    } else if (data.oldTier === 'FREE' && data.newTier !== 'FREE') {
        await notifyAdmin(`🎉 @${data.telegramId} апгрейдил подписку на ${data.newTier}`);
    }
    return { ok: true };
}
