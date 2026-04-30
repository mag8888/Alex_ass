// ── Wave Match API client ───────────────────────────────────────────────────
// Aligned with docs/contract/openapi.yaml v1.2.0 (deployed reality, not aspiration).
// Types generated via: npm run gen:wm-types

import type { components, paths } from './wm/types.gen';

// ── Stable local re-exports of generated schema types ──────────────────────
export type WMUser = components['schemas']['User'];
export type WMUserListItem = components['schemas']['UserListItem'];
export type WMProfile = components['schemas']['Profile'];
export type WMSubscription = components['schemas']['Subscription'];
export type WMUserClubMembership = components['schemas']['UserClubMembership'];
export type WMUserStats = components['schemas']['UserStats'];
export type WritableUserFields = components['schemas']['WritableUserFields'];
export type WritableProfileFields = components['schemas']['WritableProfileFields'];
export type WMSubscriptionTier = components['schemas']['SubscriptionTier'];
export type CrmNoteCreate = components['schemas']['CrmNoteCreate'];
export type CrmNote = components['schemas']['CrmNote'];
export type CrmNoteKind = components['schemas']['CrmNoteKind'];
export type WebhookEventName = components['schemas']['WebhookEventName'];

// Wave Chat-specific note labels — embedded in `body` and mirrored into `tags`.
// The Wave Match server never sees these as enum values, only as text/tags.
export type WCNoteLabel =
    | 'ai_dialog'
    | 'ai_qualification_done'
    | 'ai_match_proposed'
    | 'ai_match_accepted'
    | 'ai_match_rejected'
    | 'ai_churn_signal';

