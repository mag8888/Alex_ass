// ── Welcome Builder ───────────────────────────────────────────────────────
// Строит сообщения для 3-стадийного welcome (Принцип #17):
//   Stage 1 — intro
//   Stage 2 — тизер анализа (если есть public sources)
//   Stage 3 — карточка (отправляется ТОЛЬКО после consent)
// Stage 1+2 шлются вместе при первом контакте. Stage 3 готовится но
// откладывается до signal от юзера.

import { EnrichedProfile } from './profileEnricher';

function cleanFirstName(raw: string | null | undefined): string {
    if (!raw) return 'друг';
    let s = raw.split('|')[0].trim();
    s = s.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (!s || s.length > 30) return 'друг';
    return s;
}

export interface WelcomeMessages {
    stage1: string;                    // знакомство + причина + soft-вопрос + ask про визитку
    cardBrief: string | null;          // 1-предложение визитка (null если нет источников)
    cardFull: string | null;           // структурированная полная визитка + "что поменять?"
    hasEnrichment: boolean;
}

export function buildWelcomeMessages(profile: EnrichedProfile): WelcomeMessages {
    const fn = cleanFirstName(profile.firstName);

    const stage1 =
        `${fn}, добрый день!\n\n` +
        `Вы регистрировались у нас в Wave Match — я Ваш ассистент по нетворкингу.\n\n` +
        `Помогаю участникам соединяться по запросам через ИИ-матчинг. Вам актуальны сейчас нетворкинг и, возможно, новые партнёрства?\n\n` +
        `Я могу помочь составить интересную визитку, Вам интересно?`;

    if (!profile.hasPublicSources) {
        return { stage1, cardBrief: null, cardFull: null, hasEnrichment: false };
    }

    // ── Brief визитка (1 предложение) ─────────────────────────────────
    const briefParts: string[] = [];
    const fullName = profile.igFullName || fn;
    briefParts.push(fullName);

    const activity: string[] = [];
    if (profile.wmRole) activity.push(profile.wmRole);
    if (profile.wmIndustry && profile.wmIndustry !== profile.wmRole) activity.push(profile.wmIndustry);
    if (activity.length > 0) briefParts.push(activity.join(' + '));

    const primarySite = profile.websites[0];
    if (primarySite?.title) briefParts.push(primarySite.title.slice(0, 80));

    if (profile.wmLocation) briefParts.push(profile.wmLocation);

    const brief = briefParts.join('. ') + '.';
    const cardBrief = `Краткая визитка:\n\n«${brief}»`;

    // ── Полная визитка (структурированная) ────────────────────────────
    const fullLines: string[] = [];
    fullLines.push(`👤 ${fullName}${profile.username ? ` (@${profile.username})` : ''}`);
    if (activity.length > 0) fullLines.push(`🎯 Род деятельности: ${activity.join(' / ')}`);
    if (primarySite) {
        if (primarySite.title) fullLines.push(`🏢 Бренд: ${primarySite.title.slice(0, 100)}`);
        fullLines.push(`🌐 Сайт: ${primarySite.url}`);
    }
    if (profile.wmLocation) fullLines.push(`📍 Локация: ${profile.wmLocation}`);
    if (profile.igHandle) {
        const followers = profile.igFollowers
            ? ` (${profile.igFollowers >= 1000 ? `${Math.round(profile.igFollowers / 100) / 10}K` : profile.igFollowers} подписчиков)`
            : '';
        fullLines.push(`📸 Instagram: @${profile.igHandle}${followers}`);
    }
    if (primarySite?.description) {
        fullLines.push(`💡 Подход: ${primarySite.description.slice(0, 200)}`);
    }

    const cardFull = `Полная визитка:\n\n${fullLines.join('\n')}\n\nЧто бы Вы поменяли или добавили?`;

    return { stage1, cardBrief, cardFull, hasEnrichment: true };
}
