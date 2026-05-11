import 'dotenv/config';
import { Api } from 'telegram';
console.log('[BOOT] Server script loaded. Importing dependencies...');
import Fastify from 'fastify';
import path from 'path';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import prisma from './db';
import { initClient, getClient, reconnectClient, getQR } from './client';
import { sendMessageToUser, sendDraftMessage, scanChatForLeads, ensureUserAndDialogue, saveMessageToDb, createDraftMessage, sendReplyInChat, sendScoutDM } from './actions';
import { generateResponse, analyzeText } from './gpt';
import { startListener } from './listener';
import { sseHandler, emitEvent } from './events';
import { notifyAdmin, notifyLeads } from './notify';
import { findMatches, connectUsers } from './match';
import { seedScenarios } from './scenarios';
import { previewBroadcast, sendBroadcast, backfillGender, findAudience, AudienceFilter } from './broadcast';
import { isWMEnabled, ensureWebhookSubscription } from './wmClient';
import { verifySignature, handleWMEvent } from './webhookHandler';
import { runDailyAnalyzer, startBrainAnalyzerCron } from './brainAnalyzer';
import {
    startOutreachQueue,
    tickOutreachQueue,
    pauseOutreachQueue,
    resumeOutreachQueue,
    getOutreachQueueStatus,
} from './outreachQueue';
import {
    startPendingSendsTick,
    cancelPending,
    isPending,
    getPendingStatus,
} from './pendingSends';
import {
    startNewUsersScanner,
    tickNewUsersScannerNow,
    getNewUsersScannerStatus,
} from './newUsersScanner';
import {
    startMeetupFollowupCron,
    tickMeetupFollowupNow,
    getMeetupFollowupStatus,
} from './meetupFollowup';
import {
    startCardsFollowupCron,
    tickCardsFollowupNow,
    getCardsFollowupStatus,
} from './cardsFollowup';
import {
    startDailyBatchSweep,
    tickDailyBatchNow,
    getDailyBatchStatus,
    pauseDailyBatchSweep,
    resumeDailyBatchSweep,
} from './dailyBatchSweep';
import { renderDashboardHTML } from './dashboard';
import { registerAgentApi } from './agentApi';

const fastify = Fastify({ logger: true });

// Enable CORS
fastify.register(fastifyCors, { origin: true });

// Accept form-encoded bodies (some integrations / health-pingers send them)
fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body: any, done) => {
        try {
            const params = new URLSearchParams(body);
            const out: Record<string, string> = {};
            for (const [k, v] of params) out[k] = v;
            done(null, out);
        } catch (e: any) {
            done(e);
        }
    },
);

// 415 with the path so we can see who's poking at unsupported endpoints
fastify.setErrorHandler((err: any, req, reply) => {
    if (err.statusCode === 415) {
        req.log.warn({ url: req.url, contentType: req.headers['content-type'] }, '[415] unsupported media type');
    }
    reply.send(err);
});

// ── Wave Match webhook receiver ─────────────────────────────────────────────
// HMAC must be verified over the RAW body string, so we capture it in a hook
// before Fastify's default JSON parser runs.
fastify.addHook('preParsing', async (req: any, _reply, payload) => {
    if (req.routerPath === '/webhooks/wm' || req.url?.startsWith('/webhooks/wm')) {
        let raw = '';
        for await (const chunk of payload as any) raw += chunk.toString('utf8');
        req.rawBody = raw;
        // re-emit so default parser still gets the data
        const { Readable } = require('stream');
        return Readable.from(raw);
    }
    return payload;
});

fastify.post('/webhooks/wm', async (req: any, reply) => {
    const signature = req.headers['x-wc-signature'] as string;
    const timestamp = req.headers['x-wc-timestamp'] as string;
    // Wave Match deployed shape: X-WC-Delivery (UUID, used for idempotency).
    // Tolerate legacy x-wc-event-id / x-wm-event-id if anyone retains them.
    const headerDeliveryId = (req.headers['x-wc-delivery']
        || req.headers['x-wc-event-id']
        || req.headers['x-wm-event-id']) as string | undefined;
    const raw = req.rawBody || '';

    const verify = verifySignature(raw, signature, timestamp);
    if (!verify.ok) {
        req.log.warn({ reason: verify.reason }, '[wm-webhook] signature verification failed');
        return reply.code(401).send({ error: 'invalid signature', reason: verify.reason });
    }

    const evt = req.body as any;
    const deliveryId = headerDeliveryId || evt.deliveryId || evt.eventId || `${evt.event}-${Date.now()}`;
    const result = await handleWMEvent({
        deliveryId,
        event: evt.event,
        createdAt: evt.createdAt || evt.occurredAt,
        data: evt.data || {},
    });
    return result.ok ? reply.code(200).send({ ok: true }) : reply.code(500).send(result);
});

// Simple in-memory log buffer
const logBuffer: string[] = [];
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function addToLog(type: string, args: any[]) {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    // Strip ANSI codes
    const cleanMsg = msg.replace(/\u001b\[[0-9;]*m/g, '');
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    logBuffer.unshift(`[${timestamp}] [${type}] ${cleanMsg}`);
    if (logBuffer.length > 50) logBuffer.pop();
}

console.log = (...args) => {
    addToLog('INFO', args);
    originalConsoleLog.apply(console, args);
};

console.error = (...args) => {
    addToLog('ERROR', args);
    originalConsoleError.apply(console, args);
};

fastify.get('/logs', async (req, reply) => {
    return logBuffer;
});

// ── SSE: real-time updates for the admin UI ─────────────────────────────────
fastify.get('/events', async (req, reply) => {
    return sseHandler(req, reply);
});

// ── Auto-mode toggle: when on, listener auto-sends GPT replies ──────────────
fastify.post('/users/:id/auto-mode', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { enabled } = req.body as { enabled: boolean };
    try {
        const user = await prisma.user.update({
            where: { id: Number(id) },
            data: { autoReply: !!enabled },
        });
        emitEvent({ type: 'user:status', userId: user.id, status: user.status });
        return { success: true, user };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Force-start the scripted onboarding for a dialogue ──────────────────────
// Switches stage to QUALIFICATION and asks the AI to fire the first profiling question.
fastify.post('/dialogues/:id/start-onboarding', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        const dialogue = await prisma.dialogue.findUnique({
            where: { id: Number(id) },
            include: { user: true },
        });
        if (!dialogue) return reply.code(404).send({ error: 'Not found' });

        await prisma.dialogue.update({
            where: { id: Number(id) },
            data: { stage: 'QUALIFICATION', status: 'ACTIVE' },
        });

        const recent = await prisma.message.findMany({
            where: { dialogueId: dialogue.id },
            orderBy: { id: 'desc' },
            take: 8,
        });
        const history = recent.reverse().map(m => ({ sender: m.sender, text: m.text }));

        const rules = await prisma.rule.findMany({
            where: { OR: [{ isGlobal: true }, { userId: dialogue.userId }], isActive: true },
        });
        const kbItems = await prisma.knowledgeItem.findMany();

        const result = await generateResponse(
            history,
            'QUALIFICATION',
            dialogue.user,
            {},
            kbItems.map(k => ({ question: k.question, answer: k.answer })),
            'Начни онбординг по нетворкингу. Поприветствуй коротко и задай первый профилирующий вопрос.',
            rules.map(r => r.content),
        );

        if (!result) return reply.code(500).send({ error: 'AI failed' });

        await createDraftMessage(dialogue.id, result.reply);
        return { success: true, reply: result.reply };
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: e.message });
    }
});