// ── Configuration (env aliases supported) ────────────────────────────────────
const BASE_URL = (process.env.WAVE_CONNECT_BASE_URL || process.env.WM_API_BASE_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WAVE_CONNECT_API_TOKEN || process.env.WM_API_TOKEN || '';
const TIMEOUT_MS = Number(process.env.WAVE_CONNECT_TIMEOUT_MS || process.env.WM_TIMEOUT_MS || 5000);
const CACHE_TTL_MS = Number(process.env.WAVE_CONNECT_CACHE_TTL_MS || process.env.WM_CACHE_TTL_MS || 10 * 60 * 1000);
const NOTE_AUTHOR_EMAIL = process.env.WAVE_CONNECT_NOTE_AUTHOR_EMAIL || 'wave-chat@aiass.app';

export function isWMEnabled(): boolean {
    return !!(BASE_URL && TOKEN);
}

// ── In-memory cache: by id and by telegramId ────────────────────────────────
type CacheEntry = { user: WMUser; etag: string | null; expiresAt: number };
const cacheById = new Map<string, CacheEntry>();
const cacheByTg = new Map<string, CacheEntry>();

function setCache(user: WMUser, etag: string | null) {
    const expiresAt = Date.now() + CACHE_TTL_MS;
    const entry: CacheEntry = { user, etag, expiresAt };
    cacheById.set(user.id, entry);
    if (user.telegramId) cacheByTg.set(user.telegramId, entry);
}

export function invalidateCache(idOrTelegramId: string) {
    cacheById.delete(idOrTelegramId);
    cacheByTg.delete(idOrTelegramId);
}

/** Stored ETag for a previously fetched user (or null). */
export function getCachedEtag(idOrTelegramId: string): string | null {
    return cacheById.get(idOrTelegramId)?.etag ?? cacheByTg.get(idOrTelegramId)?.etag ?? null;
}

// ── Low-level HTTP with timeout + auth ──────────────────────────────────────
interface RequestOpts extends Omit<RequestInit, 'signal'> { timeoutMs?: number }

async function request(path: string, init: RequestOpts = {}): Promise<Response> {
    if (!isWMEnabled()) throw new Error('WM_API not configured');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? TIMEOUT_MS);
    try {
        return await fetch(`${BASE_URL}${path}`, {
            ...init,
            headers: {
                'Authorization': `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...(init.headers || {}),
            },
            signal: ctrl.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

// ── GET /api/wm/users/:id (id can be UUID or "tg:<telegramId>") ─────────────

async function fetchUser(idOrTgPath: string, include: string, cacheKey: string, isTelegram: boolean): Promise<WMUser | null> {
    if (!isWMEnabled()) return null;

    const cached = (isTelegram ? cacheByTg : cacheById).get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    try {
        const url = `/api/wm/users/${idOrTgPath}?include=${encodeURIComponent(include)}`;
        const res = await request(url);
        if (res.status === 404) return null;
        if (!res.ok) {
            console.error(`[wm] fetchUser ${idOrTgPath} ${res.status}`);
            return null;
        }
        const user = (await res.json()) as WMUser;
        const etag = res.headers.get('etag');
        setCache(user, etag);
        return user;
    } catch (e: any) {
        console.error(`[wm] fetchUser ${idOrTgPath} error:`, e.message);
        return null;
    }
}

export async function getUserByTelegramId(telegramId: string, include = 'profile'): Promise<WMUser | null> {
    return fetchUser(`tg:${encodeURIComponent(telegramId)}`, include, telegramId, true);
}

export async function getUserById(id: string, include = 'profile'): Promise<WMUser | null> {
    return fetchUser(encodeURIComponent(id), include, id, false);
}

// ── PATCH /api/wm/users/:id ─────────────────────────────────────────────────

export interface PatchResult {
    user: WMUser;
    etag: string | null;
    /** Diffed by the client (server doesn't return this). Empty if `user` shape is unchanged. */
    updatedFields: string[];
}

export async function patchUser(
    id: string,
    body: WritableUserFields,
    options: { ifMatch?: string | null } = {},
): Promise<PatchResult | null> {
    if (!isWMEnabled()) return null;

    try {
        const headers: Record<string, string> = {};
        if (options.ifMatch) headers['If-Match'] = options.ifMatch;

        const res = await request(`/api/wm/users/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(body),
        });

        if (res.status === 412) {
            // Stale ETag — invalidate cache, drop result; caller can refetch + retry.
            invalidateCache(id);
            const payload = await res.json().catch(() => null) as any;
            if (payload?.current) {
                const fresh = payload.current as WMUser;
                setCache(fresh, res.headers.get('etag'));
            }
            console.warn(`[wm] patchUser 412 (stale ETag) for ${id}`);
            return null;
        }

        if (res.status === 400) {
            const err = await res.json().catch(() => ({})) as any;
            console.error(`[wm] patchUser 400 for ${id}: error=${err.error} fields=${(err.fields || []).join(',')}`);
            return null;
        }

        if (!res.ok) {
            console.error(`[wm] patchUser ${res.status} for ${id}`);
            return null;
        }

        const updated = (await res.json()) as WMUser;
        const newEtag = res.headers.get('etag');
        setCache(updated, newEtag);

        // Compute updatedFields by diffing request keys vs response (best-effort).
        const updatedFields = Object.keys(body).filter(k => {
            const wanted = (body as any)[k];
            const got = (updated as any)[k];
            return JSON.stringify(wanted) === JSON.stringify(got);
        });

        return { user: updated, etag: newEtag, updatedFields };
    } catch (e: any) {
        console.error('[wm] patchUser error:', e.message);
        return null;
    }
}

/**
 * Push WM Profile fields (role / industry / location / company / gender /
 * tags / skills / hobbies). Wraps PATCH /api/wm/users/:id with body.profile.
 * Available since contract v1.3.0 (deployed by Wave Match team 2026-04-30).
 */
export async function patchProfile(
    id: string,
    profile: WritableProfileFields,
    options: { ifMatch?: string | null } = {},
): Promise<PatchResult | null> {
    return patchUser(id, { profile } as WritableUserFields, options);
}

/**
 * Append a single tag to user.crmTags via PATCH (deduped client-side).
 * Convenience wrapper used by the listener.
 */
export async function addCrmTag(id: string, tag: string): Promise<boolean> {
    const cached = cacheById.get(id);
    let baseUser = cached?.user || null;
    let etag = cached?.etag || null;
    if (!baseUser) {
        baseUser = await getUserById(id);
        etag = getCachedEtag(id);
    }
    if (!baseUser) return false;

    const tags = new Set([...(baseUser.crmTags || []), tag]);
    const result = await patchUser(id, { crmTags: Array.from(tags) }, { ifMatch: etag });
    return !!result;
}

// ── GET /api/wm/users (list) ────────────────────────────────────────────────

export interface ListUsersFilter {
    limit?: number;
    cursor?: string;
    updatedSince?: string;
    /** Comma-separated values from SubscriptionTier */
    subscriptionTier?: string;
    clubSlug?: string;
    marketingOptIn?: boolean;
    lastActiveAfter?: string;
    lastActiveBefore?: string;
    hasEmail?: boolean;
    locale?: string;
    withTotal?: '1';
}

export async function listUsers(filter: ListUsersFilter = {}): Promise<{ items: WMUserListItem[]; nextCursor?: string | null; total?: number | null }> {
    if (!isWMEnabled()) return { items: [] };
    try {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(filter)) {
            if (v !== undefined && v !== null) qs.set(k, String(v));
        }
        const res = await request(`/api/wm/users?${qs.toString()}`);
        if (!res.ok) return { items: [] };
        return await res.json();
    } catch (e: any) {
        console.error('[wm] listUsers error:', e.message);
        return { items: [] };
    }
}

