import crypto from 'crypto';
import prisma from './db';
import { invalidateCache, addAiNote, type WMUser, type WMProfile } from './wmClient';
import { notifyAdmin } from './notify';
import { ensureUserAndDialogue, sendMessageToUser, createDraftMessage } from './actions';
import { generateResponse } from './gpt';
import { applyGender } from './gender';

const WEBHOOK_SECRET = process.env.WAVE_CONNECT_WEBHOOK_SECRET || process.env.WM_WEBHOOK_SECRET || '';
// REPLAY_WINDOW in SECONDS (matches Wave Match spec: X-WC-Timestamp is Unix seconds)
const REPLAY_WINDOW_SEC = (() => {
    const sec = Number(process.env.WAVE_CONNECT_WEBHOOK_REPLAY_WINDOW);
    if (Number.isFinite(sec) && sec > 0) return sec;
    const ms = Number(process.env.WM_WEBHOOK_REPLAY_WINDOW_MS);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
    return 300;
})();

const seenDeliveryIds = new Set<string>();
const SEEN_LIMIT = 1000;

function rememberDeliveryId(id: string) {
    if (seenDeliveryIds.size >= SEEN_LIMIT) {
        const it = seenDeliveryIds.values();
        for (let i = 0; i < 100; i++) seenDeliveryIds.delete(it.next().value!);
    }
    seenDeliveryIds.add(id);
}

// ── HMAC signature verification ──────────────────────────────────────────────

export function verifySignature(rawBody: string, signature: string, timestamp: string): { ok: boolean; reason?: string } {
    if (!WEBHOOK_SECRET) {
        return { ok: false, reason: 'WAVE_CONNECT_WEBHOOK_SECRET not configured on receiver' };
    }
    if (!signature || !timestamp) {
        return { ok: false, reason: 'missing signature or timestamp header' };
    }

    let ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed timestamp' };
    if (ts > 1e11) ts = Math.floor(ts / 1000); // graceful ms acceptance

    const nowSec = Math.floor(Date.now() / 1000);
    const skewSec = Math.abs(nowSec - ts);
    if (skewSec > REPLAY_WINDOW_SEC) {
        return { ok: false, reason: `timestamp skew ${skewSec}s > ${REPLAY_WINDOW_SEC}s` };
    }

    const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const expected = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');

    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'sig length mismatch' };
    return crypto.timingSafeEqual(a, b)
        ? { ok: true }
        : { ok: false, reason: 'signature mismatch' };
}

// ── Event envelope (matches deployed Wave Match shape, NOT canon 1.1.x) ─────

export interface WMEvent {
    /** Wave Match per-delivery UUID — taken from X-WC-Delivery header */
    deliveryId: string;
    /** Discriminator. */
    event: string;
    /** Wave Match sends this in the body. */
    createdAt?: string;
    /** Wrapped payload — shape varies by event type. */
    data: any;
}

