// ── Welcome Builder ───────────────────────────────────────────────────────
// Строит сообщения для 3-стадийного welcome (Принцип #17):
//   Stage 1 — intro
//   Stage 2 — тизер анализа (если есть public sources)
//   Stage 3 — карточка (отправляется ТОЛЬКО после consent)
// Stage 1+2 шлются вместе при первом контакте. Stage 3 готовится но
// откладывается до signal от юзера.

import { EnrichedProfile } from './profileEnricher';

// Возвращает чистое имя или null. NEVER "друг" — fallback в opener
// делается через time-based приветствие.
function cleanFirstName(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let s = raw.split(/[|,/]/u)[0].trim();
    s = s.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (!s) return null;
    const firstWord = s.split(/\s+/u)[0];
    const titleWords = /^(психолог|тренер|коуч|эксперт|founder|ceo|основатель|предприниматель|инвестор|консультант|expert)$/iu;
    if (titleWords.test(firstWord)) return null;
    if (firstWord.length < 2 || firstWord.length > 25) return null;
    return firstWord;
}

// Time-based greeting в Moscow time. Roman: "либо имя либо приветствие
// доброе утро/день/вечер в зависимости от времени".
function timeGreeting(): string {
    const utcH = new Date().getUTCHours();
    const mskH = (utcH + 3) % 24;
    if (mskH >= 5 && mskH < 12) return 'Доброе утро';
    if (mskH >= 12 && mskH < 17) return 'Добрый день';
    if (mskH >= 17 && mskH < 23) return 'Добрый вечер';
    return 'Доброй ночи';
}

// Opener: "{Имя}, добрый день!" если имя есть, иначе "Добрый день!".
// Никогда "друг" / "уважаемый" / другие шаблоны.
function buildOpener(name: string | null): string {
    const greet = timeGreeting();
    if (name) return `${name}, ${greet.toLowerCase()}!`;
    return `${greet}!`;
}

export interface WelcomeMessages {
    stage1: string;                    // знакомство + причина + soft-вопрос + ask про визитку
    cardBrief: string | null;          // 1-предложение визитка (null если нет источников)
    cardFull: string | null;           // структурированная полная визитка + "что поменять?"
    cardGaps: string | null;           // предложение добавить недостающие поля для матчинга
    cardQuestions: string | null;      // fallback questionnaire когда данных мало
    hasEnrichment: boolean;
}