// ── Send a draft (used by ChatWindow's "Send Now" button) ───────────────────
fastify.post('/messages/:id/send', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = req.body as { text?: string };
    try {
        const result = await sendDraftMessage(null, parseInt(id), text);
        return { success: true, result };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Delete a draft (discard AI proposal) ─────────────────────────────────────
fastify.delete('/messages/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        await prisma.message.delete({ where: { id: Number(id) } });
        return { success: true };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Cleanup helpers ─────────────────────────────────────────────────────────

// Drop all DRAFTs in a dialogue (keep history of sent/received messages)
fastify.post('/dialogues/:id/cleanup-drafts', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        const result = await prisma.message.deleteMany({
            where: { dialogueId: Number(id), status: 'DRAFT' },
        });
        emitEvent({ type: 'dialogue:updated', dialogueId: Number(id) });
        return { success: true, deleted: result.count };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// Reset a dialogue: wipe ALL messages, reset stage to DISCOVERY, status to NEW
fastify.post('/dialogues/:id/reset', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        const dialogue = await prisma.dialogue.findUnique({
            where: { id: Number(id) },
            select: { userId: true },
        });
        if (!dialogue) return reply.code(404).send({ error: 'Not found' });

        await prisma.$transaction([
            prisma.message.deleteMany({ where: { dialogueId: Number(id) } }),
            prisma.dialogue.update({
                where: { id: Number(id) },
                data: { stage: 'DISCOVERY', status: 'ACTIVE', updatedAt: new Date() },
            }),
            prisma.user.update({
                where: { id: dialogue.userId },
                data: { status: 'NEW', notifiedNew: false, notifiedLead: false },
            }),
        ]);
        emitEvent({ type: 'dialogue:updated', dialogueId: Number(id) });
        return { success: true };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// One-time mass cleanup: dedupe DRAFTs across the whole DB
// (older DRAFTs in same dialogue are removed, only the newest stays)
fastify.post('/admin/dedupe-drafts', async (req, reply) => {
    try {
        const drafts = await prisma.message.findMany({
            where: { status: 'DRAFT' },
            select: { id: true, dialogueId: true, createdAt: true },
            orderBy: [{ dialogueId: 'asc' }, { createdAt: 'desc' }],
        });
        const seen = new Set<number>();
        const toDelete: number[] = [];
        for (const m of drafts) {
            if (seen.has(m.dialogueId)) toDelete.push(m.id);
            else seen.add(m.dialogueId);
        }
        if (toDelete.length > 0) {
            await prisma.message.deleteMany({ where: { id: { in: toDelete } } });
        }
        return { success: true, deleted: toDelete.length };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Match Engine: find candidates for connection ────────────────────────────
fastify.get('/users/:id/matches', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { limit } = req.query as { limit?: string };
    try {
        const matches = await findMatches(Number(id), Math.min(parseInt(limit || '5'), 20));
        return { matches };
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: e.message });
    }
});

// ── Broadcast: outreach to existing users with templated scenarios ──────────
fastify.get('/broadcast/templates', async (req, reply) => {
    const templates = await prisma.template.findMany({ orderBy: { name: 'asc' } });
    return templates;
});

// Update template content (admin tweaks scenario wording)
fastify.put('/broadcast/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { content } = req.body as { content: string };
    if (!content || content.length < 10) return reply.code(400).send({ error: 'content too short' });
    try {
        const tpl = await prisma.template.update({
            where: { id: Number(id) },
            data: { content },
        });
        return tpl;
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// Preview audience + rendered messages
fastify.post('/broadcast/preview', async (req, reply) => {
    const { templateId, filter } = (req.body || {}) as { templateId: number; filter?: AudienceFilter };
    if (!templateId) return reply.code(400).send({ error: 'templateId required' });
    try {
        const items = await previewBroadcast(templateId, filter || {});
        return { count: items.length, items };
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: e.message });
    }
});

// Send: create drafts (or auto-send) for selected users
fastify.post('/broadcast/send', async (req, reply) => {
    const body = (req.body || {}) as { templateId: number; userIds: number[]; mode?: 'draft' | 'auto' };
    if (!body.templateId || !Array.isArray(body.userIds) || body.userIds.length === 0) {
        return reply.code(400).send({ error: 'templateId + non-empty userIds required' });
    }
    try {
        const result = await sendBroadcast({
            templateId: body.templateId,
            userIds: body.userIds,
            mode: body.mode === 'auto' ? 'auto' : 'draft',
        });
        return result;
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: e.message });
    }
});

// Per-template aggregated stats: sent / replied / lead / match + conversion rates
fastify.get('/broadcast/stats', async (req, reply) => {
    try {
        const templates = await prisma.template.findMany({ orderBy: { name: 'asc' } });
        const out = await Promise.all(templates.map(async (t) => {
            const [sent, replied, lead, matched, customer, avgReply] = await Promise.all([
                prisma.outreachAttempt.count({ where: { templateId: t.id } }),
                prisma.outreachAttempt.count({ where: { templateId: t.id, firstReplyAt: { not: null } } }),
                prisma.outreachAttempt.count({ where: { templateId: t.id, becameLeadAt: { not: null } } }),
                prisma.outreachAttempt.count({ where: { templateId: t.id, becameMatchedAt: { not: null } } }),
                prisma.outreachAttempt.count({ where: { templateId: t.id, becameCustomerAt: { not: null } } }),
                // Average reply time in seconds
                prisma.outreachAttempt.findMany({
                    where: { templateId: t.id, firstReplyAt: { not: null } },
                    select: { sentAt: true, firstReplyAt: true },
                }).then(rows => {
                    if (rows.length === 0) return null;
                    const total = rows.reduce((sum, r) => sum + (r.firstReplyAt!.getTime() - r.sentAt.getTime()), 0);
                    return Math.round(total / rows.length / 1000);
                }),
            ]);
            return {
                templateId: t.id,
                name: t.name,
                sent,
                replied,
                lead,
                matched,
                customer,
                replyRate: sent > 0 ? Math.round((replied / sent) * 100) : 0,
                leadRate: sent > 0 ? Math.round((lead / sent) * 100) : 0,
                matchRate: sent > 0 ? Math.round((matched / sent) * 100) : 0,
                avgReplySeconds: avgReply,
            };
        }));
        return { stats: out };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Business Card: generate / fetch cached / send to user ──────────────────
fastify.post('/users/:id/business-card', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { force } = (req.query || {}) as { force?: string };
    try {
        const { generateBusinessCard, getCachedCard } = await import('./businessCard');
        if (!force) {
            const cached = await getCachedCard(Number(id));
            if (cached) return { ...cached, fromCache: true };
        }
        const result = await generateBusinessCard(Number(id), { force: true });
        if (!result) return reply.code(500).send({ error: 'Generation failed' });
        return { ...result, fromCache: false };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// Send the brief or full card directly into the user's dialogue (replacing
// any draft). Used by the operator action buttons.
fastify.post('/users/:id/send-card', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { variant } = (req.body || {}) as { variant: 'brief' | 'full' };
    try {
        const { getCachedCard } = await import('./businessCard');
        const card = await getCachedCard(Number(id));
        if (!card) return reply.code(404).send({ error: 'No cached card; generate first' });
        const text = variant === 'full' ? card.full : card.brief;
        const dialogue = await prisma.dialogue.findFirst({ where: { userId: Number(id), status: 'ACTIVE' } });
        if (!dialogue) return reply.code(404).send({ error: 'No active dialogue' });
        await sendMessageToUser(Number(id), text);
        return { success: true };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Conversation Brain: LearnedScenario CRUD ───────────────────────────────
fastify.get('/brain/scenarios', async (req, reply) => {
    const { stage, source, active } = req.query as { stage?: string; source?: string; active?: string };
    const where: any = {};
    if (stage) where.stage = stage;
    if (source) where.source = source;
    if (active === '1') where.isActive = true;
    const items = await prisma.learnedScenario.findMany({
        where,
        orderBy: [{ successScore: 'desc' }, { usageCount: 'desc' }, { createdAt: 'desc' }],
    });
    return items;
});

fastify.post('/brain/scenarios', async (req, reply) => {
    const body = req.body as any;
    if (!body?.stage || !body?.trigger || !body?.recommend) {
        return reply.code(400).send({ error: 'stage + trigger + recommend required' });
    }
    const item = await prisma.learnedScenario.create({
        data: {
            stage: body.stage,
            trigger: body.trigger,
            recommend: body.recommend,
            avoid: body.avoid,
            source: body.source || 'manual',
            notes: body.notes,
            isActive: body.isActive !== false,
        },
    });
    return item;
});

fastify.put('/brain/scenarios/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    try {
        const item = await prisma.learnedScenario.update({
            where: { id: Number(id) },
            data: {
                trigger: body.trigger,
                recommend: body.recommend,
                avoid: body.avoid,
                stage: body.stage,
                isActive: body.isActive,
                notes: body.notes,
            },
        });
        return item;
    } catch (e: any) {
        return reply.code(404).send({ error: e.message });
    }
});

fastify.delete('/brain/scenarios/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.learnedScenario.delete({ where: { id: Number(id) } }).catch(() => { });
    return { success: true };
});

// ── Match engine: preview top matches for a user ──────────────────────────
fastify.get('/users/:id/match-candidates', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { findMatches } = await import('./matchEngine');
    try {
        const matches = await findMatches(Number(id), { limit: 5, minScore: 3 });
        return matches.map(m => ({
            userId: m.user.id,
            firstName: m.user.firstName,
            username: m.user.username,
            telegramId: m.user.telegramId,
            score: m.score,
            reasons: m.reasons,
            activity: m.user.activity,
            city: m.user.city,
            hobbies: m.user.hobbies,
        }));
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Quick-action: tap-to-send / tap-to-cancel from admin DM links ───────────
// Userbot не может ставить inline-buttons, поэтому в DM кладём HTTPS-ссылки.
// GET-эндпоинты (один-тап в Telegram), отвечают простым HTML.
const QA_PAGE = (title: string, body: string) =>
    `<!DOCTYPE html><meta charset="utf-8"><title>${title}</title>
     <body style="font-family:-apple-system,sans-serif;background:#0b0b0b;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
     <div style="text-align:center;padding:24px;max-width:480px">
       <h1 style="font-size:48px;margin:0">${title}</h1>
       <p style="font-size:18px;line-height:1.5;color:#aaa">${body}</p>
     </div></body>`;

fastify.get('/qa/send/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const msgId = Number(id);
    try {
        const msg = await prisma.message.findUnique({ where: { id: msgId } });
        if (!msg) {
            reply.type('text/html');
            return QA_PAGE('❓ Не найдено', `Message #${msgId} not found.`);
        }
        if (msg.status !== 'DRAFT') {
            reply.type('text/html');
            return QA_PAGE('ℹ️ Уже отправлено', `Драфт #${msgId} уже не в статусе DRAFT (текущий: ${msg.status}).`);
        }
        cancelPending(msgId);
        await sendDraftMessage(null, msgId);
        reply.type('text/html');
        return QA_PAGE('✅ Отправлено', `Драфт #${msgId} ушёл получателю.`);
    } catch (e: any) {
        reply.type('text/html');
        return QA_PAGE('⚠️ Ошибка', e.message);
    }
});

fastify.get('/qa/cancel/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const msgId = Number(id);
    const wasPending = isPending(msgId);
    cancelPending(msgId);
    try {
        await prisma.message.delete({ where: { id: msgId } });
    } catch (_) { /* уже удалён */ }
    reply.type('text/html');
    return QA_PAGE(
        wasPending ? '❌ Отменено' : 'ℹ️ Уже не в очереди',
        `Драфт #${msgId} ${wasPending ? 'удалён, авто-отправки не будет.' : 'не висел в pending — возможно, уже отправлен или удалён ранее.'}`,
    );
});

fastify.get('/qa/status', async () => ({ pending: getPendingStatus() }));

// ── Active dashboard ────────────────────────────────────────────────────────
// External agent API (read + draft) — gated by AGENT_API_KEY env
registerAgentApi(fastify);

fastify.get('/admin/dashboard', async (req, reply) => {
    const html = await renderDashboardHTML();
    reply.type('text/html');
    return html;
});

// ── Daily morning batch — status + manual fire ──────────────────────────────
fastify.get('/admin/daily-batch/status', async () => getDailyBatchStatus());
fastify.post('/admin/daily-batch/tick-now', async (req, reply) => {
    try { return await tickDailyBatchNow(); } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});
fastify.post('/admin/daily-batch/pause', async () => { pauseDailyBatchSweep(); return { ok: true, ...getDailyBatchStatus() }; });
fastify.post('/admin/daily-batch/resume', async () => { resumeDailyBatchSweep(); return { ok: true, ...getDailyBatchStatus() }; });

// ── Cards follow-up — status + tick ────────────────────────────────────────
fastify.get('/admin/cards-followup/status', async () => getCardsFollowupStatus());
fastify.post('/admin/cards-followup/tick-now', async (req, reply) => {
    try { return await tickCardsFollowupNow(); } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// ── EMERGENCY: mark all eligible users as meetup_invited (one-shot dedup) ──
fastify.post('/admin/meetup-followup/mark-all-invited', async (req, reply) => {
    try {
        const users = await prisma.user.findMany({
            where: { status: { notIn: ['BLOCKED', 'REJECTED'] } },
            select: { id: true, facts: true, tags: true, username: true },
        });
        let touched = 0;
        for (const u of users) {
            const facts = (u.facts as any) || {};
            if (facts.meetupInvitedAt) continue;
            facts.meetupInvitedAt = new Date().toISOString();
            const tags = Array.isArray(u.tags) ? u.tags as string[] : [];
            const newTags = tags.includes('meetup_invited') ? tags : [...tags, 'meetup_invited'];
            await prisma.user.update({
                where: { id: u.id },
                data: { facts: facts as any, tags: newTags as any },
            });
            touched++;
        }
        return { success: true, touched };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Meetup follow-up: status + tick ────────────────────────────────────────
fastify.get('/admin/meetup-followup/status', async () => getMeetupFollowupStatus());
fastify.post('/admin/meetup-followup/tick-now', async (req, reply) => {
    try { return await tickMeetupFollowupNow(); } catch (e: any) { return reply.code(500).send({ error: e.message }); }
});

// ── WM Marketing API smoke (moneo + partnership) ────────────────────────────
fastify.get('/admin/wm-marketing/smoke', async (req, reply) => {
    try {
        const { smokeTest } = await import('./wmMarketingClient');
        return await smokeTest();
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

fastify.get('/admin/wm-marketing/moneo', async (req, reply) => {
    try {
        const { fetchMoneoUsersAll } = await import('./wmMarketingClient');
        const r = await fetchMoneoUsersAll();
        // Return first 3 raw + count для понимания schema
        return { count: r.users.length, sample: r.users.slice(0, 3) };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

fastify.get('/admin/wm-marketing/partnership', async (req, reply) => {
    const page = Number((req.query as any).page || 1);
    try {
        const { fetchPartnershipUsers } = await import('./wmMarketingClient');
        const r = await fetchPartnershipUsers(page);
        return { count: r.users.length, sample: r.users.slice(0, 3), page };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Admin: manual WM profile patch ──────────────────────────────────────────
// Прямой patchProfile на WM юзера. Используется когда нужно сразу применить
// данные (полученные напр. голосом от админа, минуя GPT-extraction).
fastify.post('/admin/wm/users/:wmId/patch-profile', async (req, reply) => {
    const { wmId } = req.params as { wmId: string };
    const body = req.body as any;
    try {
        const { patchProfile, getCachedEtag, isWMEnabled } = await import('./wmClient');
        if (!isWMEnabled()) return reply.code(503).send({ error: 'WM not configured' });
        const etag = getCachedEtag(wmId);
        const result = await patchProfile(wmId, body, { ifMatch: etag });
        if (!result) return reply.code(409).send({ error: 'patchProfile returned null (ETag mismatch or 4xx)' });
        return { success: true, completion: (result.user.profile as any)?.completion, profile: result.user.profile };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── New users scanner: status + manual trigger ──────────────────────────────
fastify.get('/admin/new-users-scanner/status', async () => getNewUsersScannerStatus());
fastify.post('/admin/new-users-scanner/tick-now', async (req, reply) => {
    try {
        const r = await tickNewUsersScannerNow();
        return r;
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── WM recent-registrations (debug / admin sweep) ──────────────────────────
fastify.get('/admin/wm-recent', async (req, reply) => {
    const { sinceHours = '24', limit = '50', enrich = '0' } = req.query as { sinceHours?: string; limit?: string; enrich?: string };
    try {
        const { listUsers, getUserByTelegramId, isWMEnabled } = await import('./wmClient');
        if (!isWMEnabled()) return reply.code(503).send({ error: 'WM not configured' });
        const since = new Date(Date.now() - Number(sinceHours) * 3600_000).toISOString();
        const page = await listUsers({ limit: Math.min(Number(limit), 100), updatedSince: since });
        let items = (page.items || []).map((u: any) => ({
            id: u.id,
            telegramId: u.telegramId,
            username: u.username || null,
            firstName: u.firstName || null,
            createdAt: u.createdAt,
            updatedAt: u.updatedAt,
            registered: u.registered,
        }));
        // Enrich: for each item without username, fetch full record (parallel, capped)
        if (enrich === '1') {
            const enriched = await Promise.all(items.slice(0, 50).map(async (it) => {
                if (it.username || !it.telegramId) return it;
                try {
                    const full: any = await getUserByTelegramId(it.telegramId, 'profile');
                    if (full) {
                        return {
                            ...it,
                            username: full.username || null,
                            firstName: full.firstName || it.firstName,
                            wmRole: full.profile?.role || null,
                            wmIndustry: full.profile?.industry || null,
                            wmLocation: full.profile?.location || null,
                            wmCompletion: full.profile?.completion ?? null,
                        };
                    }
                } catch (_) { /* skip */ }
                return it;
            }));
            items = enriched.concat(items.slice(50));
        }
        return { sinceHours: Number(sinceHours), count: items.length, items };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Multi-part send (cold outreach / WhatsApp-style sequence) ───────────────
fastify.post('/users/:id/send-multipart', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { parts, delayMs } = req.body as { parts: string[]; delayMs?: [number, number] };
    if (!Array.isArray(parts) || parts.length === 0) {
        return reply.code(400).send({ error: 'parts must be non-empty array' });
    }
    try {
        const { sendMultipart } = await import('./actions');
        const result = await sendMultipart(Number(id), parts, { delayMs });
        return { success: true, ...result };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Outreach queue admin endpoints ──────────────────────────────────────────
fastify.get('/outreach-queue/status', async () => getOutreachQueueStatus());
fastify.post('/outreach-queue/pause', async () => { pauseOutreachQueue(); return { ok: true, ...getOutreachQueueStatus() }; });
fastify.post('/outreach-queue/resume', async () => { resumeOutreachQueue(); return { ok: true, ...getOutreachQueueStatus() }; });
fastify.post('/outreach-queue/tick-now', async (req, reply) => {
    try {
        const r = await tickOutreachQueue(true);
        return { ...r, status: getOutreachQueueStatus() };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// Manually trigger the daily analyzer (also runs automatically at 04:00 UTC)
fastify.post('/brain/analyze-now', async (req, reply) => {
    try {
        const result = await runDailyAnalyzer();
        return result;
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// Human-in-loop: record an operator override as a LearnedScenario.
// Called when operator manually sends a reply that diverges from the AI draft.
fastify.post('/brain/record-override', async (req, reply) => {
    const { dialogueId, operatorMessage, replacedDraft } = req.body as {
        dialogueId: number;
        operatorMessage: string;
        replacedDraft?: string;
    };
    if (!dialogueId || !operatorMessage) return reply.code(400).send({ error: 'dialogueId + operatorMessage required' });
    try {
        const dialogue = await prisma.dialogue.findUnique({
            where: { id: dialogueId },
            include: {
                messages: { orderBy: { id: 'desc' }, take: 6 },
                user: true,
            },
        });
        if (!dialogue) return reply.code(404).send({ error: 'dialogue not found' });

        // The user's last message = trigger context
        const lastUserMsg = dialogue.messages.find((m: any) => m.sender === 'USER');
        if (!lastUserMsg) return reply.code(400).send({ error: 'no user message in history' });

        const item = await prisma.learnedScenario.create({
            data: {
                stage: dialogue.stage,
                trigger: `User said: "${lastUserMsg.text.slice(0, 200)}"`,
                recommend: operatorMessage.slice(0, 1000),
                avoid: replacedDraft ? `AI initially proposed: "${replacedDraft.slice(0, 300)}"` : null,
                source: 'human_override',
                notes: `Captured from dialogue ${dialogueId} (@${dialogue.user.username || dialogue.user.telegramId})`,
            },
        });
        return { success: true, scenario: item };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// Resolve a list of @usernames to TG IDs and check Wave Match registration
fastify.post('/admin/check-tg-users', async (req, reply) => {
    const { usernames } = (req.body || {}) as { usernames: string[] };
    if (!Array.isArray(usernames) || usernames.length === 0) {
        return reply.code(400).send({ error: 'usernames array required' });
    }
    const client = getClient();
    if (!client || !client.connected) return reply.code(503).send({ error: 'Telegram client not connected' });

    const { getUserByTelegramId, isWMEnabled } = await import('./wmClient');

    const results = await Promise.all(usernames.map(async (raw) => {
        const username = raw.replace(/^@/, '').trim();
        const out: any = { username };
        try {
            const entity = await client.getEntity(username);
            const e = entity as any;
            out.telegramId = String(e.id);
            out.firstName = e.firstName || null;
            out.lastName = e.lastName || null;
            out.isBot = !!e.bot;
        } catch (e: any) {
            out.tgError = e.message;
            return out;
        }
        if (!isWMEnabled()) {
            out.wmError = 'WM API not configured';
            return out;
        }
        try {
            const wm = await getUserByTelegramId(out.telegramId, 'profile,subscription');
            if (wm) {
                out.registered = true;
                out.wmId = wm.id;
                out.wmFirstName = wm.firstName;
                out.wmLastName = wm.lastName;
                out.wmEmail = wm.email;
                out.wmTier = wm.subscription?.tier;
                out.wmLocale = wm.locale;
                out.wmCrmTags = wm.crmTags;
                out.wmRole = wm.profile?.role;
                out.wmIndustry = wm.profile?.industry;
                out.wmLocation = wm.profile?.location;
                out.wmCompletion = wm.profile?.completion;
            } else {
                out.registered = false;
            }
        } catch (e: any) {
            out.wmError = e.message;
        }
        return out;
    }));
    return { results };
});

// Backfill gender from firstName for all UNKNOWN users
fastify.post('/broadcast/backfill-gender', async (req, reply) => {
    try {
        const result = await backfillGender();
        return result;
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ── Connect two users: drafts on both sides + MATCHED status ────────────────
fastify.post('/users/:aId/connect/:bId', async (req, reply) => {
    const { aId, bId } = req.params as { aId: string; bId: string };
    const { intro } = (req.body || {}) as { intro?: string };
    try {
        const result = await connectUsers(Number(aId), Number(bId), intro);
        emitEvent({ type: 'dialogue:updated', dialogueId: result.aDialogueId });
        emitEvent({ type: 'dialogue:updated', dialogueId: result.bDialogueId });

        // Notify admin about the match
        const [a, b] = await Promise.all([
            prisma.user.findUnique({ where: { id: Number(aId) }, select: { telegramId: true, username: true, firstName: true } }),
            prisma.user.findUnique({ where: { id: Number(bId) }, select: { telegramId: true, username: true, firstName: true } }),
        ]);
        await notifyLeads(`🤝 Match подготовлен: @${a?.username || aId} ↔ @${b?.username || bId}\nЧерновики готовы в обоих диалогах — проверь и отправь.`);

        // Push CRM notes to Wave Match for both sides (best-effort, async fire-and-forget)
        if (a?.telegramId && b?.telegramId) {
            (async () => {
                try {
                    const { getUserByTelegramId, addAiNote } = await import('./wmClient');
                    const [wmA, wmB] = await Promise.all([
                        getUserByTelegramId(a.telegramId),
                        getUserByTelegramId(b.telegramId),
                    ]);
                    if (wmA) await addAiNote(wmA.id, 'ai_match_proposed', `Предложен матч с @${b.username || b.telegramId}`, { tags: ['match'], linkedDialogId: result.aDialogueId });
                    if (wmB) await addAiNote(wmB.id, 'ai_match_proposed', `Предложен матч с @${a.username || a.telegramId}`, { tags: ['match'], linkedDialogId: result.bDialogueId });
                } catch (_) { }
            })();
        }

        return { success: true, ...result };
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: e.message });
    }
});

// Serve frontend
// fastify.register(fastifyStatic, {
//     root: path.join(__dirname, '../frontend/dist'),
//     prefix: '/',
// });

// Serve static files from public directory
// Serve React Frontend (Built)
try {
    const frontendDist = path.join(__dirname, '../frontend/dist');
    console.log(`[STATIC] Registering static files from: ${frontendDist}`);
    fastify.register(fastifyStatic, {
        root: frontendDist,
        prefix: '/',
        wildcard: false // Disable wildcard to allow API routes and manual SPA handling if needed
    });
} catch (e) {
    console.error('[STATIC] Failed to register static files:', e);
}

// Fallback for SPA routing
fastify.setNotFoundHandler(async (req, reply) => {
    if (req.raw.url && !req.raw.url.startsWith('/api')) {
        return reply.sendFile('index.html');
    }
    // API 404
    reply.code(404).send({ error: 'Not Found', statusCode: 404 });
});

// API Routes

fastify.get('/messages', async (request, reply) => {
    try {
        const messages = await prisma.message.findMany({
            include: { dialogue: { include: { user: true } } },
            orderBy: { createdAt: 'desc' },
            take: 50
        });
        return { messages };
    } catch (error) {
        return reply.code(500).send({ error: 'Failed to fetch messages' });
    }
});

fastify.get('/dialogues', async (req, reply) => {
    try {
        const dialogues = await prisma.dialogue.findMany({
            where: { status: 'ACTIVE' },
            include: {
                user: {
                    include: { sourceChat: true }
                },
                messages: {
                    orderBy: { id: 'desc' },
                    take: 1
                }
            },
            orderBy: { updatedAt: 'desc' }
        });
        return dialogues;
    } catch (e) {
        return reply.code(500).send({ error: 'Failed to fetch dialogues' });
    }
});

fastify.post('/dialogues/start', async (req, reply) => {
    const { username } = req.body as { username: string };
    if (!username) return reply.code(400).send({ error: 'Username required' });

    try {
        console.log(`[API] Starting dialogue with @${username}...`);
        const { user, dialogue } = await ensureUserAndDialogue(username, username, undefined, 'INBOUND');

        // Reset stage if needed
        if (dialogue.stage === 'CLOSED') {
            await prisma.dialogue.update({
                where: { id: dialogue.id },
                data: { stage: 'DISCOVERY', status: 'ACTIVE' }
            });
        }

        // Generate First Message
        const history: any[] = []; // Empty history for start
        const facts = (user.facts as any) || {};

        const gptResult = await generateResponse(
            history,
            'DISCOVERY', // Force Discovery stage
            user, // Fixed: Pass full user object
            {},
            []
        );

        if (gptResult) {
            await createDraftMessage(dialogue.id, gptResult.reply);
            return { success: true, dialogueId: dialogue.id, reply: gptResult.reply };
        } else {
            return reply.code(500).send({ error: 'Failed to generate initial message' });
        }

    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: e.message });
    }
});

fastify.post('/dialogues/:id/source', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { source } = req.body as { source: 'INBOUND' | 'SCOUT' };

    if (!['INBOUND', 'SCOUT'].includes(source)) {
        return reply.code(400).send({ error: 'Invalid source' });
    }

    try {
        const dialogue = await prisma.dialogue.update({
            where: { id: Number(id) },
            data: { source }
        });
        return dialogue;
    } catch (e) {
        return reply.code(500).send({ error: 'Failed to update source' });
    }
});

fastify.post('/dialogues/:id/archive', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        await prisma.dialogue.update({
            where: { id: Number(id) },
            data: { status: 'ARCHIVED' }
        });
        return { success: true };
    } catch (e) {
        return reply.code(500).send({ error: 'Failed' });
    }
});

fastify.get('/dialogues/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        const dialogue = await prisma.dialogue.findUnique({
            where: { id: parseInt(id) },
            include: {
                user: true,
                messages: { orderBy: { createdAt: 'asc' } }
            }
        });
        console.log(`DEBUG: Dialogue ${id} result:`, dialogue ? 'Found' : 'Null');
        if (!dialogue) {
            console.log(`DEBUG: Dialogue ${id} is null, returning 404`);
            return reply.code(404).send({ error: 'Dialogue not found (null)' });
        }
        return dialogue;
    } catch (e) {
        console.error(`DEBUG: Error fetching dialogue ${id}:`, e);
        req.log.error(e);
        return reply.code(404).send({ error: 'Dialogue not found (exception)' });
    }
});

// ── ADMIN RESET ──────────────────────────────────────────────────────────────

// Full wipe: clears all users, dialogues, messages, scout data
fastify.post('/admin/reset-db', async (req, reply) => {
    try {
        // Delete in correct FK order
        await prisma.message.deleteMany({});
        await prisma.scoutLead.deleteMany({});
        await prisma.scanHistory.deleteMany({});
        await prisma.dialogue.deleteMany({});
        await prisma.user.deleteMany({});
        await prisma.scannedChat.deleteMany({});
        console.log('[ADMIN] Full DB reset done');
        return { success: true, message: 'All data cleared' };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// Soft reset: just set all users back to NEW (keeps dialogues/messages)
fastify.post('/admin/reset-statuses', async (req, reply) => {
    try {
        const result = await prisma.user.updateMany({
            where: { status: { notIn: ['REJECTED', 'BLOCKED'] } },
            data: { status: 'NEW' }
        });
        console.log(`[ADMIN] Reset ${result.count} users to NEW`);
        return { success: true, updated: result.count };
    } catch (e: any) {
        return reply.code(500).send({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────

// Update user status (admin action)
fastify.patch('/users/:telegramId/status', async (req, reply) => {
    const { telegramId } = req.params as { telegramId: string };
    const { status } = req.body as { status: string };

    const validStatuses = ['NEW', 'CHAT', 'LEAD', 'QUALIFIED', 'REJECTED', 'MATCHED', 'BLOCKED', 'CUSTOMER'];
    if (!validStatuses.includes(status)) {
        return reply.code(400).send({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    try {
        const user = await prisma.user.update({
            where: { telegramId },
            data: { status: status as any }
        });
        return { success: true, user };
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: `Failed to update status: ${e.message}` });
    }
});


fastify.get('/status', async (request, reply) => {
    console.log('[API] /status called');
    try {
        const client = getClient();
        console.log(`[API] /status - Client exists: ${!!client}`);

        let connected = false;
        let me = null;

        if (client && client.connected) {
            console.log('[API] /status - Client connected, checking auth...');
            // Add timeout to prevent hanging
            const authCheck = Promise.race([
                client.isUserAuthorized(),
                new Promise<boolean>((_, reject) => setTimeout(() => reject('Timeout'), 2000))
            ]);

            try {
                connected = await authCheck;
                console.log(`[API] /status - Auth check result: ${connected}`);
                if (connected) {
                    const meCheck = Promise.race([
                        client.getMe(),
                        new Promise<any>((_, reject) => setTimeout(() => reject('Timeout'), 4000))
                    ]);
                    try {
                        me = await meCheck;
                        console.log(`[API] /status - Me check complete: @${me?.username}`);
                    } catch (meError) {
                        console.error('[API] /status - Me check failed:', meError);
                    }
                }
            } catch (e) {
                console.error('[API] /status check timed out or failed:', e);
                connected = false;
            }
        } else {
            console.log('[API] /status - Client NOT connected');
        }

        return { connected, me };
    } catch (err) {
        return { connected: false, error: err };
    }
});

fastify.post('/send', async (request, reply) => {
    // Frontend sends { dialogueId, message }
    const { dialogueId, message } = request.body as { dialogueId: number, message: string };

    // Support legacy { username, message } if needed? No, frontend uses dialogueId.
    if (!dialogueId || !message) return reply.code(400).send({ error: 'Missing fields (dialogueId, message)' });

    try {
        const dialogue = await prisma.dialogue.findUnique({
            where: { id: dialogueId },
            include: { user: true }
        });

        if (!dialogue) return reply.code(404).send({ error: 'Dialogue not found' });

        await sendMessageToUser(dialogue.userId, message);
        return { success: true };
    } catch (e: any) {
        request.log.error(e);
        return reply.code(500).send({ error: e.message });
    }
});

// --- Knowledge Base Routes ---

fastify.get('/kb', async (req, reply) => {
    try {
        const items = await prisma.knowledgeItem.findMany({
            orderBy: { createdAt: 'desc' }
        });
        return items;
    } catch (e) { return []; }
});

fastify.post('/kb', async (req, reply) => {
    const { question, answer } = req.body as { question: string, answer: string };
    if (!question || !answer) return reply.code(400).send({ error: 'Missing fields' });
    try {
        const item = await prisma.knowledgeItem.create({
            data: { question, answer }
        });
        return item;
    } catch (e) { return reply.code(500).send(e); }
});

// Candidates
fastify.get('/kb/candidates', async (req, reply) => {
    try {
        const items = await prisma.learningCandidate.findMany({
            where: { status: 'PENDING' },
            orderBy: { createdAt: 'desc' }
        });
        return items;
    } catch (e) { return []; }
});

fastify.post('/kb/candidates/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        // 1. Get candidate
        const candidate = await prisma.learningCandidate.findUnique({ where: { id: parseInt(id) } });
        if (!candidate) return reply.code(404).send({ error: 'Not found' });

        // 2. Create KB Item
        await prisma.knowledgeItem.create({
            data: {
                question: candidate.originalQuestion,
                answer: candidate.operatorAnswer
            }
        });

        // 3. Mark candidate as MERGED
        await prisma.learningCandidate.update({
            where: { id: parseInt(id) },
            data: { status: 'MERGED' }
        });

        return { success: true };
    } catch (e) { return reply.code(500).send(e); }
});

// --- Templates Routes ---
fastify.get('/templates', async (req, reply) => {
    // Mock templates for now, or add DB model if needed
    return [
        { id: 1, name: 'Greeting', content: 'Привет! Чем могу помочь?' },
        { id: 2, name: 'Services', content: 'Мы предлагаем услуги продвижения...' },
        { id: 3, name: 'Price', content: 'Наши цены начинаются от...' }
    ];
});

fastify.post('/messages/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { updatedText } = request.body as { updatedText?: string };

    try {
        const result = await sendDraftMessage(null, parseInt(id), updatedText);
        return result;
    } catch (err: any) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to approve message', details: err.message });
    }
});

fastify.put('/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { firstName, lastName, status } = req.body as { firstName?: string, lastName?: string, status?: string };

    try {
        const user = await prisma.user.update({
            where: { id: parseInt(id) },
            data: {
                firstName,
                lastName,
                status: status as any // Cast to enum if needed
            }
        });
        return user;
    } catch (e) {
        return reply.code(500).send({ error: 'Failed to update user' });

    }
});

fastify.post('/users/:id/block', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        await prisma.user.update({
            where: { id: parseInt(id) },
            data: { status: 'BLOCKED' }
        });
        return { success: true };
    } catch (e) {
        return reply.code(500).send({ error: 'Failed to block user' });
    }
});

fastify.post('/reconnect', async (req, reply) => {
    try {
        await reconnectClient();
        return { success: true };
    } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ error: 'Reconnection failed' });
    }
});

fastify.get('/login-qr', async (req, reply) => {
    try {
        const token = getQR();

        // Detailed debugging
        const client = getClient();
        console.log(`[DEBUG] /login-qr requested. Client exists: ${!!client}, Connected: ${client?.connected}, Token available: ${!!token}`);

        if (client?.connected && await client.isUserAuthorized()) {
            return reply.send({ status: 'connected', message: 'Client is already connected and authorized! No QR needed.' });
        }
        if (!token) {
            // Check if client is even initialized
            if (!client) {
                return reply.code(503).send({ error: 'Client not initialized yet. Please wait.' });
            }
        }
        if (client.connected) {
            // Double check if authorized
            if (await client.isUserAuthorized()) {
                return reply.send({ status: 'connected', message: 'Client is already connected and authorized! No QR needed.' });
            }
        }

        // If we are here, we need a QR code.
        // If token is missing, we can't generate it.
        if (!token) {
            return reply.code(404).send({ error: 'QR code not generated yet. Please wait a few seconds and try again.' });
        }

        const QRCode = require('qrcode');

        // Convert to Base64URL (RFC 4648)
        // 1. Convert to standard Base64
        // 2. Replace "+" with "-"
        // 3. Replace "/" with "_"
        // 4. Remove padding "="
        const tokenBase64 = token.toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        const url = `tg://login?token=${tokenBase64}`;

        console.log(`[DEBUG] QR Code URL: ${url}`);

        const buffer = await QRCode.toBuffer(url, {
            scale: 10,
            margin: 4, // Increased margin for better scanning
            errorCorrectionLevel: 'Q' // Higher error correction (L, M, Q, H)
        });

        reply.type('image/png');
        return buffer;
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: 'Failed to generate QR', details: e.message });
    }
});

fastify.post('/scan-chat', async (req, reply) => {
    const { chatLink, limit } = req.body as { chatLink: string, limit?: number };
    if (!chatLink) return reply.code(400).send({ error: 'Missing chatLink' });

    try {
        // Extract username from link if needed (e.g. t.me/username -> username)
        let username = chatLink.replace('https://t.me/', '').replace('@', '').split('/')[0];

        const result = await scanChatForLeads(username, limit || 50);
        return result;
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: 'Scan failed', details: e.message });
    }
});

fastify.post('/scout/start', async (req, reply) => {
    const { username, name, context, accessHash } = req.body as { username: string, name: string, context: string, accessHash?: string };
    if (!username || !context) return reply.code(400).send({ error: 'Missing fields' });

    try {
        // 0. Check Ignore Triggers
        const triggers = await prisma.ignoreTrigger.findMany();
        const shouldIgnore = triggers.some(t => {
            if (t.type === 'USERNAME') {
                return username.toLowerCase() === t.keyword.toLowerCase();
            }
            if (t.type === 'KEYWORD') {
                // For scouting, we might check context or bio if available, but context is usually the message we sent or they sent.
                // Let's check context.
                return context.toLowerCase().includes(t.keyword.toLowerCase());
            }
            return false;
        });

        if (shouldIgnore) {
            return reply.send({ ignored: true, message: 'User matches ignore triggers' });
        }

        // 1. Create/Get User & Dialogue
        const { user, dialogue } = await ensureUserAndDialogue(username, name, accessHash, 'SCOUT');

        // 2. Save "Context" message (as if user sent it)
        // Check if last message is duplicate to avoid spamming if clicked multiple times
        const lastMsg = await prisma.message.findFirst({
            where: { dialogueId: dialogue.id },
            orderBy: { id: 'desc' }
        });

        if (!lastMsg || lastMsg.text !== context) {
            await saveMessageToDb(dialogue.id, 'USER', context, 'RECEIVED');
        }

        // 3. Generate Draft (AI)
        // Fetch brief history
        const recentMessages = await prisma.message.findMany({
            where: { dialogueId: dialogue.id },
            orderBy: { id: 'desc' },
            take: 5
        });

        const history = recentMessages.reverse().map(m => ({
            sender: m.sender,
            text: m.text
        }));

        const facts = (user.facts as any) || {};
        // const templates = {}; // Could fetch templates here
        // const kbItems: any[] = [];

        const stage = dialogue.stage || 'DISCOVERY';

        const gptResult = await generateResponse(
            history,
            stage as any,
            user, // Fixed: Pass full user object
            {},
            []
        );

        if (gptResult) {
            await createDraftMessage(dialogue.id, gptResult.reply);
        }

        return { dialogueId: dialogue.id, user };

    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: 'Failed to start scouted chat', details: e.message });
    }
});

fastify.post('/messages/:id/feedback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { feedback } = req.body as { feedback: string };
    try {
        await prisma.message.update({
            where: { id: Number(id) },
            data: { feedback }
        });
        return { success: true };
    } catch (e) {
        return reply.code(500).send({ error: 'Failed' });
    }
});

fastify.post('/dialogues/:id/regenerate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { instructions } = req.body as { instructions?: string } || {};

    try {
        const dialogue = await prisma.dialogue.findUnique({
            where: { id: Number(id) },
            include: { user: true }
        });
        if (!dialogue) return reply.code(404).send({ error: 'Not found' });

        // Fetch history
        const recentMessages = await prisma.message.findMany({
            where: { dialogueId: dialogue.id },
            orderBy: { id: 'desc' },
            take: 50 // Increased from 10 to 50 for better context
        });

        const history = recentMessages.reverse().map(m => ({
            sender: m.sender,
            text: m.text
        }));

        const facts = (dialogue.user.facts as any) || {};

        // Fetch Rules (Global + User specific)
        const rules = await prisma.rule.findMany({
            where: {
                OR: [
                    { isGlobal: true },
                    { userId: dialogue.userId }
                ],
                isActive: true
            }
        });

        console.log(`[GPT] Fetched ${rules.length} rules for generation.`);


        const ruleStrings = rules.map(r => r.content);

        // Pass instructions and rules to GPT
        const gptResult = await generateResponse(
            history,
            dialogue.stage as any,
            dialogue.user, // Fixed: Pass full user object
            {},
            [],
            instructions, // <--- New Argument
            ruleStrings   // <--- Passed Rules
        );

        if (gptResult) {
            // Save extracted profile data if present
            if (gptResult.extractedProfile && Object.keys(gptResult.extractedProfile).length > 0) {
                console.log('[GPT] Saving extracted profile:', gptResult.extractedProfile);
                const { id, ...profileData } = gptResult.extractedProfile as any;
                await prisma.user.update({
                    where: { id: dialogue.userId },
                    data: profileData
                });
            }

            await createDraftMessage(dialogue.id, gptResult.reply);
            return { success: true };
        } else {
            return reply.code(500).send({ error: 'GPT failed to generate response' });
        }

    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: 'Failed' });
    }
});

// --- Rules Management ---
// ... (Previous Rules Code)

// --- Scout Routes ---

// Get personal inbox dialogs as scout leads
fastify.get('/scout/personal-chats', async (req, reply) => {
    const client = getClient();
    if (!client || !client.connected) {
        return reply.code(503).send({ error: 'Telegram client not connected' });
    }

    const { limit } = req.query as { limit?: string };
    const fetchLimit = Math.min(parseInt(limit || '200'), 500);

    try {
        const dialogs = await client.getDialogs({ limit: fetchLimit });

        const leads: any[] = [];

        for (const d of dialogs) {
            // Only private user chats (Личные)
            if (!d.isUser) continue;

            const entity = d.entity as any;

            // Skip bots and self
            if (entity.bot || entity.self) continue;

            const username = entity.username || null;
            const firstName = entity.firstName || '';
            const lastName = entity.lastName || '';
            const telegramId = entity.id?.toString() || null;
            const accessHash = entity.accessHash?.toString() || null;

            // Last message from dialog
            const lastMsg = d.message as any;
            const lastText = lastMsg?.message || lastMsg?.text || '';
            const lastDate = lastMsg?.date ? new Date(lastMsg.date * 1000).toISOString() : null;

            leads.push({
                sender: {
                    id: telegramId,
                    username,
                    firstName,
                    lastName,
                    accessHash
                },
                message: lastText,
                date: lastDate,
                isPersonal: true
            });
        }

        console.log(`[Scout] Found ${leads.length} personal dialogs`);
        return { leads, total: leads.length };

    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: `Failed to fetch personal chats: ${e.message}` });
    }
});

// List monitored chats
fastify.get('/scout/chats', async (req, reply) => {
    const chats = await prisma.scannedChat.findMany({ orderBy: { scannedAt: 'desc' } });
    return chats;
});

// Add a new chat to monitor
fastify.post('/scout/chats', async (req, reply) => {
    const { link } = req.body as { link: string };
    try {
        const client = getClient();
        if (!client || !client.connected) return reply.code(503).send({ error: 'Telegram client not connected' });

        let entity: any;
        let title: string = link;
        let username: string | null = null;
        let id: string | null = null;
        let accessHash: string | null = null;

        // Check for invite link
        const inviteMatch = link.match(/(?:t\.me\/|telegram\.me\/)(?:\+|joinchat\/)([\w-]+)/);

        if (inviteMatch) {
            const hash = inviteMatch[1];
            // ... (Keep existing invite logic)
            // I need to see if I can reuse the existing block efficiently
            // Ideally I'd just modify the entity handling.
            // But the existing block is big. Assuming I won't rewrite it all here.
            // Let's assume the previous block runs and sets `entity`.
            // I will replace from `if (inviteMatch)` start or check if I can just edit the entity extraction part.
            // Let's edit the variable declarations and the extraction logic at the end.
            // But I need to view the file to be safe.
            // I'll take a shortcut: I see lines 669-730 in previous `view_file` output (Step 7356).
            // I'll replace the block from `let entity...` to `prisma.create`.

        } else {
            // Standard username/link
            entity = await client.getEntity(link);
        }

        if (entity) {
            title = entity.title || entity.username || link;
            username = entity.username || null;
            id = entity.id.toString();
            if (entity.accessHash) {
                accessHash = entity.accessHash.toString();
            }
        } else {
            throw new Error('Could not resolve chat entity.');
        }

        const chat = await prisma.scannedChat.create({
            data: {
                link,
                title,
                username: username || id || link, // Use ID if no username
                accessHash: accessHash
            }
        });
        return chat;
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: `Failed to add chat: ${e.message}` });
    }
});

// ─── Background Scan Job System ──────────────────────────────────────────────
type ScanJob = {
    id: string;
    status: 'running' | 'done' | 'error';
    leads: any[];
    chatTitle: string;
    progress: number; // 0-100
    error?: string;
    createdAt: Date;
};
const scanJobs = new Map<string, ScanJob>();

// Cleanup jobs older than 10 minutes
setInterval(() => {
    const TEN_MIN = 10 * 60 * 1000;
    const now = Date.now();
    scanJobs.forEach((job, id) => {
        if (now - job.createdAt.getTime() > TEN_MIN) scanJobs.delete(id);
    });
}, 60_000);

// Helper to get accessHash for a chat
async function resolveAccessHash(username: string): Promise<string | undefined> {
    let accessHash: string | undefined;
    try {
        const chat = await prisma.scannedChat.findFirst({
            where: { OR: [{ username }, { link: { contains: username } }] }
        });
        if (chat?.accessHash) return chat.accessHash;
        if (chat?.link) {
            const client = getClient();
            if (client?.connected) {
                const entity = await client.getEntity(chat.link);
                if (entity && (entity as any).accessHash) {
                    accessHash = (entity as any).accessHash.toString();
                    try { await prisma.scannedChat.update({ where: { id: chat.id }, data: { accessHash } }); } catch (_) { }
                }
            }
        }
    } catch (_) { }
    return accessHash;
}

// Start async scan job
fastify.post('/scout/scan/start', async (req, reply) => {
    const { username, limit, keywords } = req.body as { username: string; limit?: number; keywords?: string };
    if (!username) return reply.code(400).send({ error: 'username required' });

    const scanLimit = Math.min(limit || 50, 3000); // allow up to 3000
    const customKeywords = keywords ? keywords.split(',').map(k => k.trim()).filter(k => k) : undefined;
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const job: ScanJob = { id: jobId, status: 'running', leads: [], chatTitle: username, progress: 0, createdAt: new Date() };
    scanJobs.set(jobId, job);

    // Run in background (don't await)
    (async () => {
        try {
            const accessHash = await resolveAccessHash(username);
            job.progress = 10;

            const result = await scanChatForLeads(username, scanLimit, customKeywords, accessHash);
            const allLeads: any[] = Array.isArray(result) ? result : (result.leads || []);
            job.chatTitle = Array.isArray(result) ? username : (result.chatTitle || username);
            job.progress = 90;

            // Persist leads to DB (ScoutLead table) so they survive restarts
            try {
                // Find or create ScannedChat record
                let scannedChat = await prisma.scannedChat.findFirst({
                    where: { OR: [{ username }, { link: { contains: username } }] }
                });
                if (!scannedChat) {
                    scannedChat = await prisma.scannedChat.create({
                        data: { username, title: job.chatTitle, link: username, accessHash }
                    });
                } else if (job.chatTitle && job.chatTitle !== username) {
                    await prisma.scannedChat.update({ where: { id: scannedChat.id }, data: { title: job.chatTitle } });
                }

                // Save each lead as a ScoutLead (skip duplicates by senderUsername)
                const existingUsernames = new Set(
                    (await prisma.scoutLead.findMany({
                        where: { scannedChatId: scannedChat.id },
                        select: { senderUsername: true }
                    })).map(l => l.senderUsername)
                );

                const newLeads = allLeads.filter(l => l.sender?.username && !existingUsernames.has(l.sender.username));
                if (newLeads.length > 0) {
                    await prisma.scoutLead.createMany({
                        data: newLeads.map(l => ({
                            scannedChatId: scannedChat!.id,
                            senderUsername: l.sender?.username,
                            senderId: l.sender?.id?.toString(),
                            text: l.message || l.text || ''
                        }))
                    });
                    console.log(`[ScanJob] Saved ${newLeads.length} new ScoutLeads to DB`);
                }

                await prisma.scannedChat.update({
                    where: { id: scannedChat.id },
                    data: { lastLeadsCount: allLeads.length, scannedAt: new Date() }
                });
            } catch (dbErr) {
                console.error('[ScanJob] Failed to persist leads to DB:', dbErr);
            }

            job.leads = allLeads;
            job.progress = 100;
            job.status = 'done';
            console.log(`[ScanJob] ${jobId} done: ${allLeads.length} leads from ${username}`);
        } catch (e: any) {
            job.status = 'error';
            job.error = e.message;
            console.error(`[ScanJob] ${jobId} failed:`, e);
        }
    })();

    return { jobId };
});

// Poll scan job status
fastify.get('/scout/scan/:jobId', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = scanJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found or expired' });
    return {
        status: job.status,
        progress: job.progress,
        chatTitle: job.chatTitle,
        leads: job.status === 'done' ? job.leads : [],
        error: job.error
    };
});

// Get leads from a chat (Live Scan)
fastify.get('/scout/chats/:username/leads', async (req, reply) => {
    const { username } = req.params as { username: string };
    const { limit, keywords } = req.query as { limit?: string, keywords?: string };
    const rawLimit = limit ? parseInt(limit) : 50;
    const scanLimit = Math.min(rawLimit, 300); // Cap at 300 to prevent Railway timeout
    if (rawLimit > 300) console.warn(`[Scout] Requested limit ${rawLimit} capped to 300.`);
    const customKeywords = keywords ? keywords.split(',').map(k => k.trim()).filter(k => k.length > 0) : undefined;

    try {
        // Try to fetch accessHash if chatUsername is potentially a numeric ID
        let accessHash: string | undefined;

        // Find the chat in DB to get AccessHash if available
        let chat;
        try {
            chat = await prisma.scannedChat.findFirst({
                where: {
                    OR: [
                        { username: username }, // Matches stored ID or username
                        { link: { contains: username } }
                    ]
                }
            });
        } catch (dbErr) {
            console.warn('[Scout] DB not available for finding chat (non-critical):', dbErr);
        }

        if (chat) {
            if (chat.accessHash) {
                accessHash = chat.accessHash;
            } else if (chat.link) {
                // Self-healing: Try to resolve link to get accessHash if missing
                try {
                    const client = getClient();
                    if (client && client.connected) {
                        const entity = await client.getEntity(chat.link);
                        if (entity && (entity as any).accessHash) {
                            accessHash = (entity as any).accessHash.toString();
                            // Optional update try/catch
                            try {
                                await prisma.scannedChat.update({
                                    where: { id: chat.id },
                                    data: { accessHash: accessHash }
                                });
                            } catch (e) { /* ignore update fail */ }
                            console.log(`[Scout] create/update accessHash for ${chat.username}`);
                        }
                    }
                } catch (e) {
                    console.warn(`[Scout] Could not resolve link '${chat.link}' to fill accessHash:`, e);
                }
            }
        }

        // scanChatForLeads handles the logic
        // Wrap in a 50s timeout so Railway (60s limit) doesn't kill the connection
        const TIMEOUT_MS = 50_000;
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('SCAN_TIMEOUT')), TIMEOUT_MS)
        );

        try {
            const result = await Promise.race([
                scanChatForLeads(username, scanLimit, customKeywords, accessHash),
                timeoutPromise
            ]);
            return result;
        } catch (timeoutErr: any) {
            if (timeoutErr.message === 'SCAN_TIMEOUT') {
                req.log.warn(`[Scout] Scan of ${username} timed out after ${TIMEOUT_MS / 1000}s`);
                return reply.code(200).send({ leads: [], chatTitle: username, timedOut: true, error: 'Scan took too long. Try a smaller limit.' });
            }
            throw timeoutErr; // re-throw for the outer catch
        }
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: `Scan failed: ${e.message}` });
    }
});

// Get Scan History
fastify.get('/scout/history', async (req, reply) => {
    try {
        const history = await prisma.scanHistory.findMany({
            include: { chat: true },
            orderBy: { createdAt: 'desc' },
            take: 50
        });
        return history;
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: 'Failed to fetch history' });
    }
});

fastify.get('/scout/history/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        const entry = await prisma.scanHistory.findUnique({
            where: { id: parseInt(id) },
            include: { chat: true }
        });
        if (!entry) return reply.code(404).send({ error: 'History not found' });
        return entry;
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: 'Failed to fetch history entry' });
    }
});

// Analyze a lead (AI)
fastify.post('/scout/analyze', async (req, reply) => {
    const { text, user } = req.body as { text: string, user: any };
    try {
        // 1. Fetch Context (Rules & Knowledge Base)
        const rules = await prisma.rule.findMany({
            where: { isActive: true, isGlobal: true }
        });

        const kbItems = await prisma.knowledgeItem.findMany();

        const kbContext = [
            ...rules.map(r => `[RULE]: ${r.content}`),
            ...kbItems.map(k => `[Q]: ${k.question}\n[A]: ${k.answer}`)
        ].join('\n\n');

        // 1.1 Fetch Feedback Examples (In-Context Learning)
        const relevantExamples = await prisma.scoutLead.findMany({
            where: { relevance: 'RELEVANT' },
            take: 5,
            orderBy: { createdAt: 'desc' },
            select: { text: true }
        });

        const irrelevantExamples = await prisma.scoutLead.findMany({
            where: { relevance: 'IRRELEVANT' },
            take: 5,
            orderBy: { createdAt: 'desc' },
            select: { text: true }
        });

        const userContext = `
        Message: "${text}"
        Sender: ${user.firstName} ${user.lastName || ''} (@${user.username})
        `;

        // 2. Call AI
        const result = await analyzeText(
            text,
            userContext,
            kbContext,
            // Pass examples as separate args or part of context?
            // Let's modify analyzeText
            {
                positive: relevantExamples.map(e => e.text),
                negative: irrelevantExamples.map(e => e.text)
            }
        );

        if (result) {
            return result;
        } else {
            return reply.code(500).send({ error: 'AI Analysis failed to return data' });
        }
    } catch (e) {
        req.log.error(e);
        return reply.code(500).send({ error: 'AI Analysis exception' });
    }
});



fastify.post('/scout/send-dm', async (req, reply) => {
    const { username, text, name, accessHash } = req.body as { username: string, text: string, name: string, accessHash?: string };
    try {
        const result = await sendScoutDM(username, text, name || username, accessHash);
        return result;
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: 'Failed to send DM' });
    }
});

fastify.post('/scout/reply-chat', async (req, reply) => {
    const { chatUsername, messageId, text } = req.body as { chatUsername: string, messageId: number, text: string };
    try {
        await sendReplyInChat(chatUsername, messageId, text);
        return { success: true };
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: 'Failed to reply in chat' });
    }
});

