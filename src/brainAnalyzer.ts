// ── Conversation Brain — Daily Analyzer ─────────────────────────────────────
// Reads dialogues from the last N days + their outcomes, asks an LLM to
// extract patterns: what works (recommend) + what doesn't (avoid), grouped by
// stage. Persists as LearnedScenario rows with source='auto_analyzer'.
//
// Roman reviews them in the admin "Brain" tab and decides which to activate.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import prisma from './db';
import type { Dialogue, Message, DialogueStage, DialogueOutcome } from '@prisma/client';
import { notifyAdmin } from './notify';

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const ANALYZE_WINDOW_DAYS = Number(process.env.BRAIN_ANALYZE_WINDOW_DAYS || 7);
const MAX_DIALOGUES_PER_RUN = Number(process.env.BRAIN_MAX_DIALOGUES || 50);

let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;
function anthropic(): Anthropic | null {
    if (_anthropic) return _anthropic;
    const k = process.env.ANTHROPIC_API_KEY;
    if (!k) return null;
    _anthropic = new Anthropic({ apiKey: k });
    return _anthropic;
}
function openai(): OpenAI | null {
    if (_openai) return _openai;
    const k = process.env.OPENAI_API_KEY;
    if (!k) return null;
    _openai = new OpenAI({ apiKey: k });
    return _openai;
}

interface DialogueDigest {
    id: number;
    stage: DialogueStage;
    outcome: DialogueOutcome;
    messages: { sender: string; text: string }[];
}

async function loadRecentDialogues(): Promise<DialogueDigest[]> {
    const cutoff = new Date(Date.now() - ANALYZE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await prisma.dialogue.findMany({
        where: { updatedAt: { gte: cutoff } },
        orderBy: { updatedAt: 'desc' },
        take: MAX_DIALOGUES_PER_RUN,
        include: {
            messages: {
                orderBy: { id: 'asc' },
                take: 30,
                select: { sender: true, text: true },
            },
        },
    });
    return rows.map((d) => ({
        id: d.id,
        stage: d.stage,
        outcome: d.outcome,
        messages: d.messages.map((m) => ({
            sender: m.sender,
            text: (m.text || '').slice(0, 600),
        })),
    }));
}

function buildPrompt(dialogues: DialogueDigest[]): string {
    const blocks: string[] = [];
    blocks.push('Ты — аналитик переписок Wave Match. Прочитай реальные диалоги ниже и извлеки PATTERNS.');
    blocks.push('');
    blocks.push('Wave Match — нетворкинг-сервис. Бот пишет первым, юзер отвечает, бот ведёт к матчу.');
    blocks.push(`Outcomes которые можно встретить: IN_PROGRESS / DROPPED_NO_REPLY / DROPPED_ICED / QUALIFIED / MATCHED / CUSTOMER.`);
    blocks.push('');
    blocks.push('=== ДИАЛОГИ ===');
    blocks.push('');
    for (const d of dialogues) {
        blocks.push(`--- dialogue ${d.id} | stage=${d.stage} | outcome=${d.outcome} ---`);
        for (const m of d.messages) {
            blocks.push(`  ${m.sender}: ${m.text.replace(/\n/g, ' ')}`);
        }
        blocks.push('');
    }
    blocks.push('=== ЗАДАЧА ===');
    blocks.push('Извлеки до 8 ПАТТЕРНОВ. Для каждого:');
    blocks.push('  - stage (DISCOVERY / OFFER / QUALIFICATION / CLOSED)');
    blocks.push('  - trigger (когда применять — короткое описание ситуации, например «юзер уклоняется фразой "посмотри в профиле"»)');
    blocks.push('  - recommend (что говорить — 1-2 предложения максимум)');
    blocks.push('  - avoid (что НЕ говорить — типичный фейл)');
    blocks.push('');
    blocks.push('Приоритет — паттерны из QUALIFIED/MATCHED dialogues (что РАБОТАЕТ).');
    blocks.push('Анти-паттерны из DROPPED_* (что НЕ работает).');
    blocks.push('Не дублируй существующие принципы (#4 mirror, #11 не двоить привет — это уже зашито).');
    blocks.push('');
    blocks.push('Верни ТОЛЬКО валидный JSON:');
    blocks.push('{');
    blocks.push('  "patterns": [');
    blocks.push('    { "stage": "DISCOVERY", "trigger": "...", "recommend": "...", "avoid": "..." }');
    blocks.push('  ]');
    blocks.push('}');

    return blocks.join('\n');
}

function parseJson(text: string): { patterns: Array<{ stage: string; trigger: string; recommend: string; avoid?: string }> } | null {
    if (!text) return null;
    let s = text.replace(/```json\s*|\s*```/g, '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (m) s = m[0];
    try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed?.patterns)) return parsed;
    } catch (e) {
        console.error('[brain-analyzer] JSON parse failed:', text.substring(0, 200));
    }
    return null;
}

async function callAI(prompt: string): Promise<{ patterns: any[] } | null> {
    if (PROVIDER === 'anthropic') {
        const c = anthropic();
        if (c) {
            try {
                const r = await c.messages.create({
                    model: ANTHROPIC_MODEL,
                    max_tokens: 3000,
                    temperature: 0.3,
                    messages: [{ role: 'user', content: prompt }],
                });
                const block = r.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined;
                if (block) return parseJson(block.text);
            } catch (e: any) {
                console.error('[brain-analyzer] Anthropic err:', e.message);
            }
        }
    }
    const o = openai();
    if (!o) return null;
    try {
        const r = await o.chat.completions.create({
            model: OPENAI_MODEL,
            temperature: 0.3,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: prompt }],
        });
        return parseJson(r.choices[0]?.message?.content || '');
    } catch (e: any) {
        console.error('[brain-analyzer] OpenAI err:', e.message);
        return null;
    }
}

