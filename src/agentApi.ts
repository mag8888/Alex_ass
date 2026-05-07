// ── Agent API ─────────────────────────────────────────────────────────────
// Read-only endpoints + draft-create для внешних AI-агентов / помощников.
// Требуется X-API-Key header (env AGENT_API_KEY).

import { FastifyInstance } from 'fastify';
import prisma from './db';
import { createDraftMessage } from './actions';
import { getUserByTelegramId } from './wmClient';
import { enqueuePending, notifyAdminAboutPending } from './pendingSends';

export function registerAgentApi(fastify: FastifyInstance) {
    // Middleware — все /agent/* требуют API-key
    fastify.addHook('preHandler', async (req, reply) => {
        if (!req.url.startsWith('/agent/')) return;
        const key = (req.headers['x-api-key'] as string | undefined)?.trim();
        const expected = (process.env.AGENT_API_KEY || '').trim();
        if (!expected) return reply.code(503).send({ error: 'AGENT_API_KEY not configured on server' });
        if (!key || key !== expected) return reply.code(401).send({ error: 'invalid api key' });
    });

    // GET /agent/dialogs — список диалогов
    fastify.get('/agent/dialogs', async (req) => {
        const q = req.query as { status?: string; limit?: string; sinceHours?: string };
        const limit = Math.min(Number(q.limit || 50), 200);
        const where: any = {};
        if (q.status) where.status = q.status;
        if (q.sinceHours) {
            where.updatedAt = { gt: new Date(Date.now() - Number(q.sinceHours) * 3600_000) };
        }
        const dlgs = await prisma.dialogue.findMany({
            where, take: limit, orderBy: { updatedAt: 'desc' },
            include: {
                user: { select: { id: true, username: true, firstName: true, telegramId: true, status: true, autoReply: true } },
                _count: { select: { messages: true } },
            },
        });
        return dlgs.map(d => ({
            id: d.id,
            stage: d.stage,
            status: d.status,
            outcome: d.outcome,
            updatedAt: d.updatedAt,
            user: d.user,
            messageCount: d._count.messages,
        }));
    });

    // GET /agent/dialogs/:id — диалог + сообщения + WM-профиль
    fastify.get('/agent/dialogs/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const dlg = await prisma.dialogue.findUnique({
            where: { id: Number(id) },
            include: {
                user: true,
                messages: { orderBy: { id: 'asc' }, take: 200 },
            },
        });
        if (!dlg) return reply.code(404).send({ error: 'not found' });

        // Подтянуть WM-профиль если есть username
        let wmProfile: any = null;
        if (dlg.user.username) {
            try {
                const wm: any = await getUserByTelegramId(dlg.user.username, 'profile');
                if (wm) {
                    wmProfile = {
                        id: wm.id,
                        firstName: wm.firstName,
                        lastName: wm.lastName,
                        registered: wm.registered ?? true,
                        profile: wm.profile || null,
                    };
                }
            } catch (_) { /* skip */ }
        }

        return {
            id: dlg.id,
            stage: dlg.stage,
            status: dlg.status,
            outcome: dlg.outcome,
            updatedAt: dlg.updatedAt,
            user: dlg.user,
            wmProfile,
            messages: dlg.messages.map(m => ({
                id: m.id,
                sender: m.sender,
                status: m.status,
                text: m.text,
                createdAt: m.createdAt,
            })),
        };
    });

    // GET /agent/users/:id — детали юзера (local + WM)
    fastify.get('/agent/users/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const u = await prisma.user.findUnique({ where: { id: Number(id) } });
        if (!u) return reply.code(404).send({ error: 'not found' });
        let wm: any = null;
        if (u.username) {
            try {
                wm = await getUserByTelegramId(u.username, 'profile');
            } catch (_) { /* skip */ }
        }
        return { local: u, wm };
    });

    // GET /agent/principles — наши правила (для контекста)
    fastify.get('/agent/principles', async () => ({
        principles: [
            'Принципы 1-19 в src/gpt.ts на main: https://github.com/mag8888/AI_ASS/blob/main/src/gpt.ts',
            'Memory: https://github.com/mag8888/AI_ASS — папка .claude/projects/-Users-ADMIN-AI-ASS/memory/ (доступ только локально)',
            'Ключевое: всегда «Вы», никаких фейковых данных, при сомнении — silent escalation, brief humanlike, не более 1 вопроса за реплику',
        ],
    }));

    // POST /agent/draft — агент предлагает draft, мы создаём DRAFT + DM Роману
    fastify.post('/agent/draft', async (req, reply) => {
        const body = req.body as { dialogueId: number; text: string; reasoning?: string };
        if (!body.dialogueId || !body.text) return reply.code(400).send({ error: 'dialogueId + text required' });
        try {
            const dlg = await prisma.dialogue.findUnique({ where: { id: body.dialogueId } });
            if (!dlg) return reply.code(404).send({ error: 'dialogue not found' });
            const draft = await createDraftMessage(dlg.id, body.text);
            try {
                enqueuePending(draft.id, dlg.id);
                await notifyAdminAboutPending(draft.id, dlg.id, body.text);
            } catch (e: any) {
                console.warn('[agent draft pending err]', e.message);
            }
            return { success: true, draftId: draft.id, willAutoSendIn: '10min unless admin cancels' };
        } catch (e: any) {
            return reply.code(500).send({ error: e.message });
        }
    });
}
