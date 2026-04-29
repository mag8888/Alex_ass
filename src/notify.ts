import { getClient } from './client';
import type { User } from '@prisma/client';
import type { WMUser } from './wmClient';
import { detectGender } from './gender';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'roman_arctur';

let lastErrorAlert = 0;
const ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between identical alerts

export async function notifyAdmin(text: string, opts: { rateLimitKey?: string; silent?: boolean } = {}) {
    if (!ADMIN_USERNAME) {
        console.warn('[notify] ADMIN_USERNAME not set, skipping notification');
        return;
    }

    if (opts.rateLimitKey) {
        const now = Date.now();
        if (now - lastErrorAlert < ERROR_COOLDOWN_MS) {
            console.log(`[notify] rate-limited: ${text.substring(0, 60)}`);
            return;
        }
        lastErrorAlert = now;
    }

    const client = getClient();
    if (!client || !client.connected) {
        console.warn(`[notify] Telegram client not connected, can't notify admin: ${text.substring(0, 80)}`);
        return;
    }

    try {
        await client.sendMessage(ADMIN_USERNAME, { message: text, silent: opts.silent });
        console.log(`[notify] Sent to @${ADMIN_USERNAME}: ${text.substring(0, 60)}...`);
    } catch (e: any) {
        console.error(`[notify] Failed to deliver to @${ADMIN_USERNAME}:`, e.message);
    }
}

export function getAdminUsername() {
    return ADMIN_USERNAME;
}

// ── Lead card formatter ──────────────────────────────────────────────────────
// Builds a one-screen TG card with everything we know about a user.
// Used in admin notifications (new chat, LEAD upgrade, welcome confirm).
const GENDER_SYMBOL: Record<string, string> = { MALE: '♂', FEMALE: '♀', UNKNOWN: '?' };

function nonEmpty(v: any): boolean {
    return v !== null && v !== undefined && String(v).trim().length > 0;
}

export interface UserCardOpts {
    title?: string;        // emoji + headline (e.g. "🔥 Новый ЛИД")
    wm?: WMUser | null;    // optional Wave Match profile snapshot
}

export function buildUserCard(localUser: User, opts: UserCardOpts = {}): string {
    const lines: string[] = [];

    // Auto-detect gender if missing
    let gender = localUser.gender as string;
    if (gender === 'UNKNOWN' && localUser.firstName) {
        const detected = detectGender(localUser.firstName);
        if (detected !== 'UNKNOWN') gender = detected;
    }
    const sym = GENDER_SYMBOL[gender] || '?';

    // Headline: title + @username (Имя Фамилия) gender
    const handle = localUser.username ? `@${localUser.username}` : `tg:${localUser.telegramId}`;
    const fullName = [localUser.firstName, localUser.lastName].filter(Boolean).join(' ').trim();
    const head = `${opts.title ? opts.title + ': ' : ''}${handle} ${sym}${fullName ? ` · ${fullName}` : ''}`;
    lines.push(head);

    // Wave Match block (if we have it)
    if (opts.wm) {
        const wm = opts.wm;
        const wmBits: string[] = [];
        if (wm.subscription?.tier) wmBits.push(`💎 ${wm.subscription.tier}`);
        if (wm.profile?.role) wmBits.push(`👤 ${wm.profile.role}`);
        if (wm.profile?.industry) wmBits.push(`🏢 ${wm.profile.industry}`);
        if (wm.profile?.location) wmBits.push(`📍 ${wm.profile.location}`);
        if (wm.profile?.company) wmBits.push(`🏷️ ${wm.profile.company}`);
        if (wmBits.length > 0) lines.push('WM: ' + wmBits.join(' · '));

        if (Array.isArray(wm.profile?.skills) && wm.profile.skills.length > 0) {
            lines.push('Скиллы: ' + wm.profile.skills.slice(0, 6).join(', '));
        }
        if (Array.isArray(wm.crmTags) && wm.crmTags.length > 0) {
            lines.push('CRM-теги: ' + wm.crmTags.slice(0, 8).join(', '));
        }
    }

    // Local-extracted profile (from AI conversation history)
    const localBits: string[] = [];
    if (nonEmpty(localUser.activity)) localBits.push(`💼 ${localUser.activity}`);
    if (nonEmpty(localUser.city) && (!opts.wm?.profile?.location || opts.wm.profile.location !== localUser.city)) {
        localBits.push(`🌆 ${localUser.city}`);
    }
    if (nonEmpty(localUser.currentIncome)) localBits.push(`💰 ${localUser.currentIncome}`);
    if (nonEmpty(localUser.desiredIncome)) localBits.push(`🎯 ${localUser.desiredIncome}`);
    if (localBits.length > 0) lines.push('Локально: ' + localBits.join(' · '));

    if (nonEmpty(localUser.requests)) {
        lines.push(`Запросы: ${String(localUser.requests).slice(0, 200)}`);
    }
    if (nonEmpty(localUser.bestClients)) {
        lines.push(`Лучшие клиенты: ${String(localUser.bestClients).slice(0, 200)}`);
    }
    if (nonEmpty(localUser.businessCard)) {
        lines.push(`Bio: ${String(localUser.businessCard).slice(0, 200)}`);
    }

    // Footer: TG ID + status
    const footerBits: string[] = [`status: ${localUser.status}`];
    if (localUser.telegramId && localUser.telegramId !== localUser.username) {
        footerBits.push(`tg:${localUser.telegramId}`);
    }
    lines.push(`— ${footerBits.join(' · ')}`);

    return lines.join('\n');
}
