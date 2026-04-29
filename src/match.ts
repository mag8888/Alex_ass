import { User } from '@prisma/client';
import prisma from './db';

// ── Match-Engine ────────────────────────────────────────────────────────────
// Goal: for a given user A whose `requests` describes what they're looking for,
// find users B whose `activity` / `bestClients` / `businessCard` mention overlapping
// keywords. Score = count of overlapping tokens; ties broken by profile completeness.

const STOPWORDS = new Set([
    'и','в','на','с','по','для','к','от','до','из','а','но','же','как','что','это','то','за','при',
    'the','a','an','and','or','to','of','in','on','for','with','at','is','are','be',
    'я','ты','он','она','мы','вы','они','свой','свои','свою',
    'нужен','нужна','нужно','нужны','ищу','хочу','надо','буду','есть','был','была',
    'клиент','клиента','клиентов','задач','задачи','работы','работа','услуги','услуга',
]);

function tokenize(s?: string | null): Set<string> {
    if (!s) return new Set();
    return new Set(
        s.toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 4 && !STOPWORDS.has(t)),
    );
}

function profileCompleteness(u: User): number {
    const fields = [u.activity, u.city, u.businessCard, u.bestClients, u.requests, u.hobbies, u.currentIncome, u.desiredIncome];
    return fields.filter(f => f && String(f).trim().length > 0).length / fields.length;
}

export interface MatchResult {
    user: Pick<User, 'id' | 'telegramId' | 'username' | 'firstName' | 'lastName' | 'city' | 'activity' | 'requests' | 'bestClients'>;
    score: number;
    matchedKeywords: string[];
    profileCompleteness: number;
}

export async function findMatches(userId: number, limit = 5): Promise<MatchResult[]> {
    const me = await prisma.user.findUnique({ where: { id: userId } });
    if (!me) return [];

    // Tokens describing what THIS user is looking for
    const lookingFor = new Set([
        ...tokenize(me.requests),
        ...tokenize(me.networkingGoal),
    ]);

    // Tokens describing what THIS user offers
    const offers = new Set([
        ...tokenize(me.activity),
        ...tokenize(me.bestClients),
        ...tokenize(me.businessCard),
    ]);

    if (lookingFor.size === 0 && offers.size === 0) return [];

    // Pull all candidate users (cap at 1000 to keep it fast)
    const candidates = await prisma.user.findMany({
        where: {
            id: { not: userId },
            status: { notIn: ['REJECTED', 'BLOCKED', 'NEW'] },
            // At least one profile field has data
            OR: [
                { activity: { not: null } },
                { requests: { not: null } },
                { bestClients: { not: null } },
                { businessCard: { not: null } },
            ],
        },
        take: 1000,
        select: {
            id: true, telegramId: true, username: true, firstName: true, lastName: true,
            city: true, activity: true, businessCard: true, bestClients: true, requests: true,
            hobbies: true, currentIncome: true, desiredIncome: true,
        },
    });

    const scored: MatchResult[] = [];
    for (const c of candidates as User[]) {
        const cOffers = new Set([
            ...tokenize(c.activity),
            ...tokenize(c.bestClients),
            ...tokenize(c.businessCard),
        ]);
        const cLooking = new Set([...tokenize(c.requests), ...tokenize(c.networkingGoal)]);

        // Two-way matching:
        //   me.lookingFor ∩ c.offers   → candidate can help me
        //   me.offers     ∩ c.lookingFor → I can help candidate
        const matched: string[] = [];
        for (const t of lookingFor) if (cOffers.has(t)) matched.push(t);
        for (const t of offers) if (cLooking.has(t)) matched.push(`*${t}`); // mark mutual-direction

        if (matched.length === 0) continue;

        scored.push({
            user: {
                id: c.id, telegramId: c.telegramId, username: c.username,
                firstName: c.firstName, lastName: c.lastName,
                city: c.city, activity: c.activity, requests: c.requests, bestClients: c.bestClients,
            },
            score: matched.length,
            matchedKeywords: matched.slice(0, 8),
            profileCompleteness: profileCompleteness(c),
        });
    }

    // Sort: score desc, then completeness desc
    scored.sort((a, b) => b.score - a.score || b.profileCompleteness - a.profileCompleteness);
    return scored.slice(0, limit);
}

// ── Connect: создать черновики обоим юзерам и отметить как MATCHED ──────────

export interface ConnectResult {
    aDraftId: number;
    bDraftId: number;
    aDialogueId: number;
    bDialogueId: number;
}

export async function connectUsers(aId: number, bId: number, customIntro?: string): Promise<ConnectResult> {
    const [a, b] = await Promise.all([
        prisma.user.findUnique({ where: { id: aId } }),
        prisma.user.findUnique({ where: { id: bId } }),
    ]);
    if (!a) throw new Error(`User ${aId} not found`);
    if (!b) throw new Error(`User ${bId} not found`);

    const aDialogue = await prisma.dialogue.findFirst({ where: { userId: aId, status: 'ACTIVE' }, orderBy: { updatedAt: 'desc' } });
    const bDialogue = await prisma.dialogue.findFirst({ where: { userId: bId, status: 'ACTIVE' }, orderBy: { updatedAt: 'desc' } });
    if (!aDialogue) throw new Error(`No active dialogue with ${a.username}`);
    if (!bDialogue) throw new Error(`No active dialogue with ${b.username}`);

    const intro = customIntro?.trim();

    const draftForA = intro || buildIntro(a, b);
    const draftForB = intro || buildIntro(b, a);

    const [aMsg, bMsg] = await prisma.$transaction([
        prisma.message.create({
            data: { dialogueId: aDialogue.id, sender: 'SIMULATOR', text: draftForA, status: 'DRAFT' },
        }),
        prisma.message.create({
            data: { dialogueId: bDialogue.id, sender: 'SIMULATOR', text: draftForB, status: 'DRAFT' },
        }),
        prisma.user.update({ where: { id: aId }, data: { status: 'MATCHED' } }),
        prisma.user.update({ where: { id: bId }, data: { status: 'MATCHED' } }),
        prisma.dialogue.update({ where: { id: aDialogue.id }, data: { updatedAt: new Date() } }),
        prisma.dialogue.update({ where: { id: bDialogue.id }, data: { updatedAt: new Date() } }),
    ]);

    return {
        aDraftId: aMsg.id,
        bDraftId: bMsg.id,
        aDialogueId: aDialogue.id,
        bDialogueId: bDialogue.id,
    };
}

function buildIntro(target: User, other: User): string {
    const otherName = other.firstName || other.username || 'один человек';
    const otherActivity = other.activity ? `, ${other.activity.toLowerCase()}` : '';
    const otherCity = other.city ? `из ${other.city}` : '';
    const ctx = [otherActivity, otherCity].filter(Boolean).join(' ');

    return `Привет! Хочу познакомить вас с интересным человеком — ${otherName}${ctx}. Кажется, у вас могут быть точки соприкосновения. Если интересно, могу скинуть контакт?`;
}
