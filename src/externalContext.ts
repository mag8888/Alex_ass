// ── External Context Fetcher (Principle #12) ───────────────────────────────
// When a user shares a Telegram channel link / username / external URL — the
// bot should fetch and read it before replying, then propose collaboration
// based on what it learned (not ask the user to repeat themselves).
//
// Pure HTTP (no headless browser) — covers most Telegram public pages and
// simple websites. For paywalled / heavy-JS sites we just grab title + meta.

interface ExtractedContext {
    source: string;     // URL or @handle that was processed
    title: string | null;
    description: string | null;
    snippets: string[]; // additional text fragments (max 5)
}

const TIMEOUT_MS = 6000;
const MAX_PER_MESSAGE = 3;
const MAX_SNIPPETS = 5;

// ── URL/handle extraction ───────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s)<>"']+/g;
const TME_HANDLE_RE = /(?:^|\s)t\.me\/([A-Za-z0-9_]{4,32})(?:\/(\d+))?/g;
const AT_HANDLE_RE = /(?:^|[\s(])@([A-Za-z][A-Za-z0-9_]{3,31})(?=\b)/g;

export interface DetectedRef {
    kind: 'url' | 'tme' | 'at';
    raw: string;        // original token
    target: string;     // resolved URL to fetch (always https://...)
    handle?: string;    // for tme/at — extracted username
    postId?: string;    // for tme — message id if present
}

export function extractRefs(text: string): DetectedRef[] {
    if (!text) return [];
    const out: DetectedRef[] = [];
    const seen = new Set<string>();

    const push = (r: DetectedRef) => {
        if (seen.has(r.target)) return;
        seen.add(r.target);
        out.push(r);
    };

    for (const m of text.matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;!?)]+$/, '');
        // t.me URLs go through tme branch
        const tmeMatch = url.match(/t\.me\/([A-Za-z0-9_]{4,32})(?:\/(\d+))?/);
        if (tmeMatch) {
            push({ kind: 'tme', raw: url, target: url.startsWith('http') ? url : `https://${url}`, handle: tmeMatch[1], postId: tmeMatch[2] });
        } else {
            push({ kind: 'url', raw: url, target: url });
        }
    }

    for (const m of text.matchAll(TME_HANDLE_RE)) {
        const handle = m[1];
        const postId = m[2];
        const target = postId ? `https://t.me/${handle}/${postId}` : `https://t.me/${handle}`;
        push({ kind: 'tme', raw: m[0].trim(), target, handle, postId });
    }

    for (const m of text.matchAll(AT_HANDLE_RE)) {
        const handle = m[1];
        // ignore very common words and our own bot
        if (['admin', 'all', 'channel', 'mag_88888888', 'roman_arctur'].includes(handle.toLowerCase())) continue;
        push({ kind: 'at', raw: '@' + handle, target: `https://t.me/${handle}`, handle });
    }

    return out.slice(0, MAX_PER_MESSAGE);
}

// ── Fetcher ────────────────────────────────────────────────────────────────

function stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

async function fetchRef(ref: DetectedRef): Promise<ExtractedContext | null> {
    try {
        const url = ref.kind === 'tme' ? ref.target + (ref.target.includes('?') ? '&' : '?') + 'embed=1' : ref.target;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: 'follow',
        });
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('text/html') && !ct.includes('text/plain')) return null;
        const html = await res.text();

        // Standard meta tags first (work on most sites incl. Telegram)
        const title = (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1]
            || (html.match(/<title>([^<]+)<\/title>/i) || [])[1]
            || null;
        const description = (html.match(/<meta property="og:description" content="([^"]+)"/) || [])[1]
            || (html.match(/<meta name="description" content="([^"]+)"/) || [])[1]
            || null;

        // Telegram-specific extra: page_description (channel bio) + post text
        const tgPageDesc = (html.match(/<div class="tgme_page_description[^"]*">([\s\S]*?)<\/div>/) || [])[1];
        const tgPostText = (html.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];

        const snippets: string[] = [];
        if (tgPageDesc) snippets.push(stripTags(tgPageDesc).slice(0, 600));
        if (tgPostText) snippets.push(stripTags(tgPostText).slice(0, 1500));

        if (snippets.length < MAX_SNIPPETS && !ref.kind.includes('tme')) {
            // For non-Telegram URLs grab first <p> as fallback
            const para = (html.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1];
            if (para) snippets.push(stripTags(para).slice(0, 800));
        }

        return {
            source: ref.target,
            title: title ? stripTags(title).slice(0, 200) : null,
            description: description ? stripTags(description).slice(0, 600) : null,
            snippets: snippets.slice(0, MAX_SNIPPETS),
        };
    } catch (e: any) {
        console.warn(`[external-fetch] ${ref.target} → ${e.message}`);
        return null;
    }
}

// Public entrypoint: detect refs in user message + fetch in parallel
export async function fetchExternalContext(text: string): Promise<ExtractedContext[]> {
    const refs = extractRefs(text);
    if (refs.length === 0) return [];
    const results = await Promise.all(refs.map(fetchRef));
    return results.filter((r): r is ExtractedContext => !!r && (!!r.title || !!r.description || r.snippets.length > 0));
}

