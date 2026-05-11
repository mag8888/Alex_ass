// ── WM Marketing API probe ──────────────────────────────────────────────
// Discovery: пробуем разные комбинации path + auth header чтобы найти
// что работает. Полезно когда WM-команда дала неточный путь / формат.

const MONEO = 'https://moneo-live.up.railway.app';
const PARTNERSHIP = 'https://partnership-live.up.railway.app';

const PATHS = [
    '/api/users/all',
    '/api/users',
    '/api/admin/users/all',
    '/api/admin/users',
    '/admin/api/users',
    '/api/admin/users?page=1',
    '/health',
    '/api/health',
    '/',
];

const AUTH_VARIANTS = (secret: string) => [
    { header: 'x-admin-secret', value: `WM_Marketing:${secret}` },
    { header: 'x-admin-secret', value: secret },
    { header: 'X-Admin-Secret', value: `WM_Marketing:${secret}` },
    { header: 'Authorization', value: `Bearer ${secret}` },
    { header: 'Authorization', value: `Bearer WM_Marketing:${secret}` },
    { header: 'X-API-Key', value: secret },
    { header: 'admin-secret', value: secret },
];

async function probe(base: string, path: string, auth?: { header: string; value: string }): Promise<{ status: number; bodySnippet: string }> {
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (auth) headers[auth.header] = auth.value;
    try {
        const res = await fetch(base + path, {
            headers,
            signal: AbortSignal.timeout(6000),
        });
        const text = await res.text();
        return { status: res.status, bodySnippet: text.slice(0, 200) };
    } catch (e: any) {
        return { status: 0, bodySnippet: `err: ${e.message}` };
    }
}

export async function runProbe(): Promise<any> {
    const secret = (process.env.WM_Marketing || '').replace(/^WM_Marketing:/, '');
    if (!secret) return { error: 'WM_Marketing env not set' };

    const results: any = {
        moneo: { base: MONEO, hasSecret: !!secret, secretLen: secret.length, attempts: [] },
        partnership: { base: PARTNERSHIP, attempts: [] },
    };

    // Moneo path probe (with default auth)
    const defaultAuth = { header: 'x-admin-secret', value: `WM_Marketing:${secret}` };
    for (const p of PATHS) {
        const r = await probe(MONEO, p, defaultAuth);
        results.moneo.attempts.push({ path: p, status: r.status, snippet: r.bodySnippet });
        if (r.status === 200) results.moneo.workingPath = p;
    }

    // Partnership auth probe (with /api/admin/users)
    const partnershipPath = '/api/admin/users?page=1';
    for (const a of AUTH_VARIANTS(secret)) {
        const r = await probe(PARTNERSHIP, partnershipPath, a);
        results.partnership.attempts.push({ header: a.header, valueFormat: a.value.startsWith('WM_Marketing:') ? 'WM_Marketing:<secret>' : a.value.startsWith('Bearer ') ? 'Bearer ...' : '<secret>', status: r.status, snippet: r.bodySnippet });
        if (r.status === 200) {
            results.partnership.workingAuth = a.header + ': ' + (a.value.startsWith('WM_Marketing:') ? 'WM_Marketing:<secret>' : a.value.startsWith('Bearer ') ? 'Bearer ...' : '<secret>');
        }
    }

    return results;
}
