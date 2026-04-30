// ── Business Card Generator ─────────────────────────────────────────────────
// Builds a brief (1-line for partner display) and full (structured card with
// hobbies/interests sections) for any user we have data on.
//
// Pulls from THREE sources:
//   1. Local Prisma User (extracted fields: city, activity, businessCard, ...)
//   2. Wave Match profile (role, industry, location, company, skills, hobbies, tags)
//   3. Public Telegram bio scraped from t.me/<username>
//
// Generation goes through Claude/OpenAI to produce clean, human-sounding text.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import prisma from './db';
import type { User } from '@prisma/client';
import { getUserByTelegramId, isWMEnabled, type WMUser } from './wmClient';

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

let _anthropic: Anthropic | null = null;
function anthropic(): Anthropic | null {
    if (_anthropic) return _anthropic;
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    _anthropic = new Anthropic({ apiKey: key });
    return _anthropic;
}

let _openai: OpenAI | null = null;
function openai(): OpenAI | null {
    if (_openai) return _openai;
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    _openai = new OpenAI({ apiKey: key });
    return _openai;
}

interface CardSources {
    user: User;
    wm: WMUser | null;
    tgTitle: string | null;
    tgBio: string | null;
}

async function fetchTgPublic(username: string | null | undefined): Promise<{ title: string | null; bio: string | null }> {
    if (!username) return { title: null, bio: null };
    try {
        const res = await fetch(`https://t.me/${encodeURIComponent(username)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return { title: null, bio: null };
        const html = await res.text();
        const titleMatch = html.match(/<div class="tgme_page_title"><span[^>]*>([^<]+)<\/span>/);
        const bioMatch = html.match(/<div class="tgme_page_description[^"]*">([\s\S]*?)<\/div>/);
        const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return {
            title: titleMatch ? stripTags(titleMatch[1]) : null,
            bio: bioMatch ? stripTags(bioMatch[1]).slice(0, 600) : null,
        };
    } catch {
        return { title: null, bio: null };
    }
}

async function gatherSources(userId: number): Promise<CardSources> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error(`User ${userId} not found`);

    let wm: WMUser | null = null;
    if (isWMEnabled() && user.telegramId) {
        wm = await getUserByTelegramId(user.telegramId, 'profile,subscription').catch(() => null);
    }

    const { title, bio } = await fetchTgPublic(user.username);
    return { user, wm, tgTitle: title, tgBio: bio };
}

// ── Prompt builder ─────────────────────────────────────────────────────────

function buildPrompt(s: CardSources): string {
    const { user, wm, tgTitle, tgBio } = s;
    const lines: string[] = [];

    lines.push('Ты составляешь визитку человека из данных нескольких источников. Сделай ДВЕ версии:');
    lines.push('');
    lines.push('1) BRIEF — одна-две сильных фразы (40-80 слов) для отправки потенциальным партнёрам. Только суть деятельности и контекст. Без эмодзи. Без приветствий.');
    lines.push('   Пример: «Антон Ро Батень. AI-архитектура и трансформация бизнеса. dnai.engineering. Бали.»');
    lines.push('');
    lines.push('2) FULL — структурированная карточка с категориями (имя, род деятельности, сфера, локация, бренд, подход, хобби, интересы). Используй эмодзи перед каждой строкой. Если поле пустое — пиши "пока не указано". В конце предложи дополнить.');
    lines.push('');
    lines.push('Тон: на «Вы», без «робот», без льстивых эпитетов («интересная сфера»). Не повторяй одно и то же дважды.');
    lines.push('');
    lines.push('=== ИСТОЧНИКИ ===');
    lines.push('');
    lines.push('Local fields:');
    lines.push(`  firstName: ${user.firstName || '-'}`);
    lines.push(`  lastName:  ${user.lastName || '-'}`);
    lines.push(`  username:  @${user.username || '-'}`);
    lines.push(`  city:      ${user.city || '-'}`);
    lines.push(`  activity:  ${user.activity || '-'}`);
    lines.push(`  businessCard (free-text): ${user.businessCard || '-'}`);
    lines.push(`  bestClients: ${user.bestClients || '-'}`);
    lines.push(`  requests:    ${user.requests || '-'}`);
    lines.push(`  hobbies:     ${user.hobbies || '-'}`);
    lines.push(`  networkingGoal: ${user.networkingGoal || '-'}`);
    lines.push('');

    if (wm) {
        const p = wm.profile || {};
        lines.push('Wave Match profile:');
        lines.push(`  firstName: ${wm.firstName || '-'}`);
        lines.push(`  lastName:  ${wm.lastName || '-'}`);
        lines.push(`  role:      ${p.role || '-'}`);
        lines.push(`  industry:  ${p.industry || '-'}`);
        lines.push(`  location:  ${p.location || '-'}`);
        lines.push(`  company:   ${p.company || '-'}`);
        lines.push(`  skills:    ${(p.skills || []).join(', ') || '-'}`);
        lines.push(`  hobbies:   ${(p.hobbies || []).join(', ') || '-'}`);
        lines.push(`  tags:      ${(p.tags || []).join(', ') || '-'}`);
        lines.push(`  tier:      ${wm.subscription?.tier || '-'}`);
        lines.push(`  completion: ${p.completion ?? 0}%`);
        lines.push('');
    }

    if (tgTitle || tgBio) {
        lines.push('Telegram public bio:');
        if (tgTitle) lines.push(`  title: ${tgTitle}`);
        if (tgBio) lines.push(`  bio:   ${tgBio}`);
        lines.push('');
    }

    lines.push('=== ВЫВОД ===');
    lines.push('Верни ТОЛЬКО валидный JSON без markdown-обёртки:');
    lines.push('{');
    lines.push('  "brief": "...",');
    lines.push('  "full": "..."');
    lines.push('}');

    return lines.join('\n');
}

function parseJson(text: string): { brief: string; full: string } | null {
    if (!text) return null;
    let s = text.replace(/```json\s*|\s*```/g, '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (m) s = m[0];
    try {
        const parsed = JSON.parse(s);
        if (typeof parsed?.brief === 'string' && typeof parsed?.full === 'string') return parsed;
    } catch (e) {
        console.error('[business-card] JSON parse failed:', text.substring(0, 200));
    }
    return null;
}

async function callAI(prompt: string): Promise<{ brief: string; full: string } | null> {
    if (PROVIDER === 'anthropic') {
        const c = anthropic();
        if (c) {
            try {
                const r = await c.messages.create({
                    model: ANTHROPIC_MODEL,
                    max_tokens: 1500,
                    temperature: 0.5,
                    messages: [{ role: 'user', content: prompt }],
                });
                const block = r.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined;
                if (block) return parseJson(block.text);
            } catch (e: any) {
                console.error('[business-card] Anthropic err:', e.message);
            }
        }
    }
    const o = openai();
    if (!o) return null;
    try {
        const r = await o.chat.completions.create({
            model: OPENAI_MODEL,
            temperature: 0.5,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: prompt }],
        });
        const text = r.choices[0]?.message?.content || '';
        return parseJson(text);
    } catch (e: any) {
        console.error('[business-card] OpenAI err:', e.message);
        return null;
    }
}

// ── Main entry: generate (or refresh) cached visit cards ────────────────────

export interface BusinessCardResult {
    brief: string;
    full: string;
    sources: { local: boolean; wm: boolean; tg: boolean };
}

export async function generateBusinessCard(userId: number, opts: { force?: boolean } = {}): Promise<BusinessCardResult | null> {
    const sources = await gatherSources(userId);
    const prompt = buildPrompt(sources);
    const result = await callAI(prompt);
    if (!result) return null;

    await prisma.user.update({
        where: { id: userId },
        data: {
            briefCard: result.brief,
            fullCard: result.full,
            cardGeneratedAt: new Date(),
        },
    });

    return {
        brief: result.brief,
        full: result.full,
        sources: {
            local: !!(sources.user.activity || sources.user.city || sources.user.businessCard),
            wm: !!sources.wm,
            tg: !!(sources.tgBio || sources.tgTitle),
        },
    };
}

// Quick read of cached card without regenerating
export async function getCachedCard(userId: number): Promise<{ brief: string; full: string; generatedAt: Date | null } | null> {
    const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { briefCard: true, fullCard: true, cardGeneratedAt: true },
    });
    if (!u || !u.briefCard || !u.fullCard) return null;
    return { brief: u.briefCard, full: u.fullCard, generatedAt: u.cardGeneratedAt };
}