// Render extracted context as a system-prompt fragment for GPT
export function formatForPrompt(items: ExtractedContext[]): string {
    if (items.length === 0) return '';
    const lines: string[] = [];
    lines.push('=== EXTERNAL CONTEXT (auto-fetched from links/handles in user message) ===');
    lines.push('Принцип #12: используй эту информацию в ответе. НЕ заставляй юзера повторять что у него на канале/в bio. Покажи что изучил, и предложи конкретное сотрудничество.');
    for (const it of items) {
        lines.push('');
        lines.push(`SOURCE: ${it.source}`);
        if (it.title) lines.push(`TITLE: ${it.title}`);
        if (it.description) lines.push(`DESCRIPTION: ${it.description}`);
        if (it.snippets.length > 0) {
            lines.push('SNIPPETS:');
            for (const s of it.snippets) lines.push(`  - ${s}`);
        }
    }
    return lines.join('\n');
}

// ── Consumable content detection ───────────────────────────────────────────
// Roman 2026-05-14: «человек не может за 1 минуту посмотреть зум и дать ОС.
// Через час если человек что-то даёт (сайт/видео/ссылку) → пиши что
// ознакомился и сделал выводы через час».
//
// Если USER прислал ссылку на контент, который реально требует времени для
// потребления (Zoom-встреча, видео, длинная статья, PDF) — бот должен:
//   1. Отправить короткое ACK ("Спасибо, гляну, отпишусь")
//   2. Подождать 45-90 минут (имитация настоящего ознакомления)
//   3. Только потом отправить substantive reply с выводами
//
// Это закрывает основной паттерн «бот за минуту посмотрел Zoom» = палево.

export type ConsumableKind = 'zoom' | 'video' | 'youtube' | 'article' | 'pdf';

export interface ConsumableContent {
    kind: ConsumableKind;
    delayMs: number;          // отложка перед substantive reply
    ackTemplate: string;      // короткое подтверждение от живого человека
}

const ACK_VARIANTS: Record<ConsumableKind, string[]> = {
    zoom: [
        'Спасибо! Гляну запись и отпишусь, как разберусь.',
        'Принял, посмотрю и вернусь с мыслями.',
        'Понял, гляну и напишу свои выводы.',
    ],
    video: [
        'Спасибо за видео! Посмотрю и вернусь с фидбэком.',
        'Принял, гляну и отпишусь.',
    ],
    youtube: [
        'Спасибо за ссылку! Посмотрю и отпишусь.',
        'Принял, гляну ролик и вернусь.',
    ],
    article: [
        'Спасибо, прочитаю и отпишусь.',
        'Принял, гляну материал и вернусь с мыслями.',
    ],
    pdf: [
        'Спасибо за документ! Прочитаю и вернусь.',
        'Принял PDF, изучу и отпишусь.',
    ],
};

function pickAck(kind: ConsumableKind): string {
    const v = ACK_VARIANTS[kind];
    return v[Math.floor(Math.random() * v.length)];
}

export function detectConsumableContent(text: string): ConsumableContent | null {
    if (!text) return null;

    // Zoom (meeting / recording) — самый частый кейс per Roman feedback
    if (/zoom\.us\/(j|rec|meeting|webinar)\//i.test(text) || /us\d+web\.zoom\.us/i.test(text)) {
        return {
            kind: 'zoom',
            // 60-90 мин (реалистичная длительность Zoom + время разобрать)
            delayMs: 60 * 60_000 + Math.floor(Math.random() * 30 * 60_000),
            ackTemplate: pickAck('zoom'),
        };
    }

    // YouTube / Vimeo / Rutube
    if (/(youtube\.com\/(watch|live|shorts)|youtu\.be\/|vimeo\.com\/\d|rutube\.ru\/video)/i.test(text)) {
        return {
            kind: 'youtube',
            // 30-60 мин (типичный ролик)
            delayMs: 30 * 60_000 + Math.floor(Math.random() * 30 * 60_000),
            ackTemplate: pickAck('youtube'),
        };
    }

    // Прямые ссылки на видео-файлы / стриминг
    if (/\.(mp4|mov|webm|m3u8)(\?|$)/i.test(text)) {
        return {
            kind: 'video',
            delayMs: 30 * 60_000 + Math.floor(Math.random() * 30 * 60_000),
            ackTemplate: pickAck('video'),
        };
    }

    // PDF документы
    if (/\.pdf(\?|$)/i.test(text)) {
        return {
            kind: 'pdf',
            // 30-60 мин (чтение документа)
            delayMs: 30 * 60_000 + Math.floor(Math.random() * 30 * 60_000),
            ackTemplate: pickAck('pdf'),
        };
    }

    // Длинные статьи / медиа
    if (/(medium\.com\/|substack\.com\/|habr\.com\/|vc\.ru\/|forbes\.|techcrunch\.|bloomberg\.|nytimes\.|economist\.|harvard\.edu|hbr\.org)/i.test(text)) {
        return {
            kind: 'article',
            delayMs: 25 * 60_000 + Math.floor(Math.random() * 25 * 60_000),
            ackTemplate: pickAck('article'),
        };
    }

    return null;
}
