// ── Match engine ───────────────────────────────────────────────────────────
// Скорим пары юзеров по совместимости запрос↔предложение + общие интересы +
// общая локация. Возвращаем top-N для конкретного юзера. Используется в
// listener.ts: после extract'а профиля бот получает в системном промпте блок
// "POTENTIAL MATCHES" — и сам решает в диалоге, кого и когда предложить.

import { User } from '@prisma/client';
import prisma from './db';

// ── Tokenization ────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
    'и', 'в', 'на', 'с', 'по', 'для', 'к', 'у', 'от', 'до', 'из', 'за', 'под', 'над',
    'о', 'об', 'про', 'без', 'при', 'через', 'между', 'или', 'но', 'а', 'же', 'бы',
    'ли', 'не', 'ни', 'это', 'эта', 'эти', 'этот', 'тот', 'та', 'те', 'кто', 'что',
    'как', 'где', 'когда', 'почему', 'чтобы', 'если', 'хотя', 'пока', 'тоже',
    'также', 'ещё', 'еще', 'уже', 'был', 'была', 'было', 'были', 'есть', 'буду',
    'будет', 'мой', 'моя', 'моё', 'мои', 'ваш', 'ваша', 'наш', 'свой', 'свою',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'and', 'or', 'of', 'to',
    'for', 'in', 'on', 'at', 'by', 'with', 'from', 'as',
]);

function tokenize(s: string | null | undefined): string[] {
    if (!s) return [];
    return s
        .toLowerCase()
        .replace(/[.,!?;:()«»"'\[\]\\\/—–\-]+/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function tokenSet(s: string | null | undefined): Set<string> {
    return new Set(tokenize(s));
}

function intersectSize(a: Set<string>, b: Set<string>): number {
    let n = 0;
    for (const t of a) if (b.has(t)) n++;
    return n;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

export interface MatchScore {
    user: User;
    score: number;
    reasons: string[];
}

interface UserVector {
    needs: Set<string>;            // что юзер ищет: requests
    offers: Set<string>;           // что предлагает: activity + businessCard + bestClients
    hobbies: Set<string>;
    city: string | null;
    goal: Set<string>;
}

function vectorize(u: User): UserVector {
    const offerText = [u.activity, u.businessCard, u.bestClients].filter(Boolean).join(' ');
    return {
        needs: tokenSet(u.requests),
        offers: tokenSet(offerText),
        hobbies: tokenSet(u.hobbies),
        city: (u.city || '').trim().toLowerCase() || null,
        goal: tokenSet(u.networkingGoal),
    };
}

const W_OFFER_NEED = 3;     // их offer ↔ мой need
const W_NEED_OFFER = 3;     // мой offer ↔ их need
const W_HOBBY = 2;
const W_CITY = 2;
const W_GOAL = 1;

export function scorePair(me: User, them: User): MatchScore {
    const a = vectorize(me);
    const b = vectorize(them);

    const offerNeed = intersectSize(b.offers, a.needs);
    const needOffer = intersectSize(a.offers, b.needs);
    const hobbyOverlap = intersectSize(a.hobbies, b.hobbies);
    const goalOverlap = intersectSize(a.goal, b.goal);
    const cityMatch = a.city && b.city && a.city === b.city ? 1 : 0;

    const score =
        W_OFFER_NEED * offerNeed +
        W_NEED_OFFER * needOffer +
        W_HOBBY * hobbyOverlap +
        W_CITY * cityMatch +
        W_GOAL * goalOverlap;

    const reasons: string[] = [];
    if (offerNeed) reasons.push(`их предложение совпадает с вашим запросом (${offerNeed} совпад.)`);
    if (needOffer) reasons.push(`ваше предложение закрывает их запрос (${needOffer} совпад.)`);
    if (hobbyOverlap) reasons.push(`общие хобби (${hobbyOverlap})`);
    if (cityMatch) reasons.push(`один город: ${me.city}`);
    if (goalOverlap) reasons.push(`похожие networking-цели`);

    return { user: them, score, reasons };
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface FindMatchesOpts {
    limit?: number;
    minScore?: number;
}

export async function findMatches(userId: number, opts: FindMatchesOpts = {}): Promise<MatchScore[]> {
    const limit = opts.limit ?? 3;
    const minScore = opts.minScore ?? 4;

    const me = await prisma.user.findUnique({ where: { id: userId } });
    if (!me) return [];

    // Пул кандидатов: все юзеры кроме меня, не BLOCKED/REJECTED, с хоть каким-то заполненным профилем
    const candidates = await prisma.user.findMany({
        where: {
            id: { not: userId },
            status: { notIn: ['BLOCKED', 'REJECTED'] },
            OR: [
                { activity: { not: null } },
                { businessCard: { not: null } },
                { bestClients: { not: null } },
                { hobbies: { not: null } },
                { requests: { not: null } },
            ],
        },
        take: 500,
    });

    const scored = candidates
        .map(c => scorePair(me, c))
        .filter(s => s.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return scored;
}

// ── Format for GPT prompt injection ─────────────────────────────────────────

export function formatMatchesForPrompt(matches: MatchScore[]): string {
    if (matches.length === 0) return '';

    const lines: string[] = [];
    lines.push('=== POTENTIAL MATCHES (auto-найдены в локальной базе) ===');
    lines.push('Если в текущем сообщении уместно — предложи юзеру познакомиться с одним из них (НЕ списком, а ОДИН релевантный). Не списывай кредит на этом шаге — кредит снимется только когда юзер скажет "да".');

    for (const m of matches) {
        const u = m.user;
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || `id${u.id}`;
        const handle = u.username ? `@${u.username}` : `tg:${u.telegramId}`;

        lines.push('');
        lines.push(`MATCH score=${m.score} ${name} (${handle})`);
        if (u.activity) lines.push(`  activity: ${u.activity}`);
        if (u.businessCard) lines.push(`  card: ${u.businessCard.slice(0, 200)}`);
        if (u.bestClients) lines.push(`  ищет клиентов: ${u.bestClients.slice(0, 150)}`);
        if (u.requests) lines.push(`  запрос: ${u.requests.slice(0, 150)}`);
        if (u.hobbies) lines.push(`  хобби: ${u.hobbies}`);
        if (u.city) lines.push(`  город: ${u.city}`);
        lines.push(`  why-match: ${m.reasons.join('; ')}`);
    }

    return lines.join('\n');
}