// Import Lead (Save to DB)
fastify.post('/scout/import', async (req, reply) => {
    const { user, profile, draft, sourceChatId } = req.body as { user: any, profile: any, draft: string, sourceChatId: number };

    try {
        // 1. Ensure User & Dialogue
        const { user: dbUser, dialogue } = await ensureUserAndDialogue(
            user.username || user.id,
            user.firstName || 'Unknown',
            user.accessHash,
            'SCOUT'
        );

        // 2. Strip system/schema fields that can't be directly written via update
        const allowedProfileFields = [
            'city', 'activity', 'businessCard', 'bestClients', 'requests',
            'hobbies', 'currentIncome', 'desiredIncome', 'networkingGoal',
            'firstName', 'lastName', 'username', 'bio', 'tags', 'facts',
            'status', 'profileStatus'
        ];
        const safeProfile: Record<string, any> = {};
        for (const key of allowedProfileFields) {
            if (profile && profile[key] !== undefined) {
                safeProfile[key] = profile[key];
            }
        }

        // 3. Update Profile & Source
        await prisma.user.update({
            where: { id: dbUser.id },
            data: {
                ...safeProfile,
                sourceChatId: sourceChatId || null
            }
        });

        // 4. Create Draft Message
        await createDraftMessage(dialogue.id, draft);

        return { success: true, userId: dbUser.id };
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: `Import failed: ${e.message}` });
    }
});


