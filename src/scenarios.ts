import prisma from './db';

// ── Outreach scenarios for existing Wave Match users ────────────────────────
// Variables supported:
//   {firstName}                 — user.firstName, fallback "друг"
//   {зарегистрирован|...}      — gender block (male|female|unknown)
//   {ты|ты|вы}                  — same syntax
//
// Voice rules (apply to every scenario):
//   • казуальный тон, как живой человек, не корпоративный
//   • без формального обращения "Уважаемый"
//   • короткое первое сообщение: 2-4 предложения максимум
//   • заканчивается ОДНИМ открытым вопросом

export interface Scenario {
    name: string;        // unique key (used as Template.name)
    title: string;       // human-readable label
    content: string;     // template body with {placeholders}
    description: string; // when to use this
}

export const SCENARIOS: Scenario[] = [
    {
        name: 'wm_reactivation_general',
        title: '🔄 Реактивация — общий запрос',
        description: 'Тёплое касание клиента в базе. Спрашиваем, что сейчас актуально (клиенты, исполнители, партнёры).',
        content:
            `Привет, {firstName}! Я менеджер Wave Match 👋\n` +
            `{Ты уже зарегистрирован|Ты уже зарегистрирована|Вы у нас уже зарегистрированы} в системе. Хочу спросить — какие сейчас актуальные запросы? Может, нужны клиенты, исполнители или партнёры?\n` +
            `Расскажи в двух словах — посмотрю по нашей базе, кто из людей тебе подойдёт, и соединю.`,
    },
    {
        name: 'wm_reactivation_clients_or_team',
        title: '🎯 Что важнее: клиенты или команда?',
        description: 'Конкретизирующий вопрос — выбор из двух опций. Хорошо для клиентов, которые в прошлом просили обе стороны.',
        content:
            `Привет, {firstName}! Wave Match на связи.\n` +
            `Подбираем людей под запросы каждый день. Тебе сейчас актуальнее найти клиентов, или сотрудников/исполнителей в команду?\n` +
            `Скажи коротко чем занимаешься и что ищешь — найду подходящих людей в базе.`,
    },
    {
        name: 'wm_profile_completion',
        title: '📝 Дозаполнить профиль',
        description: 'Используй когда у клиента в WM-профиле мало данных. Бот вежливо просит инфу для подбора матчей.',
        content:
            `Привет, {firstName}! Менеджер Wave Match.\n` +
            `У меня в системе мало информации о тебе — поэтому подобрать сильные матчи трудно. Расскажи в 2-3 предложениях:\n` +
            `• чем сейчас занимаешься (сфера, продукт)\n` +
            `• что ищешь — клиентов, партнёров, людей в команду\n\n` +
            `На основе этого подберу тебе людей из базы.`,
    },
    {
        name: 'wm_specific_match_offer',
        title: '🤝 Есть кандидаты — хочешь познакомлю',
        description: 'Когда Match-Engine уже нашёл несколько релевантных людей, отправляем приглашение взглянуть.',
        content:
            `Привет, {firstName}! У нас в базе есть несколько людей, которые могут быть {тебе|тебе|вам} интересны.\n` +
            `Если интересно — скину короткие визитки и устрою знакомство в формате интро. Скажи "да" — пришлю.`,
    },
    {
        name: 'wm_soft_checkin',
        title: '☕ Мягкий check-in',
        description: 'Тёплое касание. Используй для активных клиентов раз в 2-3 недели чтобы оставаться в поле зрения.',
        content:
            `Привет, {firstName}! Как дела в проектах? Wave Match здесь, давно не общались.\n` +
            `{Если у тебя сейчас какие-то задачи актуальные|Если у тебя сейчас какие-то задачи актуальные|Если у вас сейчас какие-то задачи актуальные} — клиенты, нетворкинг, найм, партнёрства — пиши, у нас активная база и я подберу нужных людей.`,
    },
];

// Ensure all scenarios exist as DB Templates. Called once at server startup.
// Updates content if the in-code version changed (versioning by content hash).
export async function seedScenarios() {
    for (const s of SCENARIOS) {
        await prisma.template.upsert({
            where: { name: s.name },
            create: { name: s.name, content: s.content },
            update: { content: s.content }, // keep DB in sync with code
        });
    }
    console.log(`[scenarios] Seeded ${SCENARIOS.length} broadcast scenarios`);
}
