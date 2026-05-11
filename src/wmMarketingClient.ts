// ── WM Marketing API client ──────────────────────────────────────────────
// Wave Match-команда подняла 2 admin-API:
//   • https://moneo-live.up.railway.app/api/users/all
//   • https://partnership-live.up.railway.app/api/admin/users
// Auth: header  x-admin-secret: WM_Marketing:<секрет>
//
// Используется для:
//   • Pull списка участников Moneo / Partnership-сервисов
//   • Сегментированных рассылок (приглашения на ивенты, follow-up)
//   • Будущее: outgoing webhooks, bulk-export

const MONEO_URL = process.env.WM_MONEO_BASE_URL || 'https://moneo-live.up.railway.app';
const PARTNERSHIP_URL = process.env.WM_PARTNERSHIP_BASE_URL || 'https://partnership-live.up.railway.app';
const TIMEOUT_MS = Number(process.env.WM_MARKETING_TIMEOUT_MS || 10_000);

export function isMarketingEnabled(): boolean {
    return !!process.env.WM_Marketing;
}

function authHeader(): Record<string, string> {
    const secret = process.env.WM_Marketing || '';
    if (!secret) return {};
    // Если value уже формата "WM_Marketing:XXXX" — берём как есть
    // Иначе добавляем префикс
    const value = secret.startsWith('WM_Marketing:') ? secret : `WM_Marketing:${secret}`;
    return { 'x-admin-secret': value };
}

async function request(url: string, opts: RequestInit = {}): Promise<any> {
    if (!isMarketingEnabled()) throw new Error('WM_Marketing env not configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            ...opts,
            headers: { ...authHeader(), 'Accept': 'application/json', ...(opts.headers || {}) },
            signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        try { return JSON.parse(text); } catch { return { raw: text }; }
    } finally {
        clearTimeout(timer);
    }
}

export interface MoneoUser {
    [key: string]: any;        // schema TBD после первого ответа
}

export interface PartnershipUser {
    [key: string]: any;
}

export async function fetchMoneoUsersAll(): Promise<{ users: MoneoUser[]; raw: any }> {
    const r = await request(`${MONEO_URL}/api/users/all`);
    return { users: r.users || [], raw: r };
}

export async function fetchPartnershipUsers(page: number = 1): Promise<{ users: PartnershipUser[]; raw: any }> {
    const r = await request(`${PARTNERSHIP_URL}/api/admin/users?page=${page}`);
    return { users: r.users || [], raw: r };
}

export async function smokeTest(): Promise<{ moneo: { ok: boolean; count?: number; err?: string }, partnership: { ok: boolean; count?: number; err?: string } }> {
    const result = { moneo: { ok: false }, partnership: { ok: false } } as any;
    try {
        const r = await fetchMoneoUsersAll();
        result.moneo = { ok: true, count: r.users.length };
    } catch (e: any) { result.moneo = { ok: false, err: e.message }; }
    try {
        const r = await fetchPartnershipUsers(1);
        result.partnership = { ok: true, count: r.users.length };
    } catch (e: any) { result.partnership = { ok: false, err: e.message }; }
    return result;
}
