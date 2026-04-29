import { NewMessage } from "telegram/events";
import { Api } from "telegram";
import { getClient } from "./client";
import {
    ensureUserAndDialogue,
    saveMessageToDb,
    createDraftMessage,
    sendMessageToUser,
    upgradeStatusOnSend,
} from "./actions";
import { generateResponse } from "./gpt";
import { DialogueStage } from '@prisma/client';
import prisma from './db';
import { emitEvent } from './events';
import { notifyAdmin, notifyLeads, getAdminUsername, buildUserCard } from './notify';
import { isVoiceMessage, transcribeVoice } from './voice';
import { getUserByTelegramId, addAiNote, addCrmTag, isWMEnabled, WMUser } from './wmClient';

// ── Hot cache for Rules / KB / Triggers ──────────────────────────────────────
// Refresh every 30s so admin edits propagate without restart, but DB hits stay low.

interface ContextCache {
    rulesGlobal: string[];
    kbItems: { question: string; answer: string }[];
    triggers: { keyword: string; type: string }[];
    fetchedAt: number;
}

let _cache: ContextCache | null = null;
const CACHE_TTL_MS = 30_000;

async function getContext(): Promise<ContextCache> {
    const now = Date.now();
    if (_cache && now - _cache.fetchedAt < CACHE_TTL_MS) return _cache;

    const [rules, kbItems, triggers] = await Promise.all([
        prisma.rule.findMany({ where: { isGlobal: true, isActive: true } }),
        prisma.knowledgeItem.findMany(),
        prisma.ignoreTrigger.findMany(),
    ]);

    _cache = {
        rulesGlobal: rules.map(r => r.content),
        kbItems: kbItems.map(k => ({ question: k.question, answer: k.answer })),
        triggers: triggers.map(t => ({ keyword: t.keyword, type: t.type })),
        fetchedAt: now,
    };
    return _cache;
}

export function invalidateContextCache() {
    _cache = null;
}

// ── Fallback reply when AI fails ─────────────────────────────────────────────

const FALLBACK_REPLY = 'Спасибо за сообщение! Я скоро вернусь с ответом 🙏';

// ── Main listener ────────────────────────────────────────────────────────────

