// ── DNAI Studio S2S API client ─────────────────────────────────────────────
// Hybrid architecture:
//   aiass-production (us) = execution layer (listener, KB, Match Engine,
//                            pendingSends, генерим candidate draft своим
//                            пайплайном 21 принципа)
//   DNAI Studio = control layer (review-chain Артур→Марк→Аида, project_memory)
//
// Per docs/api-s2s-integration.md (DNAI Studio repo).

// Env naming aligned with TZ-aiass-team.md.
// Принимаем оба имени для key/timeout: короткое (DNAI_API_KEY) — что было
// выставлено на Railway, и длинное (DNAI_STUDIO_API_KEY) — из TZ. Любое
// непустое используется. Это убирает silent-misconfig если оператор
// добавил переменную не под тем именем.
const BASE_URL = process.env.DNAI_BASE_URL || process.env.DNAI_STUDIO_BASE_URL || 'https://dnai.up.railway.app';
const API_KEY = process.env.DNAI_STUDIO_API_KEY || process.env.DNAI_API_KEY || '';
const TIMEOUT_MS = Number(process.env.DNAI_STUDIO_TIMEOUT_MS || process.env.DNAI_TIMEOUT_MS || 35_000);  // per TZ default 35s

/**
 * Per TZ: enabled by default UNLESS explicitly set to "false".
 * No API key → effectively disabled regardless of flag.
 */
export function isDnaiEnabled(): boolean {
    if (!API_KEY) return false;
    const flag = process.env.DNAI_INTEGRATION_ENABLED;
    return flag !== 'false';
}

/**
 * Mask API key for safe logging (per TZ §2.1: «НИКОГДА не логируйте сам ключ»).
 */
export function maskApiKey(): string {
    if (!API_KEY) return '(not set)';
    return API_KEY.slice(0, 6) + '...' + API_KEY.slice(-5);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
        'X-DNAI-API-Key': API_KEY,
        'Accept': 'application/json',
        ...extra,
    };
}

async function request(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<any> {
    if (!API_KEY) throw new Error('DNAI_STUDIO_API_KEY not configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE_URL}${path}`, {
            ...init,
            headers: { ...headers(), ...(init.headers as any || {}) },
            signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) {
            const err = new Error(`DNAI ${res.status}: ${text.slice(0, 200)}`) as any;
            err.status = res.status;
            err.body = text;
            throw err;
        }
        try { return JSON.parse(text); } catch { return { raw: text }; }
    } finally {
        clearTimeout(timer);
    }
}

// ── Types ─────────────────────────────────────────────────────────────────

// v2.0: added GO_FALLBACK verdict for graceful degradation when Anthropic fails
export type ReviewVerdict = 'GO' | 'TWEAK' | 'NO-GO' | 'GO_FALLBACK';

export interface ReviewRequest {
    dialogueId: string;
    draft?: string;
    intent?: string;
    recentMessages?: Array<{ sender: 'USER' | 'OPERATOR'; text: string; createdAt: string }>;
    clientContext?: { stage?: string; telegramUsername?: string; leadScore?: number };
    mode?: 'strict' | 'fallback';   // v2.0: fallback returns GO_FALLBACK on Anthropic errors
    options?: { skipReviewChain?: boolean; timeout?: number };
}

export interface ReviewResponse {
    verdict: ReviewVerdict;
    text: string;
    reason: string;
    metadata: {
        reviewedBy: string[];
        runId: string | null;
        fallback?: boolean;
        fallbackReason?: string;
        steps?: Array<{ step: string; agent_id: string | null; length?: number }>;
    };
    escalation?: { to: string; reason: string };
}

export interface MemoryItem {
    id: number;
    agent_id: string;
    project_key: string;
    content: string;
    kind: 'lesson' | 'scenario' | 'fact' | 'preference' | 'context' | 'metric';
    created_at: string;
}

// ── API methods ───────────────────────────────────────────────────────────

export async function ping(): Promise<{ status: string; service?: string; version?: string; serverTime?: string; capabilities?: any }> {
    return request('/api/integration/ping', { method: 'GET' }, 8000);
}

/**
 * v2.0: default mode=fallback per SETUP-aiass-final.md.
 * Configurable via DNAI_REVIEW_MODE env (strict | fallback).
 */
const DEFAULT_MODE: 'strict' | 'fallback' =
    (process.env.DNAI_REVIEW_MODE as 'strict' | 'fallback') || 'fallback';

