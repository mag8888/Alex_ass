// ── Декод QR из фото (Telegram-контакт QR) ─────────────────────────────────
// Roman 2026-05-26: присылает QR-контакты клиентов боту. Декодим → достаём
// @username / tg id. jpeg-js (декод JPEG → RGBA) + jsqr (чтение QR).
// Стилизованные Telegram-QR обычно читаются (высокая коррекция ошибок), но
// не 100% — если не вышло, fallback на username текстом.

import jpeg from 'jpeg-js';
import jsQR from 'jsqr';

/** Декод QR из JPEG-буфера. Возвращает содержимое QR или null. */
export function decodeQrFromJpeg(buf: Buffer): string | null {
    try {
        const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
        if (!img?.data || !img.width || !img.height) return null;
        const res = jsQR(new Uint8ClampedArray(img.data.buffer), img.width, img.height);
        return res?.data || null;
    } catch (e: any) {
        console.warn('[qr] decode err:', e?.message);
        return null;
    }
}

/** Из содержимого QR достаём Telegram @username или числовой id. */
export function extractTgContact(qr: string): { username?: string; userId?: string } | null {
    if (!qr) return null;
    // https://t.me/username  |  t.me/username  |  tg://resolve?domain=username
    let m = qr.match(/(?:t\.me\/|tg:\/\/resolve\?domain=)([A-Za-z][A-Za-z0-9_]{3,31})/i);
    if (m) return { username: m[1] };
    // tg://user?id=123456
    m = qr.match(/tg:\/\/user\?id=(\d+)/i);
    if (m) return { userId: m[1] };
    return null;
}
