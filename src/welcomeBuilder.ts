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
    stage1: string;                    // знакомство + причина + soft-вопрос про networking + ask про визитку
    stage2: string | null;             // "посмотрел страницы — собрать визитку, прислать?" (null если нет источников)
    stage3: string;                    // готовая карточка (отправлять только после второго consent)
    hasEnrichment: boolean;
}

export function buildWelcomeMessages(profile: EnrichedProfile): WelcomeMessages {
    const fn = cleanFirstName(profile.firstName);

    const stage1 =
        `${fn}, добрый день!\n\n` +
        `Вы регистрировались у нас в Wave Match — я Ваш ассистент по нетворкингу.\n\n` +
        `Помогаю участникам соединяться по запросам через ИИ-матчинг. Вам актуальны сейчас нетворкинг и, возможно, новые партнёрства?\n\n` +
        `Я могу помочь составить интересную визитку, Вам интересно?`;

    let stage2: string | null = null;
    if (profile.hasPublicSources) {
        stage2 = 'Я посмотрел Ваши публичные страницы — могу собрать визитку, чтобы подбирать релевантных партнёров. Прислать?';
    }

    // Card sourcing — что нашли
    const cardLines: string[] = [];
    cardLines.push(`👤 ${profile.igFullName || fn}${profile.username ? ` (@${profile.username})` : ''}`);

    // Activity = WM role + industry
    const activity: string[] = [];
    if (profile.wmRole) activity.push(profile.wmRole);
    if (profile.wmIndustry && profile.wmIndustry !== profile.wmRole) activity.push(profile.wmIndustry);
    if (activity.length > 0) cardLines.push(`🎯 Род деятельности: ${activity.join(' / ')}`);

    // Brand from website
    const primarySite = profile.websites[0];
    if (primarySite) {
        if (primarySite.title) cardLines.push(`🏢 Бренд: ${primarySite.title.slice(0, 100)}`);
        cardLines.push(`🌐 Сайт: ${primarySite.url}`);
    }

    if (profile.wmLocation) cardLines.push(`📍 Локация: ${profile.wmLocation}`);

    if (profile.igHandle) {
        const followers = profile.igFollowers ? ` (${profile.igFollowers >= 1000 ? `${Math.round(profile.igFollowers / 100) / 10}K` : profile.igFollowers} подписчиков)` : '';
        cardLines.push(`📸 Instagram: @${profile.igHandle}${followers}`);
    }

    if (primarySite?.description) {
        cardLines.push(`💡 Подход: ${primarySite.description.slice(0, 200)}`);
    }

    const stage3 = `Вот что собрал из публичных источников:\n\n${cardLines.join('\n')}\n\nЧто бы Вы поменяли или добавили?`;

    return {
        stage1,
        stage2,
        stage3,
        hasEnrichment: profile.hasPublicSources,
    };
}