fastify.get('/rules', async (req, reply) => {
    const { userId } = req.query as { userId?: string };
    try {
        const where: any = { isActive: true };
        if (userId) {
            where.OR = [
                { isGlobal: true },
                { userId: Number(userId) }
            ];
        }
        const rules = await prisma.rule.findMany({ where, orderBy: { createdAt: 'desc' } });
        return rules;
    } catch (e) {
        return reply.code(500).send({ error: 'Failed to fetch rules' });
    }
});

fastify.post('/rules', async (req, reply) => {
    const { content, isGlobal, userId } = req.body as { content: string, isGlobal?: boolean, userId?: number };
    try {
        const rule = await prisma.rule.create({
            data: {
                content,
                isGlobal: isGlobal || false,
                userId: userId ? Number(userId) : null,
                isActive: true
            }
        });
        return rule;
    } catch (e) {
        return reply.code(500).send({ error: 'Failed to create rule' });
    }
});

fastify.delete('/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        await prisma.rule.delete({ where: { id: Number(id) } });
        return { success: true };
    } catch (e) {
        return reply.code(500).send({ error: 'Failed to delete rule' });
    }
});

// --- Sync & Leads ---
fastify.post('/sync-chats', async (req, reply) => {
    const client = getClient();
    if (!client || !client.connected) {
        return reply.code(503).send({ error: 'Telegram client not connected' });
    }

    try {
        const { limit } = req.body as { limit?: number } || {};
        // Increase default limit to 500 to catch personal chats buried under spam
        const fetchLimit = limit || 500;
        const dialogs = await client.getDialogs({ limit: fetchLimit });

        // Debug counters
        let count = 0;
        let debugUsers = 0;
        let debugContacts = 0;

        for (const d of dialogs) {
            // We only want private chats (users)
            if (!d.isUser) continue;
            debugUsers++;

            const entity = d.entity as any;
            const telegramId = entity.id.toString();
            // Check if it's a mutual contact or contact
            const isContact = entity.contact || entity.mutualContact || false;
            if (isContact) debugContacts++;

            const username = entity.username || null;
            const firstName = entity.firstName || null;
            const lastName = entity.lastName || null;

            // 1. Upsert User
            const user = await prisma.user.upsert({
                where: { telegramId },
                update: {
                    username,
                    firstName,
                    lastName,
                },
                create: {
                    telegramId,
                    username,
                    firstName,
                    lastName,
                    status: 'NEW',
                }
            });

            // 2. Upsert Dialogue
            let dialogue = await prisma.dialogue.findFirst({
                where: { userId: user.id }
            });

            if (!dialogue) {
                dialogue = await prisma.dialogue.create({
                    data: {
                        userId: user.id,
                        status: 'ACTIVE',
                        // If it's a contact, DEFINITELY Direct. Otherwise default to Inbound.
                        source: 'INBOUND',
                        stage: 'DISCOVERY'
                    }
                });
                count++;
            } else {
                // Fix: If it IS a contact, ensure it is INBOUND (Direct)
                // This helps fix the "Bulk Move" issue where contacts were moved to Scout
                if (isContact && dialogue.source === 'SCOUT') {
                    await prisma.dialogue.update({
                        where: { id: dialogue.id },
                        data: { source: 'INBOUND' }
                    });
                    count++; // Count updates too so user knows something happened
                }
            }

            // --- Feature: Sync Message History for Contacts ---
            // If it's a contact or direct chat, and has NO messages, fetch history so it's not empty.
            if (isContact || dialogue.source === 'INBOUND') {
                const msgCount = await prisma.message.count({ where: { dialogueId: dialogue.id } });
                console.log(`[Sync] Checking ${username} (ID: ${telegramId}). isContact: ${isContact}, Source: ${dialogue.source}, Msgs: ${msgCount}`);

                if (msgCount === 0) {
                    try {
                        console.log(`[Sync] Fetching history for ${username}...`);
                        const history = await client.getMessages(entity, { limit: 20 }); // Increased to 20
                        console.log(`[Sync] Fetched ${history.length} messages.`);

                        let imported = 0;
                        for (const msg of history) {
                            if (!msg.message) continue;

                            // Determine sender
                            // If out=true, it's Me (Operator/Simulator). If false, it's User.
                            const sender = msg.out ? 'OPERATOR' : 'USER';

                            await prisma.message.create({
                                data: {
                                    dialogueId: dialogue.id,
                                    text: msg.message,
                                    sender: sender,
                                    status: 'SENT',
                                    createdAt: new Date(msg.date * 1000)
                                }
                            });
                            imported++;
                        }
                        if (imported > 0) count++; // Count this as an update
                    } catch (e) {
                        console.error(`Failed to sync history for ${username}:`, e);
                    }
                }
            } else {
                console.log(`[Sync] Skipping message sync for ${username} (Not Contact/Inbound)`);
            }
        }
        return {
            success: true,
            count,
            message: `Synced ${count} updates. (Fetched: ${dialogs.length}, Users: ${debugUsers}, Contacts: ${debugContacts})`
        };
    } catch (e: any) {
        req.log.error(e);
        return reply.code(500).send({ error: 'Sync failed', details: e.message });
    }
});


