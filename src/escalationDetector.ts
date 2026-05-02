// ── Escalation Detector ──────────────────────────────────────────────────
// Roman: "если не знаешь что ответить меня тегай". Если юзер задаёт
// counter-question / просит конкретики / детали / примеры / что-то что
// бот не должен отвечать сам — escalate to founder.
//
// Two layers:
// 1. Regex fast-path (this file) — на типичные «дай конкретики», «уточните»,
//    «расскажи подробнее», «что именно».
// 2. GPT prompt (Принцип #18) — учит модель самой говорить
//    «Минутку, привлекаю основателя» когда не уверена.

const ESCALATION_PATTERNS = [
    /(?:^|\P{L})(?:дай(?:те)?|расскаж(?:и|ите)|опиши(?:те)?)\s*(?:больше\s+)?(?:конкретик|детал|подробн|пример)/iu,
    /(?:^|\P{L})(?:что|как|почему)\s+именно/iu,
    /(?:^|\P{L})(?:уточн(?:и|ите)|поясн(?:и|ите))(?:$|\P{L})/iu,
    /(?:^|\P{L})нужн(?:о|ы)\s+(?:деталь|конкретик|подробн|пример)/iu,
    /(?:^|\P{L})(?:не\s+понимаю|непонятно|не\s+ясно)(?:$|\P{L})/iu,
    /(?:^|\P{L})(?:а\s+что\s+это|что\s+за\s+(?:сервис|платформ|wave\s+match))/iu,
    /больше\s+конкретики/iu,
];

export interface EscalationSignal {
    matched: boolean;
    keyword: string | null;
}

export function detectEscalationIntent(text: string): EscalationSignal {
    if (!text) return { matched: false, keyword: null };
    for (const pat of ESCALATION_PATTERNS) {
        const m = text.match(pat);
        if (m) return { matched: true, keyword: m[0].trim() };
    }
    return { matched: false, keyword: null };
}
