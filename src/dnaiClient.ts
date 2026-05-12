// ── DNAI Studio S2S API client ─────────────────────────────────────────────
// Hybrid architecture:
//   aiass-production (us) = execution layer (listener, KB, Match Engine,
//                            pendingSends, генерим candidate draft своим
//                            пайплайном 21 принципа)
//   DNAI Studio = control layer (review-chain Артур→Марк→Аида, project_memory)
//
// Per docs/api-s2s-integration.md (DNAI Studio repo).

const BASE_URL = process.env.DNAI_STUDIO_BASE_URL || 'https://dnai.up.railway.app';
const API_KEY = process.env.DNAI_STUDIO_API_KEY || '';
const TIMEOUT_MS = Number(process.env.DNAI_STUDIO_TIMEOUT_MS || 30_000);

export function isDnaiEnabled(): boolean {
    return !!API_KEY && process.env.INTEGRATION_DNAI_ENABLED === 'true';
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

export type ReviewVerdict = 'GO' | 'TWEAK' | 'NO-GO';

export interface ReviewRequest {
    dialogueId: string;
    draft?: string;
    intent?: string;
    recentMessages?: Array<{ sender: 'USER' | 'OPERATOR'; text: string; createdAt: string }>;
    clientContext?: { stage?: string; telegramUsername?: string; leadScore?: number };
    options?: { skipReviewChain?: boolean; timeout?: number };
}

export interface ReviewResponse {
    verdict: ReviewVerdict;
    text: string;
    reason: string;
    metadata: {
        reviewedBy: string[];
        runId: string;
        steps?: Array<{ step: string; agent_id: string; length?: number }>;
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

export async function review(req: ReviewRequest): Promise<ReviewResponse> {
    const agentId = 'arthur';
    return request(`/api/agents/${agentId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            dialogueId: req.dialogueId,
            draft: req.draft,
            intent: req.intent,
            recentMessages: req.recentMessages || [],
            clientContext: req.clientContext || {},
            options: req.options || {},
        }),
    }, req.options?.timeout ?? TIMEOUT_MS);
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
    baseUrl: string;
    ping: { ok: boolean; data?: any; err?: string };
    memoryProjects: { ok: boolean; data?: any; err?: string };
    memoryLoad: { ok: boolean; data?: any; err?: string };
    review: { ok: boolean; data?: any; err?: string };
}

export async function smoke(): Promise<SmokeResult> {
    const r: SmokeResult = {
        keyConfigured: !!API_KEY,
        baseUrl: BASE_URL,
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