// ── POST /api/wm/users/:id/notes ────────────────────────────────────────────

export async function createNote(userId: string, body: CrmNoteCreate): Promise<CrmNote | null> {
    if (!isWMEnabled()) return null;
    try {
        const res = await request(`/api/wm/users/${encodeURIComponent(userId)}/notes`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            console.error(`[wm] createNote ${res.status} for ${userId}`);
            return null;
        }
        return (await res.json()) as CrmNote;
    } catch (e: any) {
        console.error('[wm] createNote error:', e.message);
        return null;
    }
}

/**
 * Wave Chat-specific note: embeds an AI label into body+tags, kind=system.
 * Replaces the legacy v1.1.x `addNote(type, summary)` API.
 */
export async function addAiNote(
    userId: string,
    label: WCNoteLabel,
    text: string,
    options: { tags?: string[]; pinned?: boolean; linkedDialogId?: string | number } = {},
): Promise<boolean> {
    const trimmed = text.slice(0, 3800); // leave room for the [label] prefix
    const linkedSuffix = options.linkedDialogId ? ` (dialogue=${options.linkedDialogId})` : '';
    const body: CrmNoteCreate = {
        kind: 'system',
        body: `[${label}] ${trimmed}${linkedSuffix}`,
        tags: ['ai', label.replace(/^ai_/, ''), ...(options.tags || [])],
        authorEmail: NOTE_AUTHOR_EMAIL,
        pinned: options.pinned ?? false,
    };
    const created = await createNote(userId, body);
    return !!created;
}

// ── Webhook subscription mgmt ───────────────────────────────────────────────

export async function ensureWebhookSubscription(
    callbackUrl: string,
    secret: string,
    events: WebhookEventName[],
): Promise<boolean> {
    if (!isWMEnabled()) return false;
    try {
        const listRes = await request('/api/wm/webhooks');
        if (listRes.ok) {
            const subs = (await listRes.json()) as Array<{ id: string; url: string }>;
            const mine = subs.find(s => s.url === callbackUrl);
            if (mine) {
                console.log(`[wm] Webhook subscription already exists: ${mine.id}`);
                return true;
            }
        }
        const body: components['schemas']['WebhookSubscriptionCreate'] = { url: callbackUrl, events, secret };
        const createRes = await request('/api/wm/webhooks', { method: 'POST', body: JSON.stringify(body) });
        return createRes.ok;
    } catch (e: any) {
        console.error('[wm] ensureWebhookSubscription error:', e.message);
        return false;
    }
}
