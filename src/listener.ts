import { NewMessage } from "telegram/events";
import { Api } from "telegram";
import { getClient } from "./client";
import { persona, isAdmin } from "./persona";
import {
    ensureUserAndDialogue,
    saveMessageToDb,
    createDraftMessage,
    sendMessageToUser,
    sendMultipart,
    upgradeStatusOnSend,
    upgradeStatusOnReceive,
} from "./actions";
import { generateResponse } from "./gpt";
import { DialogueStage } from '@prisma/client';
import prisma from './db';
import { emitEvent } from './events';
import { notifyAdmin, notifyLeads, getAdminUsername, buildUserCard } from './notify';
import { isVoiceMessage, transcribeVoice } from './voice';
import { pickReaction } from './reactionPicker';
import { enqueuePending, notifyAdminAboutPending } from './pendingSends';
import { detectPartnershipIntent } from './partnershipDetector';
import { detectEscalationIntent } from './escalationDetector';
import { enrichProfile } from './profileEnricher';
import { buildWelcomeMessages } from './welcomeBuilder';
import { fetchExternalContext, formatForPrompt as formatExternalContext, detectConsumableContent } from './externalContext';
import { detectEfir, detectAnons, getActiveEfir, buildEfirPrompt, detectPartnerNeed, buildPartnerPivotPrompt } from './efir';
import { detectSalesSignal, buildProductSalesPrompt } from './products';
import { detectLiveHumanRequest, getFreeSlots, createMeeting, buildBookingPrompt, fmtMsk } from './booking';
import { findMatches, formatMatchesForPrompt } from './matchEngine';
import { getUserByTelegramId, addAiNote, addCrmTag, patchProfile, getCachedEtag, isWMEnabled, WMUser, WritableProfileFields } from './wmClient';

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

        // ── Voice message → Whisper transcription (BEFORE admin-skip) ──────
        // Перенесли наверх, чтобы admin voice тоже расшифровывался — Роман
        // тестирует на своём аккаунте через voice.
        if (isVoiceMessage(message)) {
            isVoice = true;
            console.log(`[Listener] Voice message from @${username}, downloading...`);
            try {
                const buf = await client.downloadMedia(message);
                if (buf && Buffer.isBuffer(buf)) {
                    const ctxMsgs = await prisma.message.findMany({
                        where: { dialogueId: { in: [] } },
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

        // Skip GPT auto-reply for admin (avoid feedback loops with notifyAdmin).
        // Админы: Роман (@roman_arctur) у обоих ботов + Алекс (@alex_hardi1) у
        // бота Алекса. Admin-сообщения = НЕ клиентский диалог: контекст/обучение
        // (эфиры, продукты, примеры диалогов) → сохраняем как global rule.
        // НО: voice от админа сохраняем + если есть pendingCardBrief/Full — обрабатываем consent.
        if (isAdmin(username)) {
            // Admin path: НЕ markAsRead в начале. Только если будем доставлять
            // pending — markAsRead прямо перед send. Если нет — read останется
            // непомеченным (так лучше: «не видел» лучше чем «прочитал и забил»).
            try {
                // Гарантируем что admin-user есть (Алекс мог ещё не писать боту).
                let adminUser = await prisma.user.findFirst({ where: { OR: [{ username: username }, { telegramId: username }] } });
                if (!adminUser) {
                    const ensured = await ensureUserAndDialogue(username, firstName, sender.accessHash?.toString());
                    adminUser = ensured.user;
                }
                if (adminUser) {
                    // Сохраняем voice-транскрипт как USER-RECEIVED, чтобы Роман видел в /dialogues/52
                    if (isVoice && text) {
                        const adminDlg = await prisma.dialogue.findFirst({ where: { userId: adminUser.id }, orderBy: { id: 'desc' } });
                        if (adminDlg) {
                            await prisma.message.create({
                                data: { dialogueId: adminDlg.id, sender: 'USER', text: `🎙️ ${text}`, status: 'RECEIVED' },
                            }).catch(() => { });
                            console.log(`[Listener admin-voice] Saved transcript: ${text.substring(0, 100)}`);
                        }
                    }
                    const facts = (adminUser.facts as any) || {};
                    const consentRe = /(?:^|\P{L})(?:да|давайте|давай|интересно|конечно|покажите|покажи|присыла[ий]те|присыл[ая]ть|прислать|пришли(?:те)?|шли(?:те)?|ок|окей|жду|пример|пробуй|готов(?:а|ы)?|можно)(?:$|\P{L})/iu;
                    if (consentRe.test(text) && facts.pendingCardOwed) {
                        const enriched = await enrichProfile(facts.pendingCardForUsername || username, facts.pendingCardForTgId);
                        if (!enriched.firstName && adminUser.firstName) enriched.firstName = adminUser.firstName;
                        const msgs = buildWelcomeMessages(enriched);
                        // Mark as read прямо перед send (≤1мин до сообщения)
                        try { await message.markAsRead(); } catch (_) { }
                        if (msgs.cardQuestions) {
                            await sendMessageToUser(adminUser.id, msgs.cardQuestions);
                            delete facts.pendingCardOwed;
                            delete facts.pendingCardForUsername;
                            delete facts.pendingCardForTgId;
                            await prisma.user.update({ where: { id: adminUser.id }, data: { facts: facts as any } });
                            console.log(`[Listener admin-test] Sent cardQuestions to @${username}`);
                        } else if (msgs.hasEnrichment && msgs.cardBrief && msgs.cardFull) {
                            const parts = [msgs.cardBrief, msgs.cardFull];
                            if (msgs.cardGaps) parts.push(msgs.cardGaps);
                            await sendMultipart(adminUser.id, parts);
                            delete facts.pendingCardOwed;
                            delete facts.pendingCardForUsername;
                            delete facts.pendingCardForTgId;
                            facts.cardsDeliveredAt = new Date().toISOString();
                            facts.cardsFollowupSent = false;
                            await prisma.user.update({ where: { id: adminUser.id }, data: { facts: facts as any } });
                            console.log(`[Listener admin-test] Delivered fresh-built cards to @${username}`);
                        }
                    }
                    // ── #2/#3: контекст/обучение от админа ──────────────────
                    // Если админ прислал содержательное сообщение (не consent,
                    // не короткую команду) — это контекст по эфирам/продуктам
                    // или пример диалога для обучения. Сохраняем как global rule
                    // (бот сразу начнёт учитывать через ≤30с, cache invalidated).
                    const trimmed = (text || '').trim();
                    const isConsentOnly = consentRe.test(trimmed) && trimmed.length < 25;
                    if (!facts.pendingCardOwed && !isConsentOnly && trimmed.length > 40) {
                        try {
                            await prisma.rule.create({
                                data: {
                                    content: `[КОНТЕКСТ от @${username}${isVoice ? ' 🎙️' : ''}]: ${trimmed.slice(0, 2000)}`,
                                    isGlobal: true,
                                    isActive: true,
                                },
                            });
                            invalidateContextCache();
                            try { await message.markAsRead(); } catch (_) { }
                            await sendMessageToUser(adminUser.id, 'Принял, учту в работе ✅');
                            console.log(`[admin-intake] @${username} → контекст/обучение сохранён как rule (${trimmed.length} chars)`);
                        } catch (e: any) { console.warn('[admin-intake] err:', e.message); }
                    }
                }
            } catch (e: any) { console.warn(`[Listener admin-test] err:`, e.message); }
            console.log(`[Listener] Skipping GPT-reply for admin @${username}`);
            return;
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

        // ── NO instant markAsRead (Roman 2026-05-13: «открываешь просмотр и не
        // отвечаешь» = плохо). markAsRead откладываем до момента когда ответ
        // готов к отправке, чтобы между «прочитано» и ответом было <1 мин.
        //
        // Решение fast/slow mode — здесь же. 75% fast (0-15s pre-delay),
        // 25% slow (5-10 мин deferred). При slow проверим что message всё ещё
        // latest USER в диалоге, иначе skip (новое сообщение пришло — старое
        // обработает следующий handler).
        const captureMessageId = message.id;
        let needRaceCheck = false;  // any path that does long defer must set this
        // Slow-mode (5-10мин defer) только у персон с humanlikeSlowMode
        // (Артур). Алекс = личный ассистент, отвечает быстро (только jitter).
        const isSlowMode = persona.humanlikeSlowMode && Math.random() < 0.25;
        if (isSlowMode) needRaceCheck = true;
        if (isSlowMode) {
            const waitMs = 300_000 + Math.floor(Math.random() * 300_000);  // 5-10 min
            console.log(`[timing] @${username} slow mode: defer ${Math.round(waitMs / 60_000)}min`);
            await new Promise(r => setTimeout(r, waitMs));
        } else {
            const waitMs = Math.floor(Math.random() * 15000);  // 0-15s jitter
            if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
        }

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

        // Лид считается лидом только если ответил — upgrade NEW/CHAT → LEAD
        upgradeStatusOnReceive(dialogue.id).catch(e => console.warn('[upgrade] err:', e.message));

        // ── Consumable content (Zoom/video/PDF/article) ─────────────────────
        // Roman 2026-05-14: «человек не может за 1 минуту посмотреть зум и дать
        // ОС. Через час пиши что ознакомился и сделал выводы».
        // Если USER прислал ссылку на контент требующий времени:
        //   1. короткий ACK сейчас («Спасибо, гляну, отпишусь»)
        //   2. отложка 30-90 мин (kind-зависимая)
        //   3. потом — substantive reply через нормальный pipeline
        // Race-check в slow mode перед substantive send уже есть — он покроет
        // случай если за час юзер написал что-то новое.
        const consumable = detectConsumableContent(text);
        if (consumable) {
            console.log(`[consumable] @${username} kind=${consumable.kind} ACK now + defer ${Math.round(consumable.delayMs / 60_000)}min`);
            try { await message.markAsRead(); } catch (_) { /* ignore */ }
            // Маленький humanlike jitter перед ACK (3-12s = «увидел, пишу»)
            const ackJitter = 3000 + Math.floor(Math.random() * 9000);
            await new Promise(r => setTimeout(r, ackJitter));
            try {
                await sendMessageToUser(user.id, consumable.ackTemplate);
                await saveMessageToDb(dialogue.id, 'OPERATOR', consumable.ackTemplate, 'SENT');
                emitEvent({ type: 'message:new', dialogueId: dialogue.id, userId: user.id, sender: 'OPERATOR', text: consumable.ackTemplate });
            } catch (ackErr: any) {
                console.warn(`[consumable] ACK send failed:`, ackErr.message);
                // Если ACK не ушёл — не делаем длинную паузу, пусть нормальный pipeline
                // отработает (там тоже race-check etc).
            }
            // Длинная отложка перед substantive reply.
            // markAsRead уже сделан выше; race-check в slow-mode pre-send блоке
            // ниже сработает по persistedText, поэтому переиспользуем флаг.
            await new Promise(r => setTimeout(r, consumable.delayMs));
            // С этого момента продолжаем нормальный pipeline (GPT prep, DNAI,
            // send). Race-check в pre-send блоке проверит что USER не написал
            // ничего нового за этот час — если написал, abort substantive reply.
            needRaceCheck = true;
        }

        // ── Welcome flow Stage 2 — отправка brief + full визитки на consent ─
        // Юзер ответил "да/интересно/давай" на Stage 1 → шлём краткую И полную
        // визитки сразу (без повторного "прислать?"). КРИТИЧНО: если pendingCardOwed
        // = true, мы НЕ должны давать GPT генерить ответ — иначе он галлюцинирует
        // фейковую карточку (баг Goloka 2026-05-02). Если consent есть — доставляем
        // pending. Если нет — листенер просто завершает обработку без GPT-реплая.
        let cardsJustDelivered = false;
        let pendingCardSilenceMode = false;
        try {
            const facts = (user.facts as any) || {};
            const consentRe = /(?:^|\P{L})(?:да|давайте|давай|интересно|конечно|покажите|покажи|присыла[ий]те|присыл[ая]ть|прислать|пришли(?:те)?|шли(?:те)?|ок|окей|жду|пример|пробуй|готов(?:а|ы)?|можно)(?:$|\P{L})/iu;
            if (facts.pendingCardOwed) {
                pendingCardSilenceMode = true;  // GPT не должен генерить карточки сам
            }
            if (consentRe.test(text) && facts.pendingCardOwed) {
                const enriched = await enrichProfile(facts.pendingCardForUsername || username, facts.pendingCardForTgId);
                if (!enriched.firstName && user.firstName) enriched.firstName = user.firstName;
                const msgs = buildWelcomeMessages(enriched);
                if (msgs.cardQuestions) {
                    // Мало данных → шлём опросник вместо карточки
                    await sendMessageToUser(user.id, msgs.cardQuestions);
                    delete facts.pendingCardOwed;
                    delete facts.pendingCardForUsername;
                    delete facts.pendingCardForTgId;
                    await prisma.user.update({ where: { id: user.id }, data: { facts: facts as any } });
                    console.log(`[listener] Sent cardQuestions (low-data) to @${username}`);
                    cardsJustDelivered = true;
                    pendingCardSilenceMode = false;
                } else if (msgs.hasEnrichment && msgs.cardBrief && msgs.cardFull) {
                    const parts = [msgs.cardBrief, msgs.cardFull];
                    if (msgs.cardGaps) parts.push(msgs.cardGaps);
                    await sendMultipart(user.id, parts);
                    delete facts.pendingCardOwed;
                    delete facts.pendingCardForUsername;
                    delete facts.pendingCardForTgId;
                    facts.cardsDeliveredAt = new Date().toISOString();
                    facts.cardsFollowupSent = false;
                    await prisma.user.update({ where: { id: user.id }, data: { facts: facts as any } });
                    console.log(`[listener] Sent fresh-built cards to @${username}`);
                    cardsJustDelivered = true;
                    pendingCardSilenceMode = false;
                }
            }
        } catch (e: any) { console.warn('[welcome-cards] err:', e.message); }

        // Если pendingCardOwed=true и consent не словлен — silent escalation.
        // Roman: «если не ясно что отвечать — ничего не пиши и отправляй мне
        // контекст чтоб я подключился для дальнейшего обучения системы». Бот
        // молчит → Роман видит DM с контекстом → отвечает сам → мы учимся.
        if (pendingCardSilenceMode && !cardsJustDelivered) {
            console.log(`[Listener] @${username} pendingCardOwed but no consent → silent escalation`);
            try {
                await prisma.user.update({ where: { id: user.id }, data: { autoReply: false } });
                await notifyAdmin(
                    `🆘 НУЖЕН ОТВЕТ: @${username} (${user.firstName || ''}, d=${dialogue.id})\n\n` +
                    `Юзер: «${text.slice(0, 250)}»\n\n` +
                    `Бот не уверен что отвечать → молчит. autoReply выключен. Подключись напрямую через @roman_arctur. Твой ответ станет training data.`,
                    { rateLimitKey: `escalation-${user.id}` },
                );
            } catch (e: any) {
                console.warn('[escalation] err:', e.message);
            }
            return;
        }

        // Явный escalation (counter-question / просьба конкретики / unknown)
        const esc = detectEscalationIntent(text);
        if (esc.matched) {
            console.log(`[escalation] @${username} «${esc.keyword}» → silent → DM Roman`);
            try {
                await prisma.user.update({ where: { id: user.id }, data: { autoReply: false } });
                await notifyAdmin(
                    `🆘 НУЖЕН ОТВЕТ: @${username} (${user.firstName || ''}, d=${dialogue.id})\n\n` +
                    `Триггер: «${esc.keyword}»\n` +
                    `Юзер: «${text.slice(0, 250)}»\n\n` +
                    `Бот молчит — нужна твоя реакция. autoReply выключен. Твой ответ через @roman_arctur станет training data.`,
                    { rateLimitKey: `escalation-${user.id}` },
                );
            } catch (e: any) {
                console.warn('[escalation] err:', e.message);
            }
            return;
        }

        // ── Partnership-intent detector (Принцип #16) ────────────────────────
        // Hot signal — escalate to Roman directly, GPT-prompt уже знает что делать
        const partnership = detectPartnershipIntent(text);
        if (partnership.matched) {
            console.log(`[partnership] HOT LEAD @${username}: "${partnership.keyword}"`);
            await notifyAdmin(
                `🔥 HOT LEAD (партнёрство): @${username} (${user.firstName || ''})\n` +
                `Триггер: «${partnership.keyword}»\n` +
                `Сообщение: «${text.slice(0, 200)}»\n\n` +
                `Бот предложит Zoom-слот. Подключайся напрямую через @roman_arctur, если готов созвониться.`,
                { rateLimitKey: `hot-${user.id}` },
            );
            // GPT-промпт сам сгенерит правильный Zoom-pitch на следующем шаге
            // через Принцип #16. Дополнительная логика не требуется.
        }

        // ── Stats: if this user has a recent OutreachAttempt with no firstReplyAt,
        //    mark it now. Window = last 14 days to avoid attributing a much later
        //    organic reply to an old broadcast.
        try {
            const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
            await prisma.outreachAttempt.updateMany({
                where: {
                    userId: user.id,
                    firstReplyAt: null,
                    sentAt: { gte: fourteenDaysAgo },
                },
                data: { firstReplyAt: new Date() },
            });
        } catch (_) { }

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

        // ── Persona override (мультибот): для Алекса добавляем фрагмент
        //    «личный ассистент Алекса». Для Артура persona.personaPrompt
        //    пустой → ничего не добавляется, поведение не меняется.
        if (persona.personaPrompt) {
            allRules.unshift(persona.personaPrompt);
        }

        // ── Principle #12: auto-fetch external context (links / @handles) ──
        // If the user just shared a t.me link, channel handle, or URL — pull
        // the public content so the bot doesn't ask them to repeat themselves.
        try {
            const external = await fetchExternalContext(text);
            if (external.length > 0) {
                const block = formatExternalContext(external);
                if (block) {
                    allRules.push(block);
                    console.log(`[external-context] Fetched ${external.length} source(s) for dialogue ${dialogue.id}`);
                }
            }
        } catch (e: any) {
            console.warn('[external-context] error:', e.message);
        }

        // ── Conversation Brain: top-3 LearnedScenarios for current stage ────
        // These are accumulated patterns (operator overrides + auto-analyzer
        // outputs). Mixed into the prompt so the bot uses real-life what-works.
        try {
            const scenarios = await prisma.learnedScenario.findMany({
                where: { stage: currentStage, isActive: true },
                orderBy: [{ successScore: 'desc' }, { usageCount: 'desc' }],
                take: 3,
            });
            for (const s of scenarios) {
                const block = `LEARNED PATTERN: ${s.trigger} → reply pattern: ${s.recommend}${s.avoid ? ` | AVOID: ${s.avoid}` : ''}`;
                allRules.push(block);
                // Bump usage counter (best-effort)
                prisma.learnedScenario.update({
                    where: { id: s.id },
                    data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
                }).catch(() => { });
            }
        } catch (_) { /* brain table may not exist yet on first deploy */ }

        // ── DNAI project_memory: inject lessons by detected topic ──────────
        // Per Roman's brief: «нужно работать в связке с другими агентами и
        // обучаться улучшать скрипты диалогов». detectTopic смотрит на USER
        // текст (moneo / alma / wm-rules) — если попали → подтягиваем top items
        // из shared memory Артура.
        try {
            const { isDnaiEnabled, detectTopic, memoryLoad } = await import('./dnaiClient');
            if (isDnaiEnabled()) {
                const topic = detectTopic(text);
                if (topic) {
                    const mem = await memoryLoad('arthur', topic);
                    const top = (mem.items || []).slice(0, 6);
                    if (top.length > 0) {
                        const lines = top.map((i: any) => `- [${i.kind || 'fact'}] ${i.content}`).join('\n');
                        allRules.push(`DNAI MEMORY (project=${topic}, ${top.length}/${mem.count} items):\n${lines}`);
                        console.log(`[dnai-memory] @${username} topic=${topic} injected=${top.length}/${mem.count}`);
                    }
                }
            }
        } catch (e: any) {
            console.warn('[dnai-memory] err (degraded, продолжаем без memory):', e.message);
        }

        // ── Match engine: top-3 потенциальных партнёров для этого юзера ────
        try {
            const matches = await findMatches(user.id, { limit: 3, minScore: 4 });
            if (matches.length > 0) {
                const block = formatMatchesForPrompt(matches);
                if (block) {
                    allRules.push(block);
                    console.log(`[match-engine] Found ${matches.length} match(es) for uid=${user.id} (top score=${matches[0].score})`);
                }
            }
        } catch (e: any) {
            console.warn('[match-engine] error:', e.message);
        }

        const recentMessages = await prisma.message.findMany({
            where: { dialogueId: dialogue.id },
            orderBy: { id: 'desc' },
            take: 12,
        });
        const history = recentMessages.reverse().map(m => ({ sender: m.sender, text: m.text }));

        // ── Сценарий «ЭФИР» (оба бота). Активен если эфир упомянут в текущем
        //    сообщении ИЛИ в недавней истории (например опенер бота завёл речь
        //    об эфире, а юзер ответил «да/интересно» без слова «эфир»).
        //    «анонс» → полный анонс дословно; иначе → нативно к записи.
        {
            const recentText = history.map(m => m.text || '').join(' \n ');
            const efirInCurrent = detectEfir(text) || detectAnons(text);
            const efirInHistory = detectEfir(recentText) || detectAnons(recentText);
            if (efirInCurrent || efirInHistory) {
                const efir = getActiveEfir();
                if (efir) {
                    const mode = detectAnons(text) ? 'full' : 'native';
                    allRules.push(buildEfirPrompt(efir, mode));
                    console.log(`[efir] @${username} → эфир «${efir.id}» mode=${mode} (current=${efirInCurrent} history=${efirInHistory})`);
                }
            }

            // Пивот: запрос на партнёра/спеца → предложить ИИ-сотрудника + эфир
            const partnerNeed = detectPartnerNeed(text);
            if (partnerNeed) {
                const efir = getActiveEfir();
                if (efir) {
                    allRules.push(buildPartnerPivotPrompt(efir));
                    console.log(`[efir] @${username} → partner-need pivot (ИИ-сотрудник + эфир)`);
                }
            }

            // Продукт ИИ-ассистент: при сигнале продаж/интереса ИЛИ запросе на
            // спеца — вплетаем продукт и ведём ПОСТЕПЕННО к покупке.
            const recentTextP = history.map(m => m.text || '').join(' \n ');
            if (detectSalesSignal(text) || detectSalesSignal(recentTextP) || partnerNeed) {
                const block = buildProductSalesPrompt();
                if (block) {
                    allRules.push(block);
                    console.log(`[product] @${username} → ИИ-ассистент sales context (postепенно к покупке)`);
                }
            }

            // Запись на созвон: хочет живого человека → предлагаем свободные слоты
            if (detectLiveHumanRequest(text) || detectLiveHumanRequest(recentTextP)) {
                try {
                    const slots = await getFreeSlots(12);
                    allRules.push(buildBookingPrompt(slots));
                    console.log(`[booking] @${username} → live-human request, ${slots.length} слотов предложено`);
                } catch (e: any) { console.warn('[booking] slots err:', e.message); }
            }
        }

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

        // ── Booking: клиент подтвердил слот созвона → бронь + уведомление ────
        if (gptResult.bookingSlotISO) {
            try {
                const when = new Date(gptResult.bookingSlotISO);
                if (!isNaN(when.getTime()) && when.getTime() > Date.now()) {
                    const m = await createMeeting({
                        userId: user.id,
                        dialogueId: dialogue.id,
                        botId: persona.botId,
                        scheduledAtISO: gptResult.bookingSlotISO,
                        clientUsername: username,
                        clientName: user.firstName,
                    });
                    await notifyAdmin(
                        `📅 Новая запись на созвон!\n` +
                        `Когда: ${fmtMsk(when)} (30 мин)\n` +
                        `Кто: ${user.firstName || ''} @${username}\n` +
                        `Бот: ${persona.displayName} · meetingId=${m.id}`,
                        { rateLimitKey: `booking-${m.id}` },
                    );
                    console.log(`[booking] @${username} забронировал ${fmtMsk(when)} (meetingId=${m.id})`);
                } else {
                    console.warn(`[booking] невалидный/прошедший слот: ${gptResult.bookingSlotISO}`);
                }
            } catch (e: any) { console.warn('[booking] create err:', e.message); }
        }

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

                // ── Push to Wave Match Profile (since contract v1.3.0) ─────
                if (wmUser) {
                    const profilePatch: WritableProfileFields = {};
                    const wmProfile = wmUser.profile || {};
                    // Map our local taxonomy → WM Profile fields, only filling
                    // what WM doesn't already have (no overwrites).
                    if (safe.city && !wmProfile.location) profilePatch.location = safe.city;
                    if (safe.activity) {
                        // Role first, then industry as fallback. Don't overwrite.
                        if (!wmProfile.role) profilePatch.role = safe.activity;
                        else if (!wmProfile.industry) profilePatch.industry = safe.activity;
                    }
                    if (safe.hobbies && (!Array.isArray(wmProfile.hobbies) || wmProfile.hobbies.length === 0)) {
                        const hobbiesArr = String(safe.hobbies)
                            .split(/[,;\n]+/)
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .slice(0, 30);
                        if (hobbiesArr.length > 0) profilePatch.hobbies = hobbiesArr;
                    }

                    if (Object.keys(profilePatch).length > 0) {
                        const etag = getCachedEtag(wmUser.id);
                        const result = await patchProfile(wmUser.id, profilePatch, { ifMatch: etag });
                        if (result) {
                            console.log(`[wm] Pushed ${Object.keys(profilePatch).join(', ')} to Wave Match profile (completion=${(result.user.profile as any)?.completion ?? 'n/a'}%)`);
                        } else {
                            console.warn(`[wm] patchProfile returned null — ETag mismatch or 4xx. Local data preserved.`);
                        }

                        // Also tag in CRM (internal AI-marker, separate from public profile.tags)
                        addCrmTag(wmUser.id, 'ai-profiling').catch(() => { });
                    }
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

        // ── DNAI Studio review-chain (Артур→Марк→Аида) ──────────────────────
        // Per docs/TZ-aiass-team.md (DNAI Studio repo). Hybrid architecture:
        // мы генерим candidate draft → DNAI делает 3-step review → возвращает
        // GO/TWEAK/NO-GO + text. NO-GO → notifyAdmin + skip send.
        // Idempotency-Key = последний USER messageId чтобы повтор retry-запроса
        // не пересчитывал.
        let finalReply = gptResult.reply;
        let dnaiNoGoReason: string | null = null;
        let dnaiVerdict: string | null = null;
        let dnaiRunId: string | null = null;
        const dnaiStartedAt = Date.now();
        try {
            const { isDnaiEnabled, review, getDnaiHealth } = await import('./dnaiClient');
            // Persona-гейт: DNAI review только для персон где он включён
            // (Алекс пока без review — работает чисто на нашем GPT-пайплайне).
            const personaDnai = persona.dnaiEnabled;
            // Canary rollout gate per TZ §2.5 — DNAI_ROLLOUT_PCT (0-100, default 100).
            // Идемпотентный hash по dialogueId, чтобы один и тот же диалог
            // всегда был in/out (а не флапал между сообщениями).
            const rolloutPct = Math.max(0, Math.min(100, Number(process.env.DNAI_ROLLOUT_PCT ?? 100)));
            const dialogBucket = (dialogue.id % 100 + 100) % 100;
            const passesRollout = personaDnai && dialogBucket < rolloutPct;
            // Circuit breaker (Roman 2026-05-15): если Аида не отвечает (N подряд
            // ошибок ИЛИ DNAI сама сообщила circuitOpen) — НЕ дёргаем review,
            // отправляем наш draft (он уже с полным контекстом: history + KB +
            // Match + memoryLoad из кэша). Это и есть «работать самостоятельно
            // поддерживая контекст диалога».
            const dnaiHealth = getDnaiHealth();
            if (isDnaiEnabled() && passesRollout && !dnaiHealth.available) {
                console.log(`[dnai-review] @${username} skipped — circuit open (consecutiveFailures=${dnaiHealth.consecutiveFailures}, upstream=${dnaiHealth.upstreamCircuitOpen}) → autonomous mode`);
            }
            if (isDnaiEnabled() && passesRollout && dnaiHealth.available) {
                // Idempotency-Key: уникальный per (dialog, последний USER message)
                const userMsgs = recentMessages.filter((m: any) => m.sender === 'USER');
                const lastUserMsgId = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1].id : Date.now();
                const idempKey = `msg-${dialogue.id}-${lastUserMsgId}`;
                const reviewRes = await review({
                    dialogueId: String(dialogue.id),
                    draft: gptResult.reply,
                    recentMessages: recentMessages.slice(-10).map(m => ({
                        sender: (m.sender === 'USER' ? 'USER' : 'OPERATOR') as 'USER' | 'OPERATOR',
                        text: m.text || '',
                        createdAt: new Date().toISOString(),
                    })),
                    clientContext: { stage: currentStage, telegramUsername: '@' + username },
                    mode: 'fallback',  // v2.0: graceful degradation on Anthropic 429/5xx
                }, idempKey);
                dnaiVerdict = reviewRes.verdict;
                dnaiRunId = reviewRes.metadata?.runId || null;
                const latencyMs = Date.now() - dnaiStartedAt;
                console.log(`[dnai-review] @${username} verdict=${reviewRes.verdict} runId=${dnaiRunId} latencyMs=${latencyMs} reason=${reviewRes.reason?.slice(0, 100)}`);
                if (reviewRes.verdict === 'NO-GO') {
                    dnaiNoGoReason = reviewRes.reason || 'NO-GO by Aida';
                    await notifyAdmin(
                        `🛑 NO-GO от Аиды (@${username}, d=${dialogue.id})\n\n` +
                        `Причина: ${reviewRes.reason}\n` +
                        `Эскалация: ${reviewRes.escalation?.to || '@roman_arctur'}\n` +
                        `runId: ${dnaiRunId}\n\n` +
                        `Наш draft (НЕ отправлен): «${gptResult.reply.slice(0, 200)}»`,
                        { rateLimitKey: `dnai-nogo-${user.id}` },
                    );
                    // Per TZ §2.4: помечаем диалог как awaiting human через tag
                    // (наш schema enum DialogueStage не содержит AWAITING_HUMAN).
                    const factsX = (user.facts as any) || {};
                    factsX.awaitingHumanSince = new Date().toISOString();
                    factsX.lastNoGoReason = reviewRes.reason;
                    await prisma.user.update({
                        where: { id: user.id },
                        data: { facts: factsX as any, autoReply: false },
                    }).catch(() => { });
                } else {
                    // GO / TWEAK / GO_FALLBACK — все используют review.text
                    // GO_FALLBACK = наш draft as-is (review не работал), всё равно отправляем
                    finalReply = reviewRes.text || gptResult.reply;
                    if (reviewRes.verdict === 'GO_FALLBACK') {
                        console.log(`[dnai-review] GO_FALLBACK (degraded) reason=${reviewRes.metadata?.fallbackReason || '?'}`);
                    }
                }
            }
        } catch (e: any) {
            console.warn('[dnai-review] err (fallback к локальному draft):', e.message);
            // Per TZ §2.6: на error НЕ retry в этом же тике, fallback к старому flow
        }

        if (dnaiNoGoReason) {
            console.log(`[Listener] DNAI NO-GO — не отправляем @${username}`);
            return;
        }

        // ── Pre-send: race-check for slow mode + markAsRead RIGHT NOW ─────────
        // Roman 2026-05-13: «после открытия сообщения не должно проходить более минуты».
        // markAsRead делаем ТУТ — после GPT/DNAI generation, прямо перед send.
        // typing+send занимают 5-30с → юзер видит read → typing → message ≤1 мин.
        if (needRaceCheck) {
            // Race-check: после ожидания (slow mode 5-10мин или consumable 30-90мин)
            // могло прийти новое USER msg. Если да — skip substantive reply,
            // новое сообщение обработает следующий handler invocation.
            const latestUser = await prisma.message.findFirst({
                where: { dialogueId: dialogue.id, sender: 'USER' },
                orderBy: { id: 'desc' },
                select: { id: true, text: true },
            });
            if (latestUser && latestUser.text !== persistedText) {
                console.log(`[timing] @${username} deferred reply aborted — newer USER msg arrived during wait`);
                return;
            }
        }
        try { await message.markAsRead(); } catch (_) { /* may fail if msg gone */ }

        // ── Send (auto-mode) or stash as draft ──────────────────────────────
        // Roman: эмодзи-реакция ставится только когда бот реально ответил —
        // не превентивно, чтобы юзер не видел "просмотрено и забыто".
        let replyDispatched = false;
        if (user.autoReply) {
            try {
                await sendMessageToUser(user.id, finalReply);
                console.log(`[Listener] Auto-sent reply to @${username}`);
                replyDispatched = true;
            } catch (sendErr: any) {
                console.error(`[Listener] Auto-send failed:`, sendErr.message);
                await notifyAdmin(`⚠️ Не смог автоотправить @${username}: ${sendErr.message}`, { rateLimitKey: 'send-error' });
                await createDraftMessage(dialogue.id, finalReply);
            }
        } else {
            const draft = await createDraftMessage(dialogue.id, finalReply);
            emitEvent({ type: 'message:draft', dialogueId: dialogue.id, userId: user.id, text: finalReply });
            try {
                enqueuePending(draft.id, dialogue.id);
                await notifyAdminAboutPending(draft.id, dialogue.id, finalReply);
                replyDispatched = true;
            } catch (e: any) {
                console.warn('[pending] enqueue err:', e.message);
            }
        }

        // ── Reaction AFTER reply dispatched ──────────────────────────────────
        if (replyDispatched) {
            try {
                const emoji = pickReaction(text);
                await client.invoke(new Api.messages.SendReaction({
                    peer: message.peerId,
                    msgId: message.id,
                    reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
                }));
            } catch (e: any) {
                console.log(`[react] skip msg=${message.id}: ${e.message?.slice(0, 80)}`);
            }
        }
    }, new NewMessage({ incoming: true }));
}