const ALLOWED_STAGES = ['DISCOVERY', 'OFFER', 'QUALIFICATION', 'CLOSED'];

export interface AnalyzerRunResult {
    dialogues: number;
    extracted: number;
    saved: number;
    error?: string;
}

export async function runDailyAnalyzer(): Promise<AnalyzerRunResult> {
    try {
        const dialogues = await loadRecentDialogues();
        if (dialogues.length === 0) {
            return { dialogues: 0, extracted: 0, saved: 0, error: 'no recent dialogues' };
        }
        console.log(`[brain-analyzer] Analyzing ${dialogues.length} dialogues...`);

        const prompt = buildPrompt(dialogues);
        const result = await callAI(prompt);
        if (!result) return { dialogues: dialogues.length, extracted: 0, saved: 0, error: 'AI call failed' };

        // batchId — общий для всех паттернов одного прогона (для группировки в админке).
        const batchId = `ba-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;

        let saved = 0;
        let dnaiPendingPushed = 0;
        for (const p of result.patterns) {
            if (!ALLOWED_STAGES.includes(p.stage)) continue;
            if (!p.trigger || !p.recommend) continue;

            // Don't duplicate by trigger text
            const exists = await prisma.learnedScenario.findFirst({
                where: { trigger: p.trigger, source: 'auto_analyzer' },
            });
            if (exists) continue;

            await prisma.learnedScenario.create({
                data: {
                    stage: p.stage as any,
                    trigger: p.trigger.slice(0, 500),
                    recommend: p.recommend.slice(0, 1000),
                    avoid: (p.avoid || null)?.slice(0, 500),
                    source: 'auto_analyzer',
                    isActive: false, // Operator must approve before bot uses it
                    notes: `Generated from ${dialogues.length} dialogues window=${ANALYZE_WINDOW_DAYS}d batchId=${batchId}`,
                },
            });
            saved++;

            // ── DNAI shared memory (v1.1, TZ-aiass-brain-analyzer-approval) ──
            // Пушим со status='pending' — паттерн уходит в admin UI на approval,
            // Артур не видит его в memoryLoad до явного одобрения.
            // source_meta содержит batchId + confidence + сэмплы — оператор
            // видит контекст при просмотре карточки.
            try {
                const { isDnaiEnabled, memorySave } = await import('./dnaiClient');
                if (isDnaiEnabled()) {
                    const projectKey = `aiass-${p.stage.toLowerCase()}`;
                    const content = `[${p.stage}] WHEN: ${p.trigger}\nRECOMMEND: ${p.recommend}${p.avoid ? `\nAVOID: ${p.avoid}` : ''}`;
                    await memorySave({
                        agent_id: 'arthur',
                        project_key: projectKey,
                        content: content.slice(0, 2000),
                        kind: 'scenario',
                        status: 'pending',
                        submitted_by: 'brain-analyzer@aiass',
                        source_meta: {
                            batchId,
                            stage: p.stage,
                            dialogsAnalyzed: dialogues.length,
                            windowDays: ANALYZE_WINDOW_DAYS,
                        },
                    });
                    dnaiPendingPushed++;
                    console.log(`[dnai-memory-save] pushed PENDING pattern to ${projectKey} (batchId=${batchId})`);
                }
            } catch (e: any) {
                console.warn('[dnai-memory-save] err (non-blocking):', e.message);
            }
        }

        // Telegram-уведомление с deeplink в админку DNAI (per TZ §4 step 3).
        const dnaiAdminUrl = process.env.DNAI_ADMIN_URL || 'https://dnai.up.railway.app';
        await notifyAdmin(
            `🧠 Brain Analyzer: проанализировал ${dialogues.length} диалогов, ` +
            `извлёк ${result.patterns.length} паттернов, сохранил ${saved} новых.\n\n` +
            (dnaiPendingPushed > 0
                ? `📥 ${dnaiPendingPushed} паттерн(ов) на approval в DNAI:\n${dnaiAdminUrl} (раздел Артур → 📥 Паттерны)\n\n`
                : '') +
            `batchId: ${batchId}`
        );

        return { dialogues: dialogues.length, extracted: result.patterns.length, saved };
    } catch (e: any) {
        console.error('[brain-analyzer] runDailyAnalyzer error:', e);
        return { dialogues: 0, extracted: 0, saved: 0, error: e.message };
    }
}

// Cron-like scheduler: fire once per day at ~04:00 UTC.
export function startBrainAnalyzerCron() {
    const HOUR_MS = 60 * 60 * 1000;
    const targetHour = 4; // UTC

    function scheduleNext() {
        const now = new Date();
        const next = new Date(now);
        next.setUTCHours(targetHour, 0, 0, 0);
        if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
        const delay = next.getTime() - now.getTime();
        setTimeout(async () => {
            await runDailyAnalyzer().catch(e => console.error('[brain-cron] error', e));
            scheduleNext();
        }, delay).unref?.();
        console.log(`[brain-cron] Next run in ~${(delay / HOUR_MS).toFixed(1)}h (UTC ${targetHour}:00)`);
    }
    scheduleNext();
}