export async function review(req: ReviewRequest, idempotencyKey?: string): Promise<ReviewResponse> {
    const agentId = 'arthur';
    const extraHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey) extraHeaders['Idempotency-Key'] = idempotencyKey;
    return request(`/api/agents/${agentId}/review`, {
        method: 'POST',
        headers: extraHeaders,
        body: JSON.stringify({
            dialogueId: req.dialogueId,
            draft: req.draft,
            intent: req.intent,
            recentMessages: req.recentMessages || [],
            clientContext: req.clientContext || {},
            mode: req.mode || DEFAULT_MODE,
            options: req.options || {},
        }),
    }, req.options?.timeout ?? TIMEOUT_MS);
}

/**
 * Detect topic of conversation for project_key lookup.
 * Returns 'moneo-game' / 'alma-product' / 'wm-rules' / null.
 */
export function detectTopic(text: string): string | null {
    if (!text) return null;
    const t = text.toLowerCase();
    if (/(moneo|монео|турнир|игр[аеу]|cashflow|кешфло)/iu.test(t)) return 'moneo-game';
    if (/(alma|алма|ии[\s-]?агент|бот[\s-]?для|автоматизаци|внедрени|интеграц)/iu.test(t)) return 'alma-product';
    if (/(wave\s*match|нетворкинг|знакомств|партн[её]р|спец|клиент)/iu.test(t)) return 'wm-rules';
    return null;
}

export async function memoryLoad(agentId: string, projectKey: string): Promise<{ items: MemoryItem[]; count: number }> {
    return request(`/api/memory/load?agent_id=${encodeURIComponent(agentId)}&project_key=${encodeURIComponent(projectKey)}`, { method: 'GET' });
}

export async function memoryProjects(agentId: string): Promise<{ projects: Array<{ project_key: string; entries: number; last_updated: string }> }> {
    return request(`/api/memory/projects?agent_id=${encodeURIComponent(agentId)}`, { method: 'GET' });
}

export async function memorySave(req: { agent_id: string; project_key: string; content: string; kind?: MemoryItem['kind'] }): Promise<{ ok: boolean; id: number; created_at: string }> {
    return request('/api/memory/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
    });
}

// ── Smoke test: all 4 capabilities + ping ─────────────────────────────────

export interface SmokeResult {
    keyConfigured: boolean;
    keyMasked: string;
    baseUrl: string;
    envCheck: {
        DNAI_STUDIO_API_KEY: boolean;
        DNAI_API_KEY: boolean;
        DNAI_BASE_URL: boolean;
        DNAI_INTEGRATION_ENABLED: string | null;
        DNAI_REVIEW_MODE: string | null;
        DNAI_ROLLOUT_PCT: string | null;
    };
    ping: { ok: boolean; data?: any; err?: string };
    memoryProjects: { ok: boolean; data?: any; err?: string };
    memoryLoad: { ok: boolean; data?: any; err?: string };
    review: { ok: boolean; data?: any; err?: string };
}

export async function smoke(): Promise<SmokeResult> {
    const r: SmokeResult = {
        keyConfigured: !!API_KEY,
        keyMasked: maskApiKey(),
        baseUrl: BASE_URL,
        envCheck: {
            DNAI_STUDIO_API_KEY: !!process.env.DNAI_STUDIO_API_KEY,
            DNAI_API_KEY: !!process.env.DNAI_API_KEY,
            DNAI_BASE_URL: !!process.env.DNAI_BASE_URL,
            DNAI_INTEGRATION_ENABLED: process.env.DNAI_INTEGRATION_ENABLED ?? null,
            DNAI_REVIEW_MODE: process.env.DNAI_REVIEW_MODE ?? null,
            DNAI_ROLLOUT_PCT: process.env.DNAI_ROLLOUT_PCT ?? null,
        },
        ping: { ok: false },
        memoryProjects: { ok: false },
        memoryLoad: { ok: false },
        review: { ok: false },
    };
    if (!API_KEY) return r;

    try { r.ping.data = await ping(); r.ping.ok = true; } catch (e: any) { r.ping.err = e.message; }
    try { r.memoryProjects.data = await memoryProjects('arthur'); r.memoryProjects.ok = true; } catch (e: any) { r.memoryProjects.err = e.message; }
    try { r.memoryLoad.data = await memoryLoad('arthur', 'wm-rules'); r.memoryLoad.ok = true; } catch (e: any) { r.memoryLoad.err = e.message; }
    try {
        r.review.data = await review({
            dialogueId: 'smoke-test',
            draft: 'Здравствуйте! Тестовое сообщение от aiass для проверки review-цепочки.',
            recentMessages: [{ sender: 'USER', text: 'Привет', createdAt: new Date().toISOString() }],
        });
        r.review.ok = true;
    } catch (e: any) { r.review.err = e.message; }
    return r;
}
