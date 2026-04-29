import { Gender, User, UserStatus } from '@prisma/client';
import prisma from './db';
import { applyGender, detectGender } from './gender';
import { ensureUserAndDialogue, createDraftMessage, sendMessageToUser } from './actions';
import { emitEvent } from './events';
import { notifyAdmin } from './notify';

// ── Render template for a specific user ──────────────────────────────────────

export function renderTemplate(template: string, user: Pick<User, 'firstName' | 'gender'>): string {
    const firstName = (user.firstName || '').trim() || 'друг';
    const withGender = applyGender(template, user.gender);
    return withGender.replace(/\{firstName\}/g, firstName);
}

// ── Filter audience ─────────────────────────────────────────────────────────

export interface AudienceFilter {
    statuses?: UserStatus[];      // default: LEAD/QUALIFIED/MATCHED/CUSTOMER
    minProfileFields?: number;    // require N filled profile fields
    skipBroadcastedSinceHours?: number; // don't bug people contacted in last X hours (default 72h)
    onlyActive?: boolean;         // exclude REJECTED/BLOCKED (default true)
    limit?: number;
}

const PROFILE_FIELDS: (keyof User)[] = [
    'activity', 'city', 'businessCard', 'bestClients', 'requests', 'hobbies', 'currentIncome', 'desiredIncome',
];

function profileScore(u: User): number {
    return PROFILE_FIELDS.filter(k => {
        const v = u[k];
        return v && String(v).trim().length > 0;
    }).length;
}

export async function findAudience(filter: AudienceFilter = {}): Promise<User[]> {
    const statuses = filter.statuses ?? ['LEAD', 'QUALIFIED', 'MATCHED', 'CUSTOMER', 'CHAT'];
    const skipHours = filter.skipBroadcastedSinceHours ?? 72;
    const cutoff = new Date(Date.now() - skipHours * 3600_000);

    const where: any = {
        status: { in: statuses },
        OR: [
            { lastBroadcastAt: null },
            { lastBroadcastAt: { lt: cutoff } },
        ],
    };

    if (filter.onlyActive !== false) {
        where.status = { in: statuses.filter(s => !['REJECTED', 'BLOCKED'].includes(s)) };
    }

    const users = await prisma.user.findMany({
        where,
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        take: Math.min(filter.limit ?? 100, 500),
    });

    let filtered = users;
    if (filter.minProfileFields && filter.minProfileFields > 0) {
        filtered = users.filter(u => profileScore(u) >= filter.minProfileFields!);
    }
    return filtered;
}

// ── Auto-detect gender for users where it's UNKNOWN and we have a name ──────

export async function backfillGender(): Promise<{ updated: number }> {
    const users = await prisma.user.findMany({
        where: { gender: 'UNKNOWN', firstName: { not: null } },
        select: { id: true, firstName: true },
        take: 5000,
    });
    let updated = 0;
    for (const u of users) {
        const g = detectGender(u.firstName);
        if (g !== 'UNKNOWN') {
            await prisma.user.update({ where: { id: u.id }, data: { gender: g } });
            updated++;
        }
    }
    if (updated > 0) console.log(`[broadcast] Backfilled gender for ${updated} users`);
    return { updated };
}

// ── Preview: render all messages, do NOT send ───────────────────────────────

export interface BroadcastPreview {
    userId: number;
    telegramId: string;
    username: string | null;
    firstName: string | null;
    gender: Gender;
    profileScore: number;
    rendered: string;
}

export async function previewBroadcast(templateId: number, filter: AudienceFilter): Promise<BroadcastPreview[]> {
    const template = await prisma.template.findUnique({ where: { id: templateId } });
    if (!template) throw new Error('Template not found');

    const audience = await findAudience(filter);
    return audience.map(u => ({
        userId: u.id,
        telegramId: u.telegramId,
        username: u.username,
        firstName: u.firstName,
        gender: u.gender,
        profileScore: profileScore(u),
        rendered: renderTemplate(template.content, u),
    }));
}

// ── Send: create drafts (operator-approved mode) or auto-send ───────────────

export interface SendOptions {
    templateId: number;
    userIds: number[];
    mode: 'draft' | 'auto';
}

export interface SendResult {
    queued: number;
    sent: number;
    failed: { userId: number; error: string }[];
}

export async function sendBroadcast(opts: SendOptions): Promise<SendResult> {
    const template = await prisma.template.findUnique({ where: { id: opts.templateId } });
    if (!template) throw new Error('Template not found');

    const users = await prisma.user.findMany({ where: { id: { in: opts.userIds } } });
    const failed: { userId: number; error: string }[] = [];
    let queued = 0;
    let sent = 0;

    for (const u of users) {
        try {
            // Make sure dialogue exists (re-uses if there is one)
            const { dialogue } = await ensureUserAndDialogue(
                u.username || u.telegramId,
                u.firstName || u.username || 'Unknown',
                u.accessHash || undefined,
                'INBOUND',
            );

            const rendered = renderTemplate(template.content, u);

            if (opts.mode === 'auto') {
                await sendMessageToUser(u.id, rendered);
                sent++;
            } else {
                await createDraftMessage(dialogue.id, rendered);
                queued++;
            }

            await prisma.user.update({
                where: { id: u.id },
                data: { lastBroadcastAt: new Date(), lastBroadcastTemplateId: template.id },
            });
            // Record outreach attempt for stats tracking
            await prisma.outreachAttempt.create({
                data: { templateId: template.id, userId: u.id, mode: opts.mode },
            }).catch((e) => console.error('[broadcast] could not record attempt:', e.message));
            emitEvent({ type: 'dialogue:updated', dialogueId: dialogue.id });
        } catch (e: any) {
            failed.push({ userId: u.id, error: e.message });
            console.error(`[broadcast] Failed for user ${u.id}:`, e.message);
        }
    }

    if (failed.length > 0) {
        await notifyAdmin(`⚠️ Broadcast: ${failed.length} ошибок из ${users.length}. Шаблон "${template.name}".`);
    } else {
        await notifyAdmin(`✅ Broadcast "${template.name}": ${opts.mode === 'auto' ? sent : queued} ${opts.mode === 'auto' ? 'отправлено' : 'черновиков создано'}.`);
    }

    return { queued, sent, failed };
}
