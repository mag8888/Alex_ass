import { Gender } from '@prisma/client';

// ── Gender detection from Russian first names ────────────────────────────────
// Strategy:
//   1) Hard-coded exception lists (popular names that break suffix rules)
//   2) Suffix heuristic for Cyrillic names
//   3) Latin transliteration fallback (popular romanized RU names)
// Returns Gender.UNKNOWN when uncertain — never guesses 50/50.

const FEMALE_EXACT = new Set([
    'любовь', 'надежда', 'вера', 'нинель', 'ассоль', 'эстер', 'эсфирь',
    'элен', 'мадлен', 'кейт', 'эмили', 'кэрри',
]);

const MALE_EXACT = new Set([
    'никита', 'илья', 'кузьма', 'фома', 'савва', 'лука', 'данила', 'микула',
    'юра', 'миша', 'саша', 'дима', 'женя', 'паша', 'лёша', 'витя', 'коля', 'ваня',
    'игорь', 'олег', 'роман', 'руслан', 'тимофей', 'тимур', 'марк', 'максим',
    'григорий', 'юрий', 'денис', 'степан', 'фёдор', 'федор', 'арсений', 'кирилл',
]);

const FEMALE_SUFFIXES = ['а', 'я', 'ия', 'на', 'ла', 'ра', 'та', 'ка', 'нь'];
const MALE_SUFFIXES = ['ий', 'ей', 'ай', 'ой', 'ев', 'ов', 'ин', 'ан', 'ян', 'ем', 'ом', 'ук', 'юк', 'ёр', 'ор'];

// Quick check: looks like Cyrillic letters
function isCyrillic(s: string): boolean {
    return /[а-яёА-ЯЁ]/.test(s);
}

// Pull first word and lowercase it
function normalize(name?: string | null): string | null {
    if (!name) return null;
    const cleaned = name.trim().split(/\s+/)[0]?.toLowerCase();
    return cleaned && cleaned.length >= 2 ? cleaned : null;
}

export function detectGender(firstName?: string | null): Gender {
    const n = normalize(firstName);
    if (!n) return Gender.UNKNOWN;

    // Exact lists win
    if (MALE_EXACT.has(n)) return Gender.MALE;
    if (FEMALE_EXACT.has(n)) return Gender.FEMALE;

    if (isCyrillic(n)) {
        // Russian suffix rules
        for (const sfx of MALE_SUFFIXES) if (n.endsWith(sfx)) return Gender.MALE;
        for (const sfx of FEMALE_SUFFIXES) if (n.endsWith(sfx)) return Gender.FEMALE;
        // Most consonant-ending Cyrillic names are male
        if (/[бвгджзклмнпрстфхцчшщ]$/.test(n)) return Gender.MALE;
        return Gender.UNKNOWN;
    }

    // Latin transliteration heuristics
    if (/(?:a|ya|ia)$/i.test(n) && !['nikita', 'ilya', 'fomá', 'savva', 'kuzma', 'luka'].includes(n)) {
        return Gender.FEMALE;
    }
    if (/(?:y|i|ey|ay|oy|ev|ov|in|an)$/i.test(n)) return Gender.MALE;

    return Gender.UNKNOWN;
}

// ── Gender-aware text expansion ─────────────────────────────────────────────
// Templates use {m|f|u} blocks: "ты уже {зарегистрирован|зарегистрирована|зарегистрированы}"
// Pattern: {malevariant|femalevariant} or {male|female|unknown}
// If unknown variant missing, falls back to a neutral form ("вы зарегистрированы").

export function applyGender(template: string, gender: Gender): string {
    return template.replace(/\{([^{}]+)\}/g, (full, body: string) => {
        const parts = body.split('|').map(p => p.trim());
        if (parts.length < 2) return full; // not a gender block
        const [m, f, u] = parts;
        if (gender === Gender.MALE) return m ?? full;
        if (gender === Gender.FEMALE) return f ?? full;
        return u ?? m ?? full; // UNKNOWN → use unknown variant; else male as default neutral
    });
}
