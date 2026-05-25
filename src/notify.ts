import { getClient } from './client';
import { Api } from 'telegram';
import type { User } from '@prisma/client';
import type { WMUser } from './wmClient';
import { detectGender } from './gender';
import { persona } from './persona';

// Куда летят админ-уведомления для ТЕКУЩЕГО бота (persona-зависимо).
// arthur → [roman]; alex → [roman, alex] (когда задан ALEX_ADMIN_USERNAME).
// Fallback на env ADMIN_USERNAME для обратной совместимости.
const ADMIN_TARGETS: string[] = persona.adminTargets.length
    ? persona.adminTargets
    : [(process.env.ADMIN_USERNAME || 'roman_arctur').replace(/^@/, '')];
const ADMIN_USERNAME = ADMIN_TARGETS[0];
// Where lead-related notifications go. Accepts:
//   - Public username (e.g. "wave_leads")
//   - Numeric channel ID (e.g. "-1002145678900")
//   - Invite link (https://t.me/+ABC123 or https://t.me/joinchat/ABC123) — bot auto-joins
// If unset, lead notifications fall back to admin DM.
const LEAD_CHAT_RAW = process.env.WC_LEAD_CHAT || '';

let _leadPeerCache: any = null;
let _leadPeerResolveAttempted = false;

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

    // Шлём всем admin-таргетам персоны (arthur=1, alex=Роман+Алекс).
    for (const target of ADMIN_TARGETS) {
        try {
            await client.sendMessage(target, { message: text, silent: opts.silent });
            console.log(`[notify] Sent to @${target}: ${text.substring(0, 60)}...`);
        } catch (e: any) {
            console.error(`[notify] Failed to deliver to @${target}:`, e.message);
        }
    }
}

export function getAdminUsername() {
    return ADMIN_USERNAME;
}

// ── Lead channel routing ─────────────────────────────────────────────────────
// Resolves WC_LEAD_CHAT once per process. Joins via invite hash if needed.
async function resolveLeadPeer(): Promise<any | null> {
    if (_leadPeerResolveAttempted) return _leadPeerCache;
    _leadPeerResolveAttempted = true;

    if (!LEAD_CHAT_RAW) return null;
    const client = getClient();
    if (!client || !client.connected) {
        // Will retry on next call (we'll reset the flag)
        _leadPeerResolveAttempted = false;
        return null;
    }

    try {
        const inviteMatch = LEAD_CHAT_RAW.match(/(?:t\.me\/|telegram\.me\/)(?:\+|joinchat\/)([A-Za-z0-9_-]+)/);
        if (inviteMatch) {
            const hash = inviteMatch[1];
            try {
                const result = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                const chats = (result as any).chats;
                if (Array.isArray(chats) && chats.length > 0) {
                    _leadPeerCache = chats[0];
                    console.log(`[notify] Joined lead channel via invite, id=${chats[0].id}`);
                    return _leadPeerCache;
                }
            } catch (e: any) {
                const msg = String(e.message || e);
                if (msg.includes('USER_ALREADY_PARTICIPANT')) {
                    // Already joined — resolve via CheckChatInvite
                    try {
                        const info = await client.invoke(new Api.messages.CheckChatInvite({ hash })) as any;
                        if (info.chat) {
                            _leadPeerCache = info.chat;
                            console.log(`[notify] Lead channel already-joined, id=${info.chat.id}`);
                            return _leadPeerCache;
                        }
                    } catch (e2: any) {
                        console.error('[notify] CheckChatInvite failed:', e2.message);
                    }
                } else {
                    console.error('[notify] ImportChatInvite failed:', msg);
                }
            }
            return null;
        }

        // Numeric channel ID
        if (/^-?\d+$/.test(LEAD_CHAT_RAW)) {
            const entity = await client.getEntity(BigInt(LEAD_CHAT_RAW) as any);
            _leadPeerCache = entity;
            console.log(`[notify] Lead channel resolved by id`);
            return entity;
        }

        // Username
        const entity = await client.getEntity(LEAD_CHAT_RAW.replace(/^@/, ''));
        _leadPeerCache = entity;
        console.log(`[notify] Lead channel resolved by username`);
        return entity;
    } catch (e: any) {
        console.error('[notify] Failed to resolve lead chat:', e.message);
        return null;
    }
}

export async function notifyLeads(text: string, opts: { silent?: boolean } = {}) {
    if (!LEAD_CHAT_RAW) {
        // Not configured → fall back to admin DM
        return notifyAdmin(text, opts);
    }
    const client = getClient();
    if (!client || !client.connected) {
        return notifyAdmin(text, opts);
    }

    const peer = await resolveLeadPeer();
    if (!peer) {
        console.warn('[notify] Lead peer not resolved, falling back to admin DM');
        return notifyAdmin(text, opts);
    }

    try {
        await client.sendMessage(peer, { message: text, silent: opts.silent });
        console.log(`[notify] → leads channel: ${text.substring(0, 60)}...`);
    } catch (e: any) {
        console.error('[notify] Failed to post to lead channel:', e.message);
        // Fallback so we don't lose the alert
        return notifyAdmin(text, opts);
    }
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
