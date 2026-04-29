// ── Wave Match API client ───────────────────────────────────────────────────
// Implements the contract from docs/contract/openapi.yaml (v1.1.2).
// Types are GENERATED — never edit src/wm/types.gen.ts by hand.
// Re-run `npm run gen:wm-types` whenever the spec changes.
//
// Graceful degradation: if WAVE_CONNECT_BASE_URL/WAVE_CONNECT_API_TOKEN aren't
// set, ALL methods return null/empty silently; listener flow keeps working.

import type { components, paths } from './wm/types.gen';

// ── Re-export schema types under stable local names so callers don't have to
// follow the deep components.schemas.X path. These names are kept stable across
// spec versions; if the spec renames something, fix it here ONCE.
export type WMUser = components['schemas']['User'];
export type WMProfile = components['schemas']['UserProfile'];
export type WMSubscription = components['schemas']['Subscription'];
export type WMClubMembership = components['schemas']['ClubMembership'];
export type WMStats = components['schemas']['Stats'];
export type CrmNoteType = components['schemas']['CrmNoteType'];
export type CrmNoteCreate = components['schemas']['CrmNoteCreate'];
export type WebhookEventName = components['schemas']['WebhookEventName'];

// Accept both naming conventions:
//   WAVE_CONNECT_*  — Wave Match team's preferred prefix
//   WM_*            — short legacy names
const BASE_URL = (process.env.WAVE_CONNECT_BASE_URL || process.env.WM_API_BASE_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WAVE_CONNECT_API_TOKEN || process.env.WM_API_TOKEN || '';
const TIMEOUT_MS = Number(process.env.WAVE_CONNECT_TIMEOUT_MS || process.env.WM_TIMEOUT_MS || 5000);
const CACHE_TTL_MS = Number(process.env.WAVE_CONNECT_CACHE_TTL_MS || process.env.WM_CACHE_TTL_MS || 10 * 60 * 1000);

export function isWMEnabled(): boolean {
    return !!(BASE_URL && TOKEN);
}

// ── In-memory cache (per id + per telegramId) ────────────────────────────────
type CacheEntry = { user: WMUser; expiresAt: number };
const cacheById = new Map<string, CacheEntry>();
const cacheByTg = new Map<string, CacheEntry>();

function setCache(user: WMUser) {
    const expiresAt = Date.now() + CACHE_TTL_MS;
    cacheById.set(user.id, { user, expiresAt });
    if (user.telegramId) cacheByTg.set(user.telegramId, { user, expiresAt });
}

export function invalidateCache(idOrTelegramId: string) {
    cacheById.delete(idOrTelegramId);
    cacheByTg.delete(idOrTelegramId);
}

// ── Low-level HTTP with timeout + auth header ────────────────────────────────
async function request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!isWMEnabled()) throw new Error('WM_API not configured');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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

// ── Endpoints (typed via paths['<route>']['<verb>']['responses'] etc) ───────

type GetByTelegramQuery = NonNullable<
    paths['/api/wm/users/by-telegram']['get']['parameters']['query']
>;

export async function getUserByTelegramId(telegramId: string, include = 'profile,subscription'): Promise<WMUser | null> {
    if (!isWMEnabled()) return null;

    const cached = cacheByTg.get(telegramId);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    try {
        const qs: GetByTelegramQuery = { telegramId, include };
        const params = new URLSearchParams(qs as Record<string, string>);
        const res = await request(`/api/wm/users/by-telegram?${params}`);
        if (res.status === 404) return null;
        if (!res.ok) {
            console.error(`[wm] getUserByTelegramId ${res.status}`);
            return null;
        }
        const user = (await res.json()) as WMUser;
        setCache(user);
        return user;
    } catch (e: any) {
        console.error('[wm] getUserByTelegramId error:', e.message);
        return null;
    }
}