export async function startListener(_page?: any) {
    const client = getClient();
    if (!client) {
        console.error("[Listener] Client not initialized, cannot start");
        return;
    }

    console.log("[Listener] Starting GramJS event listener...");

    // ── Read receipts: when the recipient opens our chat, GramJS gets
    //    Api.UpdateReadHistoryOutbox with peer=PeerUser and maxId. We don't
    //    track Telegram message IDs locally, so we just flip every unread
    //    outbound message in that dialogue to readAt=now. Functionally:
    //    ✓  → ✓✓ once the recipient reads.
    client.addEventHandler(async (update: any) => {
        try {
            if (!update || update.className !== 'UpdateReadHistoryOutbox') return;
            const peer = update.peer;
            if (!peer || peer.className !== 'PeerUser') return;
            const tgUserId = String(peer.userId);
            const u = await prisma.user.findFirst({
                where: { OR: [{ telegramId: tgUserId }, { username: tgUserId }] },
                select: { id: true },
            });
            if (!u) return;
            const dlg = await prisma.dialogue.findFirst({
                where: { userId: u.id },
                orderBy: { updatedAt: 'desc' },
                select: { id: true },
            });
            if (!dlg) return;
            const result = await prisma.message.updateMany({
                where: {
                    dialogueId: dlg.id,
                    sender: { in: ['OPERATOR', 'SIMULATOR'] },
                    status: 'SENT',
                    readAt: null,
                },
                data: { readAt: new Date() },
            });
            if (result.count > 0) {
                console.log(`[Listener] Marked ${result.count} outbound messages as read in dialogue ${dlg.id}`);
                emitEvent({ type: 'dialogue:updated', dialogueId: dlg.id });
            }
        } catch (e: any) {
            console.error('[Listener] read-receipt handler error:', e.message);
        }
    });

    client.addEventHandler(async (event: any) => {
        const message = event.message;
        if (!message?.isPrivate) return;

        const sender = await message.getSender();
        if (!sender || sender.bot || message.out) return;

        const username = sender.username || sender.id.toString();
        const firstName = sender.firstName || "Unknown";
        let text = message.text || "";
        let isVoice = false;

        // Skip messages from admin themselves to avoid feedback loops with notifyAdmin.
        // Still mark as read so the admin sees the bot is alive (double tick).
        if (username.toLowerCase() === getAdminUsername().toLowerCase()) {
            try { await message.markAsRead(); } catch (_) { }
            console.log(`[Listener] Skipping message from admin @${username} (marked as read)`);
            return;
        }

        // ── Voice message → Whisper transcription ───────────────────────────
        if (isVoiceMessage(message)) {
            isVoice = true;
            console.log(`[Listener] Voice message from @${username}, downloading...`);
            try {
                const buf = await client.downloadMedia(message);
                if (buf && Buffer.isBuffer(buf)) {
                    // Last 5 messages of dialogue as Whisper hint (improves names/jargon)
                    const ctxMsgs = await prisma.message.findMany({
                        where: { dialogueId: { in: [] } }, // placeholder, filled below if dialogue exists
                        orderBy: { id: 'desc' }, take: 5,
                    }).catch(() => []);
                    const hint = ctxMsgs.map(m => m.text).join('\n');
                    const result = await transcribeVoice(buf, hint);
                    if (result?.text) {
                        text = result.text;
                        console.log(`[Listener] Voice transcribed (${result.durationMs}ms): ${text.substring(0, 100)}`);
                    } else {
                        text = '[голосовое сообщение, не удалось распознать]';
                    }
                } else {
                    text = '[голосовое сообщение]';
                }
            } catch (e: any) {
                console.error(`[Listener] Voice download/transcription error:`, e.message);
                text = '[голосовое сообщение, ошибка обработки]';
            }
        }

        if (!text) {
            console.log(`[Listener] Empty / unsupported message type from @${username} — ignored`);
            return;
        }

        console.log(`[Listener] New ${isVoice ? 'voice' : 'text'} message from @${username}: ${text.substring(0, 80)}`);

        const ctx = await getContext();

        // ── Ignore-trigger filter ────────────────────────────────────────────
        const shouldIgnore = ctx.triggers.some(t => {
            if (t.type === 'USERNAME') return username.toLowerCase() === t.keyword.toLowerCase();
            if (t.type === 'KEYWORD') return text.toLowerCase().includes(t.keyword.toLowerCase());
            return false;
        });
        if (shouldIgnore) {
            console.log(`[Listener] Ignored by trigger`);
            return;
        }

        // ── Mark as read ────────────────────────────────────────────────────
        try { await message.markAsRead(); } catch (_) { }

        // ── Save inbound message + ensure user/dialogue ─────────────────────
        const { user, dialogue } = await ensureUserAndDialogue(username, firstName, sender.accessHash?.toString());

        if (user.status === 'BLOCKED' || user.status === 'REJECTED') {
            console.log(`[Listener] Ignoring ${user.status} user @${username}`);
            return;
        }

        // Tag voice transcripts so admin sees the source in the UI
        const persistedText = isVoice ? `🎙️ ${text}` : text;
        await saveMessageToDb(dialogue.id, 'USER', persistedText, 'RECEIVED');
        emitEvent({ type: 'message:new', dialogueId: dialogue.id, userId: user.id, sender: 'USER', text: persistedText });

        // ── Notify lead channel about brand-new conversations once ─────────
        if (!user.notifiedNew) {
            const card = buildUserCard(user, { title: '👋 Новый человек написал' });
            await notifyLeads(`${card}\n\n«${text.substring(0, 200)}»`);
            await prisma.user.update({ where: { id: user.id }, data: { notifiedNew: true } });
        }

        // Forward LEAD messages so the channel sees the live thread
        const LEAD_STATUSES = ['LEAD', 'QUALIFIED', 'MATCHED', 'CUSTOMER'];
        if (LEAD_STATUSES.includes(user.status)) {
            await notifyLeads(`📩 ${user.firstName || username} ${user.gender === 'FEMALE' ? '♀' : user.gender === 'MALE' ? '♂' : ''} @${username}: ${text.substring(0, 300)}`, { silent: true });
        }

        // ── Auto-trigger QUALIFICATION onboarding for new users ─────────────
        // First inbound message → put dialogue into QUALIFICATION so the bot starts profiling.
        let currentStage = dialogue.stage as DialogueStage;
        const messageCount = await prisma.message.count({ where: { dialogueId: dialogue.id } });

        if (messageCount <= 1 && currentStage === 'DISCOVERY') {
            await prisma.dialogue.update({ where: { id: dialogue.id }, data: { stage: 'QUALIFICATION' } });
            currentStage = 'QUALIFICATION';
            console.log(`[Listener] Auto-promoted dialogue ${dialogue.id} to QUALIFICATION (first inbound)`);
        }

        // ── Pull Wave Match profile for context ────────────────────────────
        // WM Profile fields (role/industry/location/company/skills/hobbies) differ
        // from our internal extraction (city/activity/businessCard/...). We keep
        // our taxonomy locally; from WM we just absorb a few overlapping signals.
        let wmUser: WMUser | null = null;
        if (isWMEnabled()) {
            wmUser = await getUserByTelegramId(user.telegramId, 'profile');
            if (wmUser) {
                const p = wmUser.profile || {};
                const merge: any = {};
                // Only merge into LOCAL fields that are still empty.
                if (!user.city && p.location) merge.city = p.location;
                if (!user.activity && (p.role || p.industry)) {
                    merge.activity = [p.role, p.industry].filter(Boolean).join(' / ');
                }
                if (!user.hobbies && Array.isArray(p.hobbies) && p.hobbies.length > 0) {
                    merge.hobbies = p.hobbies.join(', ');
                }
                // Prefer WM's canonical firstName/lastName over local TG copy.
                // E.g. local "Alex" → WM "Александр" (user-supplied full name).
                if (wmUser.firstName && wmUser.firstName !== user.firstName) {
                    merge.firstName = wmUser.firstName;
                }
                if (wmUser.lastName && wmUser.lastName !== user.lastName) {
                    merge.lastName = wmUser.lastName;
                }
                if (Object.keys(merge).length > 0) {
                    await prisma.user.update({ where: { id: user.id }, data: merge });
                    Object.assign(user, merge);
                    console.log(`[wm] Absorbed from WM profile: ${Object.keys(merge).join(', ')}`);
                }
            }
        }

        // ── Per-user rules + history ────────────────────────────────────────
        const userRules = await prisma.rule.findMany({
            where: { userId: user.id, isActive: true },
        });
        const allRules = [...ctx.rulesGlobal, ...userRules.map(r => r.content)];

        const recentMessages = await prisma.message.findMany({
            where: { dialogueId: dialogue.id },
            orderBy: { id: 'desc' },
            take: 12,
        });
        const history = recentMessages.reverse().map(m => ({ sender: m.sender, text: m.text }));

        // ── Generate AI reply ───────────────────────────────────────────────
        console.log(`[GPT] Generating reply for @${username} (stage=${currentStage}, autoReply=${user.autoReply})`);
        const gptResult = await generateResponse(
            history,
            currentStage,
            user,
            {},
            ctx.kbItems,
            undefined,
            allRules,
        );

        // ── Failure path: fallback + alert ──────────────────────────────────
        if (!gptResult) {
            console.error(`[Listener] GPT failed for @${username}, using fallback`);
            await notifyAdmin(`⚠️ AI ошибка при ответе @${username}. Сообщение: «${text.substring(0, 120)}»`, { rateLimitKey: 'ai-error' });
            // Still create a draft so the operator can take over
            await createDraftMessage(dialogue.id, FALLBACK_REPLY);
            return;
        }

        console.log(`[GPT] Reply: ${gptResult.reply.substring(0, 100)}`);

        // ── Persist extracted profile + stage update ────────────────────────
        if (gptResult.extractedProfile && Object.keys(gptResult.extractedProfile).length > 0) {
            const allowed: (keyof typeof gptResult.extractedProfile)[] = [
                'city', 'activity', 'businessCard', 'bestClients', 'requests',
                'hobbies', 'currentIncome', 'desiredIncome', 'networkingGoal',
            ];
            const safe: Record<string, any> = {};
            for (const k of allowed) {
                const v = (gptResult.extractedProfile as any)[k];
                if (v !== undefined && v !== null && v !== '') safe[k] = v;
            }
            if (Object.keys(safe).length > 0) {
                await prisma.user.update({ where: { id: user.id }, data: safe });
                console.log(`[Listener] Extracted profile fields: ${Object.keys(safe).join(', ')}`);

                // We don't sync profile.* to Wave Match — WM doesn't model these
                // fields. Instead, on first activity-extraction we mark the WM
                // user with a `ai-profiling` tag so admins can spot AI-touched users.
                if (wmUser && safe.activity) {
                    addCrmTag(wmUser.id, 'ai-profiling').catch(e => console.error('[wm] addCrmTag error:', e.message));
                }
            }
        }

        if (gptResult.nextStage && gptResult.nextStage !== currentStage) {
            await prisma.dialogue.update({ where: { id: dialogue.id }, data: { stage: gptResult.nextStage } });
            console.log(`[Listener] Stage ${currentStage} → ${gptResult.nextStage}`);

            // CRM note when qualification finishes — AI label embedded into body+tags.
            if (gptResult.nextStage === 'CLOSED' && wmUser) {
                const summary = [
                    user.activity && `Сфера: ${user.activity}`,
                    user.requests && `Запросы: ${user.requests}`,
                    user.city && `Город: ${user.city}`,
                ].filter(Boolean).join(' · ');
                await addAiNote(wmUser.id, 'ai_qualification_done', summary || 'Профиль заполнен в диалоге AI', {
                    tags: ['qualified'],
                    linkedDialogId: dialogue.id,
                });
                addCrmTag(wmUser.id, 'ai-qualified').catch(() => { });
            }
        }

        // ── Send (auto-mode) or stash as draft ──────────────────────────────
        if (user.autoReply) {
            try {
                await sendMessageToUser(user.id, gptResult.reply);
                console.log(`[Listener] Auto-sent reply to @${username}`);
            } catch (sendErr: any) {
                console.error(`[Listener] Auto-send failed:`, sendErr.message);
                await notifyAdmin(`⚠️ Не смог автоотправить @${username}: ${sendErr.message}`, { rateLimitKey: 'send-error' });
                await createDraftMessage(dialogue.id, gptResult.reply);
            }
        } else {
            const draft = await createDraftMessage(dialogue.id, gptResult.reply);
            emitEvent({ type: 'message:draft', dialogueId: dialogue.id, userId: user.id, text: gptResult.reply });
        }
    }, new NewMessage({ incoming: true }));
}