fastify.post('/users/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status: string }; // 'LEAD', 'NEW', etc.

    try {
        const user = await prisma.user.update({
            where: { id: Number(id) },
            data: { status: status as any }
        });
        return user;
    } catch (e) {
        return reply.code(500).send({ error: 'Failed to update status' });
    }
});

// --- Ignore Triggers ---

fastify.get('/triggers', async (req, reply) => {
    try {
        const triggers = await prisma.ignoreTrigger.findMany({ orderBy: { createdAt: 'desc' } });
        return triggers;
    } catch (e) {
        return reply.code(500).send({ error: 'Failed to fetch triggers' });
    }
});

fastify.post('/triggers', async (req, reply) => {
    const { keyword, type } = req.body as { keyword: string, type?: string };
    if (!keyword) return reply.code(400).send({ error: 'Keyword is required' });

    try {
        const trigger = await prisma.ignoreTrigger.create({
            data: {
                keyword: keyword.toLowerCase().trim(),
                type: type || 'KEYWORD'
            }
        });
        return trigger;
    } catch (e: any) {
        // Unique constraint violation
        if (e.code === 'P2002') {
            return reply.code(400).send({ error: 'Trigger already exists' });
        }
        return reply.code(500).send({ error: 'Failed to create trigger' });
    }
});