export async function handleWMEvent(evt: WMEvent): Promise<{ ok: boolean; reason?: string }> {
    if (!evt.deliveryId) return { ok: false, reason: 'missing deliveryId' };

    if (seenDeliveryIds.has(evt.deliveryId)) {
        return { ok: true, reason: 'duplicate delivery (idempotent)' };
    }
    rememberDeliveryId(evt.deliveryId);

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

// ── Per-event handlers ──────────────────────────────────────────────────────
// Note: Wave Match sends data wrapped — `user.created.data = { user: User }`,
// `user.updated.data = { user, changedFields }`, `profile.updated.data =
// { userId, profile, isFirstTime? }`, etc.

async function onUserCreated(data: { user: WMUser }) {
    const u = data?.user;
    if (!u?.telegramId) return { ok: true, reason: 'no TG id, nothing to do' };

    const delayMs = Number(
        process.env.WAVE_CONNECT_WELCOME_DELAY_MS || process.env.WM_WELCOME_DELAY_MS || 7 * 60 * 1000,
    );
    setTimeout(() => sendWelcome(u).catch(e => console.error('[welcome] error:', e.message)), delayMs);
    return { ok: true };
}

async function sendWelcome(wm: WMUser) {
    if (!wm.telegramId) return;
    const { user, dialogue } = await ensureUserAndDialogue(
        wm.telegramId,
        wm.firstName || 'друг',
        undefined,
        'INBOUND',
    );

    // ── Gender-aware fallback ────────────────────────────────────────────
    // Used when the GPT call fails. Anchors with "ты регистрировался(-ась) у нас",
    // value in one breath, then ONE open question.
    const firstName = wm.firstName || 'друг';
    const fallbackTpl =
        `${firstName}, привет! ` +
        `{Ты регистрировался|Ты регистрировалась|Вы регистрировались} у нас в Wave Match — мы помогаем находить нужных людей под твои запросы.\n` +
        `Расскажи в двух словах: что сейчас актуально — клиенты, партнёры или спецы под задачу? Дальше я подберу подходящих людей из базы. Можно голосом 🎙️`;
    const fallbackText = applyGender(fallbackTpl, user.gender);

    // ── GPT instructions: explicit anti-spam framing ─────────────────────
    const customInstructions = [
        'CONTEXT: This is the FIRST outreach to a Wave Match user who just completed registration on the platform.',
        'The user has NOT messaged the bot before — they may be confused why a stranger is DM-ing them.',
        '',
        'CRITICAL: the message must NOT feel like cold spam. Required structure (2-4 short lines, in this order):',
        '1) "{firstName}, привет!" (no "Здравствуйте", no "Уважаемый")',
        `2) Anchor: explicitly remind them they REGISTERED on Wave Match. Use the correct gendered form: ${user.gender === 'FEMALE' ? '"ты регистрировалась у нас в Wave Match"' : user.gender === 'MALE' ? '"ты регистрировался у нас в Wave Match"' : '"вы регистрировались у нас в Wave Match"'}.`,
        '3) Value in one phrase: "помогаем найти нужных людей под твои запросы" (or natural variation).',
        '4) ONE open question: что сейчас актуально / какие запросы есть / нужны клиенты, партнёры, исполнители.',
        '5) End with a SOFT voice option: "можно голосом 🎙️" — never push.',
        '',
        'Keep it short (40-70 words). No corporate tone. No menus. No follow-up questions in the same message.',
    ].join('\n');

    const result = await generateResponse(
        [], // No history — this is the very first message
        'DISCOVERY',
        user,
        {},
        [],
        customInstructions,
        [],
    );

    const text = result?.reply || fallbackText;

    if (user.autoReply) {
        await sendMessageToUser(user.id, text);
    } else {
        await createDraftMessage(dialogue.id, text);
    }
    await notifyAdmin(`👋 Welcome для @${user.username || wm.telegramId}: ${user.autoReply ? 'отправлено' : 'черновик создан'}`);
}

async function onUserUpdated(data: { user: WMUser; changedFields?: string[] }) {
    const u = data?.user;
    if (!u) return { ok: false, reason: 'missing user in payload' };
    invalidateCache(u.id);
    if (u.telegramId) invalidateCache(u.telegramId);
    return { ok: true };
}

async function onProfileUpdated(data: { userId: string; profile: WMProfile; isFirstTime?: boolean }) {
    if (!data?.userId) return { ok: false, reason: 'missing userId' };
    invalidateCache(data.userId);
    return { ok: true };
}

async function onClubJoined(data: { userId: string; clubSlug: string; clubName?: string; role?: string }) {
    if (!data?.userId) return { ok: false, reason: 'missing userId' };
    await notifyAdmin(`🎉 Юзер ${data.userId} вступил в клуб ${data.clubSlug}${data.clubName ? ` (${data.clubName})` : ''}`, { silent: true });
    await addAiNote(data.userId, 'ai_dialog', `Клиент вступил в клуб ${data.clubSlug}`, { tags: ['club_join', data.clubSlug] });
    return { ok: true };
}

async function onClubLeft(data: { userId: string; clubSlug: string }) {
    if (!data?.userId) return { ok: false, reason: 'missing userId' };
    await addAiNote(data.userId, 'ai_churn_signal', `Покинул клуб ${data.clubSlug}`, { tags: ['club_left', data.clubSlug] });
    return { ok: true };
}

async function onSubscriptionChanged(data: { userId: string; from: string; to: string; effectiveAt?: string }) {
    if (!data?.userId) return { ok: false, reason: 'missing userId' };
    if (data.to === 'FREE' && data.from !== 'FREE') {
        await notifyAdmin(`📉 Юзер ${data.userId} даунгрейд: ${data.from} → ${data.to}`);
        await addAiNote(data.userId, 'ai_churn_signal', `Подписка понизилась с ${data.from} до ${data.to}`, { tags: ['churn', 'downgrade'] });
    } else if (data.from === 'FREE' && data.to !== 'FREE') {
        await notifyAdmin(`🎉 Юзер ${data.userId} апгрейд: ${data.from} → ${data.to}`);
    }
    return { ok: true };
}