export function buildWelcomeMessages(profile: EnrichedProfile): WelcomeMessages {
    const fn = cleanFirstName(profile.firstName);
    const opener = buildOpener(fn);

    const stage1 =
        `${opener}\n\n` +
        `Вы регистрировались у нас в Wave Match — я Ваш ассистент по нетворкингу.\n\n` +
        `Помогаю участникам соединяться по запросам через ИИ-матчинг. Вам актуальны сейчас нетворкинг и, возможно, новые партнёрства?\n\n` +
        `Я могу помочь составить интересную визитку, Вам интересно?`;

    // Считаем факты для решения: card vs questionnaire
    let factCount = 0;
    if (profile.wmRole || profile.wmIndustry) factCount++;
    if (profile.wmLocation) factCount++;
    if (profile.wmCompany) factCount++;
    if (profile.websites.length > 0) factCount++;
    if (profile.igHandle) factCount++;
    if (profile.wmHobbies.length > 0) factCount++;

    // Если данных мало — не строим карточку, шлём опросник.
    // Roman: «если данных мало → "вы можете ответить на вопросы" + задаёшь
    // вопросы из каталога: чем занимаетесь / хобби / кого ищете».
    if (!profile.hasPublicSources || factCount < 2) {
        const cardQuestions =
            `Чтобы собрать Вашу визитку — расскажите коротко:\n\n` +
            `• Чем занимаетесь?\n` +
            `• Хобби, увлечения?\n` +
            `• Кого сейчас ищете — клиенты, партнёры или спецы?\n\n` +
            `Достаточно в свободной форме.`;
        return { stage1, cardBrief: null, cardFull: null, cardGaps: null, cardQuestions, hasEnrichment: true };
    }

    // ── Brief визитка (1 предложение) ─────────────────────────────────
    const briefParts: string[] = [];
    const fullName = profile.igFullName || fn || profile.username || 'Участник Wave Match';
    briefParts.push(fullName);

    const activity: string[] = [];
    if (profile.wmRole) activity.push(profile.wmRole);
    if (profile.wmIndustry && profile.wmIndustry !== profile.wmRole) activity.push(profile.wmIndustry);
    if (activity.length > 0) briefParts.push(activity.join(' + '));

    const primarySite = profile.websites[0];
    if (primarySite?.title) briefParts.push(primarySite.title.slice(0, 80));

    if (profile.wmLocation) briefParts.push(profile.wmLocation);

    const brief = briefParts.join('. ') + '.';
    const cardBrief = `Подготовил для Вас краткую визитку:\n\n«${brief}»`;

    // ── Полная визитка (структурированная) ────────────────────────────
    const fullLines: string[] = [];
    fullLines.push(`👤 ${fullName}${profile.username ? ` (@${profile.username})` : ''}`);
    if (activity.length > 0) fullLines.push(`🎯 Род деятельности: ${activity.join(' / ')}`);
    if (profile.wmCompany) fullLines.push(`🏢 Компания: ${profile.wmCompany}`);
    if (primarySite) {
        if (primarySite.title && !profile.wmCompany) fullLines.push(`🏢 Бренд: ${primarySite.title.slice(0, 100)}`);
        fullLines.push(`🌐 Сайт: ${primarySite.url}`);
    }
    if (profile.wmLocation) fullLines.push(`📍 Локация: ${profile.wmLocation}`);
    if (profile.igHandle) {
        const followers = profile.igFollowers
            ? ` (${profile.igFollowers >= 1000 ? `${Math.round(profile.igFollowers / 100) / 10}K` : profile.igFollowers} подписчиков)`
            : '';
        // Полный URL — Telegram авто-делает кликабельным
        fullLines.push(`📸 Instagram: https://instagram.com/${profile.igHandle}${followers}`);
    }
    if (primarySite?.description) {
        fullLines.push(`💡 Подход: ${primarySite.description.slice(0, 200)}`);
    }
    if (profile.wmHobbies.length > 0) {
        fullLines.push(`🎮 Хобби: ${profile.wmHobbies.slice(0, 8).join(', ')}`);
    }
    if (profile.wmInterests.length > 0) {
        fullLines.push(`🎯 Интересы: ${profile.wmInterests.slice(0, 8).join(', ')}`);
    }

    const cardFull = `А вот полная визитка:\n\n${fullLines.join('\n')}\n\nЧто бы Вы поменяли или добавили?`;

    // ── Gap analysis: что бы помогло матчингу но отсутствует ──────────
    // WM-схема для матчинга использует: hobbies / interests / bestClients /
    // requests / networkingGoal. Карточка из public sources их не покрывает —
    // предлагаем юзеру кратко заполнить через диалог.
    const gapItems: string[] = [];
    gapItems.push('• Хобби — для подбора по личным интересам');
    gapItems.push('• Темы или сферы, что сейчас интересны (книги, психология, инвестиции…)');
    gapItems.push('• Кого ищете — клиенты, партнёры или специалисты под задачу');
    gapItems.push('• Запросы по жизни — отношения, развитие, окружение');
    const cardGaps =
        `Также для лучшего матчинга было бы полезно дополнить визитку:\n\n` +
        gapItems.join('\n') +
        `\n\nЕсли хотите — расскажите коротко по одному из пунктов.`;

    return { stage1, cardBrief, cardFull, cardGaps, cardQuestions: null, hasEnrichment: true };
}
