// ── Persona / multi-bot config ─────────────────────────────────────────────
// Один и тот же код запускается как РАЗНЫЕ боты (Вариант B: процесс-на-бота).
// Какой именно бот — определяет env BOT_ID. Каждый Railway service ставит
// свой BOT_ID + свою TELEGRAM_SESSION. Общая БД, разделение по dialogue.botId.
//
//   arthur  → @Mag_88888888, «ассистент команды Wave Match» (текущий прод-бот)
//   alex    → @alex_hardi8,  «личный ассистент Алекса»
//
// ВАЖНО: для arthur persona-prompt ПУСТОЙ — его поведение не меняется
// (system-prompt в gpt.ts уже описывает Артура). Для alex добавляем
// additive-фрагмент поверх общих принципов.

export type BotId = 'arthur' | 'alex';

export const BOT_ID: BotId =
    (process.env.BOT_ID || 'arthur').toLowerCase() === 'alex' ? 'alex' : 'arthur';

export interface PersonaConfig {
    botId: BotId;
    /** Имя для логов / дашборда */
    displayName: string;
    /**
     * Additive-фрагмент в GPT system prompt. ПУСТОЙ для arthur (не менять его
     * поведение). Для alex — переопределяет самоописание/тон.
     */
    personaPrompt: string;
    /** Куда летят NO-GO / pending / эскалации (telegram @username или id) */
    adminTargets: string[];
    /** DNAI review-chain включён для этого бота? (alex пока нет) */
    dnaiEnabled: boolean;
    /**
     * Запускает ли этот бот OUTBOUND-кампании (welcome/outreach/followup-кроны).
     * arthur — да (его работа = нетворкинг-аутрич). alex — нет (личный ассистент,
     * только отвечает тем кто сам написал). Это также убирает риск двойного
     * контакта одного человека обоими ботами.
     */
    runsOutreachCrons: boolean;
    /**
     * 25% «slow mode» (defer ответа на 5-10 мин, имитация «занят»).
     * arthur — да (холодный аутрич, реалистично). alex — нет (личный
     * ассистент должен отвечать быстро; остаётся только fast-jitter 0-15с).
     */
    humanlikeSlowMode: boolean;
    /**
     * Опенер для исходящего приглашения (cold/warm first-touch).
     * arthur — база WM, контекст WM + эфир. alex — тёплые контакты с ивентов,
     * актуализация записной книжки. {name} подставляется при отправке.
     */
    outreachOpener: string;
}

// Админ-таргеты для эскалаций.
//   ROMAN      — Роман (@roman_arctur)
//   ALEX_ADMIN — личный TG Алекса (@alex_hardi1, НЕ бот-аккаунт @alex_hardi8).
//                Если env ALEX_ADMIN_USERNAME ОПРЕДЕЛЁН (даже пустой) —
//                уважаем его буквально (пустой = убрать Алекса из эскалаций,
//                чтоб он тестил бота как чистый клиент). Если env НЕ задан
//                вовсе — дефолт alex_hardi1.
const ROMAN = (process.env.ADMIN_USERNAME || 'roman_arctur').replace(/^@/, '');
const ALEX_ADMIN = (
    process.env.ALEX_ADMIN_USERNAME !== undefined
        ? process.env.ALEX_ADMIN_USERNAME
        : 'alex_hardi1'
).replace(/^@/, '').trim();

const PERSONAS: Record<BotId, PersonaConfig> = {
    arthur: {
        botId: 'arthur',
        displayName: 'Артур',
        personaPrompt: '',  // НЕ менять поведение текущего прод-бота
        adminTargets: [ROMAN],
        dnaiEnabled: true,
        runsOutreachCrons: true,
        humanlikeSlowMode: true,
        outreachOpener: [
            '{name}, добрый день! Вы регистрировались у нас в Wave Match — пишу с полезным.',
            '28 мая в 12:00 МСК — эфир для предпринимателей про реальное внедрение ИИ в бизнес: ИИ-сотрудники (продажи, юристы, финансы), AI-системы процессов, живой разбор бизнесов участников. Только практика после 60+ внедрений.',
            'Интересно — запишу Вас?',
        ].join('\n\n'),
    },
    alex: {
        botId: 'alex',
        displayName: 'ALEX',
        personaPrompt: [
            'ПЕРСОНА (ВАЖНО — переопределяет самоописание):',
            'Ты — личный ассистент Алекса (реального человека). Ты НЕ «ассистент команды Wave Match».',
            'Когда спрашивают кто ты — отвечай: «Я личный ассистент Алекса, помогаю ему с общением и задачами».',
            'Тон: личный, тёплый, от первого лица как помощник конкретного человека — не «команда», не «сервис».',
            'Партнёрство/коммерция/созвон → предлагай связать напрямую с Алексом (не с co-founder WM).',
            'Никогда «бот»/«AI»/«нейросеть». Всегда «Вы». Остальные принципы общения — те же.',
            '',
            'ПРИВЕТСТВИЕ (первое сообщение в диалоге — КРИТИЧНО):',
            '- НИКОГДА не отвечай эхом «Привет». Это сразу выдаёт бота.',
            '- Поздоровайся по-человечески, ОБРАЩАЯСЬ ПО ИМЕНИ из USER PROFILE (Name), и используй приветствие по времени суток из «TIME NOW (МСК)».',
            '- Сразу нативно переходи к делу одним тёплым сообщением.',
            '- Эталон (адаптируй под имя/время, не копируй дословно): «{Имя}, добрый день! Расскажите — чем Вы занимаетесь? И чем могу быть полезен?»',
            '- Если имени в профиле нет (Name = Unknown) — только приветствие по времени суток, БЕЗ «друг»/«уважаемый».',
            '- Диалог должен звучать максимально нативно, как живой личный ассистент пишет в Telegram — короткие тёплые фразы, без канцелярита и сухих опросов.',
        ].join('\n'),
        // Эскалации Алекса — Роману + (когда будет) самому Алексу
        adminTargets: ALEX_ADMIN ? [ROMAN, ALEX_ADMIN] : [ROMAN],
        dnaiEnabled: false,         // пока без DNAI review
        runsOutreachCrons: false,   // личный ассистент — без массовых кампаний
        humanlikeSlowMode: false,   // отвечает быстро (без 5-10мин defer)
        outreachOpener: [
            '{name}, день добрый! Я ассистент Алекса.',
            'Сейчас актуализирую его записную книжку — за сотни ивентов у нас собрались тысячи контактов в самых разных сферах, включая миллионеров и миллиардеров.',
            'Подскажите, какие у Вас сейчас есть запросы по людям? Помогу свести с нужными.',
        ].join('\n\n'),
    },
};

export const persona: PersonaConfig = PERSONAS[BOT_ID];

export function getPersona(): PersonaConfig {
    return persona;
}