export async function getUserById(id: string, include = 'profile,subscription'): Promise<WMUser | null> {
    if (!isWMEnabled()) return null;

    const cached = cacheById.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    try {
        const res = await request(`/api/wm/users/${encodeURIComponent(id)}?include=${encodeURIComponent(include)}`);
        if (res.status === 404) return null;
        if (!res.ok) return null;
        const user = (await res.json()) as WMUser;
        setCache(user);
        return user;
    } catch (e: any) {
        console.error('[wm] getUserById error:', e.message);
        return null;
    }
}

type PatchProfileBody = NonNullable<
    paths['/api/wm/users/{id}']['patch']['requestBody']
>['content']['application/json'];

export type PatchProfileInput = PatchProfileBody;

export async function patchUserProfile(id: string, etag: string, body: PatchProfileInput): Promise<WMUser | null> {
    if (!isWMEnabled()) return null;
    try {
        const res = await request(`/api/wm/users/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'If-Match': etag },
            body: JSON.stringify(body),
        });
        if (res.status === 412) {
            invalidateCache(id);
            console.warn(`[wm] patchUserProfile 412 for ${id} — concurrent edit, invalidated cache`);
            return null;
        }
        if (!res.ok) {
            console.error(`[wm] patchUserProfile ${res.status} for ${id}`);
            return null;
        }
        // Endpoint returns ack object; refetch the full user to keep cache hot
        await res.json().catch(() => null);
        const refreshed = await getUserById(id);
        return refreshed;
    } catch (e: any) {
        console.error('[wm] patchUserProfile error:', e.message);
        return null;
    }
}

type ListUsersQuery = NonNullable<paths['/api/wm/users']['get']['parameters']['query']>;
export type ListUsersFilter = ListUsersQuery;
type ListUsersResp = paths['/api/wm/users']['get']['responses']['200']['content']['application/json'];

export async function listUsers(filter: ListUsersFilter = {}): Promise<{ items: WMUser[]; cursor?: string | null }> {
    if (!isWMEnabled()) return { items: [] };
    try {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(filter)) {
            if (v !== undefined && v !== null) qs.set(k, String(v));
        }
        const res = await request(`/api/wm/users?${qs.toString()}`);
        if (!res.ok) return { items: [] };
        return (await res.json()) as ListUsersResp;
    } catch (e: any) {
        console.error('[wm] listUsers error:', e.message);
        return { items: [] };
    }
}

export async function addNote(
    userId: string,
    type: CrmNoteType,
    summary: string,
    options: { tags?: string[]; linkedDialogId?: string } = {},
): Promise<boolean> {
    if (!isWMEnabled()) return false;
    try {
        const body: CrmNoteCreate = {
            type,
            summary: summary.slice(0, 1000),
            tags: options.tags,
            linkedDialogId: options.linkedDialogId,
        };
        const res = await request(`/api/wm/users/${encodeURIComponent(userId)}/notes`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        return res.ok;
    } catch (e: any) {
        console.error('[wm] addNote error:', e.message);
        return false;
    }
}

// ── Webhook subscription management ──────────────────────────────────────────

type WebhookSubscriptionCreate = components['schemas']['WebhookSubscriptionCreate'];

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

        const body: WebhookSubscriptionCreate = { url: callbackUrl, events, secret };
        const createRes = await request('/api/wm/webhooks', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        if (createRes.ok) {
            console.log('[wm] Webhook subscription created');
            return true;
        }
        console.error(`[wm] ensureWebhookSubscription failed: ${createRes.status}`);
        return false;
    } catch (e: any) {
        console.error('[wm] ensureWebhookSubscription error:', e.message);
        return false;
    }
}

// ── Convenience: derive missing profile fields ──────────────────────────────

export const WM_PROFILE_KEYS: (keyof WMProfile)[] = [
    'city', 'activity', 'businessCard', 'bestClients',
    'requests', 'hobbies', 'currentIncome', 'desiredIncome', 'networkingGoal',
];

export function missingProfileFields(user: WMUser): (keyof WMProfile)[] {
    const p = user.profile || ({} as WMProfile);
    return WM_PROFILE_KEYS.filter(k => {
        const v = (p as any)[k];
        return v === null || v === undefined || (typeof v === 'string' && v.trim().length === 0);
    });
}