fastify.delete('/triggers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
        await prisma.ignoreTrigger.delete({ where: { id: Number(id) } });
        return { success: true };
    } catch (e) {
        return reply.code(500).send({ error: 'Failed to delete trigger' });
    }
});

// SPA Fallback - Disabled for Vanilla JS
// fastify.setNotFoundHandler((req, reply) => {
//     if (req.raw.url?.startsWith('/api')) {
//         reply.code(404).send({ error: 'Not Found' });
//     } else {
//         reply.sendFile('index.html');
//     }
// });

const start = async () => {
    try {
        console.log('[STARTUP] Starting server...');
        console.log(`[STARTUP] NODE_ENV: ${process.env.NODE_ENV}`);
        console.log(`[STARTUP] Current Directory: ${__dirname}`);

        // Env Checks
        if (!process.env.DATABASE_URL) console.error('[STARTUP] ⚠️  DATABASE_URL is missing!');
        if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
            console.error('[STARTUP] ⚠️  Both ANTHROPIC_API_KEY and OPENAI_API_KEY missing — AI replies will fail!');
        }
        if (!process.env.TELEGRAM_API_ID) console.error('[STARTUP] ⚠️  TELEGRAM_API_ID is missing!');
        if (!process.env.TELEGRAM_API_HASH) console.error('[STARTUP] ⚠️  TELEGRAM_API_HASH is missing!');
        if (!process.env.ADMIN_USERNAME) console.warn('[STARTUP] ℹ️  ADMIN_USERNAME not set, defaulting to roman_arctur');

        // Wave Match integration (graceful: warns, doesn't fail)
        if (!isWMEnabled()) {
            console.warn('[STARTUP] ℹ️  Wave Match API integration disabled (WAVE_CONNECT_BASE_URL/WAVE_CONNECT_API_TOKEN missing)');
        } else {
            console.log(`[STARTUP] ✓ Wave Match API integration enabled (base: ${(process.env.WAVE_CONNECT_BASE_URL || process.env.WM_API_BASE_URL || '').replace(/^https?:\/\//, '').split('/')[0]})`);
        }
        if (!process.env.WAVE_CONNECT_WEBHOOK_SECRET && !process.env.WM_WEBHOOK_SECRET) {
            console.warn('[STARTUP] ⚠️  WAVE_CONNECT_WEBHOOK_SECRET missing — incoming WM webhooks will be rejected');
        }

        // Debug Frontend Path
        const frontendPath = path.join(__dirname, '../frontend/dist');
        console.log(`[STARTUP] Frontend Path: ${frontendPath}`);
        if (require('fs').existsSync(frontendPath)) {
            console.log('[STARTUP] Frontend directory exists.');
            console.log('[STARTUP] Contents:', require('fs').readdirSync(frontendPath));
        } else {
            console.error('[STARTUP] ERROR: Frontend directory DOES NOT EXIST!');
        }

        console.log('[STARTUP] Connecting to Database...');
        try {
            await prisma.$connect();
            console.log('[STARTUP] Database connected.');

            // Seed broadcast scenarios + backfill gender from names
            try { await seedScenarios(); } catch (e) { console.error('[STARTUP] seedScenarios failed:', e); }
            try { await backfillGender(); } catch (e) { console.error('[STARTUP] backfillGender failed:', e); }
            // Start the Brain analyzer cron (runs daily at 04:00 UTC)
            try { startBrainAnalyzerCron(); } catch (e) { console.error('[STARTUP] brain cron failed:', e); }
            try { startOutreachQueue(); } catch (e) { console.error('[STARTUP] outreach queue failed:', e); }
            try { startPendingSendsTick(); } catch (e) { console.error('[STARTUP] pending sends tick failed:', e); }
            try { startNewUsersScanner(); } catch (e) { console.error('[STARTUP] new users scanner failed:', e); }
            try { startMeetupFollowupCron(); } catch (e) { console.error('[STARTUP] meetup followup failed:', e); }
            try { startCardsFollowupCron(); } catch (e) { console.error('[STARTUP] cards followup failed:', e); }
            try { startDailyBatchSweep(); } catch (e) { console.error('[STARTUP] daily batch sweep failed:', e); }

            // One-shot dedupe: leave only newest DRAFT per dialogue
            try {
                const drafts = await prisma.message.findMany({
                    where: { status: 'DRAFT' },
                    select: { id: true, dialogueId: true },
                    orderBy: [{ dialogueId: 'asc' }, { createdAt: 'desc' }],
                });
                const seen = new Set<number>();
                const stale: number[] = [];
                for (const m of drafts) {
                    if (seen.has(m.dialogueId)) stale.push(m.id);
                    else seen.add(m.dialogueId);
                }
                if (stale.length > 0) {
                    await prisma.message.deleteMany({ where: { id: { in: stale } } });
                    console.log(`[STARTUP] Removed ${stale.length} duplicate drafts`);
                }
            } catch (e) { console.error('[STARTUP] dedupe-drafts failed:', e); }

            // Un-reject the admin user so the bot doesn't ignore them.
            // Listener also auto-skips messages from ADMIN_USERNAME, so this is
            // just hygiene if someone manually rejected the admin earlier.
            try {
                const adminUsername = process.env.ADMIN_USERNAME || 'roman_arctur';
                const result = await prisma.user.updateMany({
                    where: {
                        OR: [
                            { username: adminUsername },
                            { telegramId: adminUsername },
                        ],
                        status: 'REJECTED',
                    },
                    data: { status: 'NEW' },
                });
                if (result.count > 0) {
                    console.log(`[STARTUP] Un-rejected admin user @${adminUsername}`);
                }
            } catch (e) { console.error('[STARTUP] un-reject admin failed:', e); }
        } catch (dbErr) {
            console.error('[STARTUP] ⚠️ Database connection failed (Non-critical for some features):', dbErr);
        }

        const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
        console.log(`[STARTUP] Binding to 0.0.0.0:${port}`);

        await fastify.listen({ port, host: '0.0.0.0' });
        console.log(`[STARTUP] Server listening on http://0.0.0.0:${port}`);

        // Initialize GramJS
        console.log('[STARTUP] Initializing GramJS...');
        await initClient();
        console.log('[STARTUP] GramJS initialization complete.');

        const client = getClient();
        if (client) {
            console.log("GramJS Client initialized. Starting listener...");
            startListener(client).catch(err => console.error("Listener failed:", err));
        } else {
            console.log("GramJS Client not ready. Listening for QR code login.");
        }

    } catch (err) {
        console.error('[STARTUP] FATAL ERROR:', err);
        fastify.log.error(err);
        process.exit(1);
    }
};


start();
