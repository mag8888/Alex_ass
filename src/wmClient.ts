// ── Wave Match API client ───────────────────────────────────────────────────
// Implements the contract from docs/WAVEMATCH_API_TZ.md (v1.1).
// Graceful degradation: if WM_API_BASE_URL/WM_API_TOKEN are not set, ALL methods
// return null/empty silently — listener flow still works in local-only mode.

// Accept both naming conventions:
//   WAVE_CONNECT_*  — used by the Wave Match team (their preferred prefix)
//   WM_*            — short legacy names from initial spec
const BASE_URL = (process.env.WAVE_CONNECT_BASE_URL || process.env.WM_API_BASE_URL || '').replace(/\/$/, '');
const TOKEN = process.env.WAVE_CONNECT_API_TOKEN || process.env.WM_API_TOKEN || '';
const TIMEOUT_MS = Number(process.env.WAVE_CONNECT_TIMEOUT_MS || process.env.WM_TIMEOUT_MS || 5000);
const CACHE_TTL_MS = Number(process.env.WAVE_CONNECT_CACHE_TTL_MS || process.env.WM_CACHE_TTL_MS || 10 * 60 * 1000);

export function isWMEnabled(): boolean {
    return !!(BASE_URL && TOKEN);
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface WMProfile {
    city?: string | null;
    activity?: string | null;
    businessCard?: string | null;
    bestClients?: string | null;
    requests?: string | null;
    hobbies?: string | null;
    currentIncome?: string | null;
    desiredIncome?: string | null;
    networkingGoal?: string | null;
    tags?: string[];
}

export interface WMSubscription {
    tier: 'FREE' | 'PRO' | 'PREMIUM';
    status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
    currentPeriodEnd?: string;
    marketingOptIn?: boolean;
}

export interface WMUser {
    id: string;
    telegramId: string;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    gender?: 'MALE' | 'FEMALE' | 'UNKNOWN' | null;
    locale?: string;
    registeredAt: string;
    lastActiveAt?: string;
    etag: string;
    profile?: WMProfile;
    clubs?: { slug: string; joinedAt: string; role: string }[];
    subscription?: WMSubscription;
    stats?: { lifetimeValue: number; matchesCount: number };
}

// ── In-memory cache (per telegramId / per id) ────────────────────────────────
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

// ── Endpoints ────────────────────────────────────────────────────────────────

export async function getUserByTelegramId(telegramId: string, include = 'profile,subscription'): Promise<WMUser | null> {
    if (!isWMEnabled()) return null;

    const cached = cacheByTg.get(telegramId);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    try {
        const res = await request(`/api/wm/users/by-telegram?telegramId=${encodeURIComponent(telegramId)}&include=${include}`);
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
        const res = await request(`/api/wm/users/${encodeURIComponent(id)}?include=${include}`);
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

export interface PatchProfileInput {
    profile?: Partial<WMProfile>;
    gender?: 'MALE' | 'FEMALE' | 'UNKNOWN';
}

export async function patchUserProfile(id: string, etag: string, body: PatchProfileInput): Promise<WMUser | null> {
    if (!isWMEnabled()) return null;
    try {
        const res = await request(`/api/wm/users/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'If-Match': etag },
            body: JSON.stringify(body),
        });
        if (res.status === 412) {
            // ETag mismatch — invalidate cache so caller can retry with fresh user
            invalidateCache(id);
            console.warn(`[wm] patchUserProfile 412 for ${id} — concurrent edit, invalidated cache`);
            return null;
        }
        if (!res.ok) {
            console.error(`[wm] patchUserProfile ${res.status} for ${id}`);
            return null;
        }
        const updated = (await res.json()) as WMUser;
        setCache(updated);
        return updated;
    } catch (e: any) {
        console.error('[wm] patchUserProfile error:', e.message);
        return null;
    }
}

export interface ListUsersFilter {
    subscriptionTier?: 'FREE' | 'PRO' | 'PREMIUM';
    clubSlug?: string;
    marketingOptIn?: boolean;
    lastActiveBefore?: string; // ISO
    lastActiveAfter?: string;
    hasEmail?: boolean;
    locale?: string;
    minProfileCompleteness?: number;
    cursor?: string;
    pageSize?: number;
}

export async function listUsers(filter: ListUsersFilter = {}): Promise<{ items: WMUser[]; cursor?: string }> {
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

export type CrmNoteType =
    | 'ai_dialog'
    | 'ai_qualification_done'
    | 'ai_match_proposed'
    | 'ai_match_accepted'
    | 'ai_match_rejected'
    | 'ai_churn_signal';

export async function addNote(
    userId: string,
    type: CrmNoteType,
    summary: string,
    options: { tags?: string[]; linkedDialogId?: string } = {},
): Promise<boolean> {
    if (!isWMEnabled()) return false;
    try {
        const res = await request(`/api/wm/users/${encodeURIComponent(userId)}/notes`, {
            method: 'POST',
            body: JSON.stringify({
                type,
                summary: summary.slice(0, 1000),
                tags: options.tags,
                linkedDialogId: options.linkedDialogId,
            }),
        });
        return res.ok;
    } catch (e: any) {
        console.error('[wm] addNote error:', e.message);
        return false;
    }
}

// ── Webhook subscription management ──────────────────────────────────────────

export async function ensureWebhookSubscription(callbackUrl: string, secret: string, events: string[]): Promise<boolean> {
    if (!isWMEnabled()) return false;
    try {
        // First check if a subscription already exists for our URL
        const listRes = await request('/api/wm/webhooks');
        if (listRes.ok) {
            const subs = await listRes.json() as Array<{ id: string; url: string; events: string[] }>;
            const mine = subs.find(s => s.url === callbackUrl);
            if (mine) {
                console.log(`[wm] Webhook subscription already exists: ${mine.id}`);
                return true;
            }
        }

        const createRes = await request('/api/wm/webhooks', {
            method: 'POST',
            body: JSON.stringify({ url: callbackUrl, events, secret }),
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
    const p = user.profile || {};
    return WM_PROFILE_KEYS.filter(k => {
        const v = p[k];
        return v === null || v === undefined || (typeof v === 'string' && v.trim().length === 0);
    });
}
