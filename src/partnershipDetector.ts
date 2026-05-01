// ── Partnership / Commercial Intent Detector ─────────────────────────────
// Roman: при намёке на партнёрство → "давайте я назначу зум с сооснователем
// Wave Match". GPT-промпт уже учит этому через Принцип #16, но мы дополнительно
// ловим явные сигналы регексом и отправляем урgentный DM Роману чтобы он мог
// прыгнуть в диалог лично + предлагает Zoom-слот в авто-ответе.

// Unicode word boundary helper for Cyrillic (JS \b is ASCII-only)
const u = (re: string) => new RegExp(`(?:^|\\P{L})(?:${re})`, 'iu');

const PARTNERSHIP_PATTERNS = [
    u('партн[её]рств'),
    u('коллаб'),
    u('сотрудничеств'),
    u('обсудить (?:условия|интеграц|деталь|сотрудн)'),
    u('интегриров'),
    u('тариф'),
    u('прайс|сколько стоит|цена подписк'),
    u('(?:созвон|зум|zoom|звонок|встретить)'),
    u('узнать больше про продукт'),
    u('купить (?:лицензи|доступ|подписк)'),
    u('(?:сооснователь|co.?founder)'),
    u('как работает изнутри'),
    u('предложение для клуб|для нашего клуб|как партн'),
];

export interface PartnershipSignal {
    matched: boolean;
    keyword: string | null;
}

export function detectPartnershipIntent(text: string): PartnershipSignal {
    if (!text) return { matched: false, keyword: null };
    for (const pat of PARTNERSHIP_PATTERNS) {
        const m = text.match(pat);
        if (m) return { matched: true, keyword: m[0] };
    }
    return { matched: false, keyword: null };
}
