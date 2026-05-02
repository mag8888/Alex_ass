// ── Profile Enricher ──────────────────────────────────────────────────────
// Собирает данные о WM-юзере из публичных источников: TG bio (t.me preview),
// Instagram (если линк в bio), сайт (если линк), плюс WM profile.
// Используется в welcomeBuilder для построения visit card.

import { getUserByTelegramId } from './wmClient';

export interface EnrichedProfile {
    username: string;
    firstName: string | null;
    wmId: string | null;
    wmRole: string | null;
    wmIndustry: string | null;
    wmLocation: string | null;
    wmCompletion: number | null;

    tgBioText: string | null;          // og:description с t.me/<user>
    tgLinks: string[];                  // URL'ы из TG bio
    igHandle: string | null;            // @handle если IG в bio
    igFollowers: number | null;
    igFullName: string | null;
    websites: { url: string; title: string | null; description: string | null }[];

    hasPublicSources: boolean;          // shortcut: можно ли строить карточку
}

const TIMEOUT_MS = 6000;
const UA = 'Mozilla/5.0 (compatible; WaveMatch/1.0)';

async function fetchHtml(url: string): Promise<string | null> {
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': UA },
            redirect: 'follow',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return null;
        return await res.text();
    } catch (_) { return null; }
}

function pickMeta(html: string, prop: string): string | null {
    const re = new RegExp(`<meta\\s+(?:property|name)="${prop}"\\s+content="([^"]+)"`, 'i');
    const m = html.match(re);
    return m ? m[1] : null;
}

function extractUrls(text: string): string[] {
    const re = /https?:\/\/[^\s)<>"']+/g;
    return Array.from(text.matchAll(re)).map(m => m[0].replace(/[.,;!?)]+$/, ''));
}

async function fetchTGBio(username: string): Promise<{ text: string | null; links: string[] }> {
    const html = await fetchHtml(`https://t.me/${username}`);
    if (!html) return { text: null, links: [] };
    const desc = pickMeta(html, 'og:description');
    if (!desc) return { text: null, links: [] };
    return { text: desc, links: extractUrls(desc) };
}

async function fetchIG(handle: string): Promise<{ followers: number | null; fullName: string | null }> {
    const html = await fetchHtml(`https://www.instagram.com/${handle}/`);
    if (!html) return { followers: null, fullName: null };
    const desc = pickMeta(html, 'og:description') || '';
    // "53K Followers, 235 Following, 71 Posts - See Instagram photos and videos from РОМАН (@roman_arctur)"
    const fm = desc.match(/([\d.,]+[KM]?)\s+Followers/i);
    let followers: number | null = null;
    if (fm) {
        const num = fm[1];
        if (num.endsWith('K')) followers = Math.round(parseFloat(num) * 1000);
        else if (num.endsWith('M')) followers = Math.round(parseFloat(num) * 1_000_000);
        else followers = parseInt(num.replace(/[.,]/g, ''));
    }
    const fnm = desc.match(/from\s+([^@]+)\s+\(@/);
    const fullName = fnm ? fnm[1].trim().replace(/&[#a-z0-9]+;/gi, '') : null;
    return { followers, fullName };
}

async function fetchWebsite(url: string): Promise<{ title: string | null; description: string | null }> {
    const html = await fetchHtml(url);
    if (!html) return { title: null, description: null };
    const title = pickMeta(html, 'og:title') || (html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null);
    const description = pickMeta(html, 'og:description') || pickMeta(html, 'description');
    return { title: title?.trim() || null, description: description?.trim() || null };
}

const IG_RE = /(?:instagram\.com|instagr\.am)\/([A-Za-z0-9._]+)/i;

export async function enrichProfile(username: string, telegramId?: string): Promise<EnrichedProfile> {
    const result: EnrichedProfile = {
        username,
        firstName: null,
        wmId: null,
        wmRole: null,
        wmIndustry: null,
        wmLocation: null,
        wmCompletion: null,
        tgBioText: null,
        tgLinks: [],
        igHandle: null,
        igFollowers: null,
        igFullName: null,
        websites: [],
        hasPublicSources: false,
    };

    // 1. WM profile — try telegramId first (правильный ключ для WM API),
    // потом username как fallback. WM-эндпоинт /api/wm/users/tg:<id> ожидает
    // numeric ID; передавать username туда — баг.
    try {
        let wm: any = null;
        if (telegramId) {
            wm = await getUserByTelegramId(telegramId, 'profile');
        }
        if (!wm) {
            wm = await getUserByTelegramId(username, 'profile');
        }
        if (wm) {
            result.firstName = wm.firstName || null;
            result.wmId = wm.id;
            result.wmRole = wm.profile?.role || null;
            result.wmIndustry = wm.profile?.industry || null;
            result.wmLocation = wm.profile?.location || null;
            result.wmCompletion = wm.profile?.completion ?? null;
        }
    } catch (_) { /* skip */ }

    // 2. TG bio
    const tg = await fetchTGBio(username);
    result.tgBioText = tg.text;
    result.tgLinks = tg.links;

    // 3. IG (если есть в TG bio)
    for (const link of tg.links) {
        const m = link.match(IG_RE);
        if (m) {
            const igHandle = m[1].replace(/\/$/, '');
            result.igHandle = igHandle;
            const ig = await fetchIG(igHandle);
            result.igFollowers = ig.followers;
            result.igFullName = ig.fullName;
            break;
        }
    }

    // 4. Websites (всё что не t.me / IG)
    for (const link of tg.links) {
        if (IG_RE.test(link)) continue;
        if (/t\.me\//i.test(link)) continue;
        const site = await fetchWebsite(link);
        if (site.title || site.description) {
            result.websites.push({ url: link, title: site.title, description: site.description });
        }
    }

    result.hasPublicSources = !!(result.igHandle || result.websites.length > 0 || (result.tgBioText && result.tgBioText.length > 20));

    return result;
}
