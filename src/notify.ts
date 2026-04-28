import { getClient } from './client';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'roman_arctur';

let lastErrorAlert = 0;
const ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between identical alerts

export async function notifyAdmin(text: string, opts: { rateLimitKey?: string; silent?: boolean } = {}) {
    if (!ADMIN_USERNAME) {
        console.warn('[notify] ADMIN_USERNAME not set, skipping notification');
        return;
    }

    if (opts.rateLimitKey) {
        const now = Date.now();
        if (now - lastErrorAlert < ERROR_COOLDOWN_MS) {
            console.log(`[notify] rate-limited: ${text.substring(0, 60)}`);
            return;
        }
        lastErrorAlert = now;
    }

    const client = getClient();
    if (!client || !client.connected) {
        console.warn(`[notify] Telegram client not connected, can't notify admin: ${text.substring(0, 80)}`);
        return;
    }

    try {
        await client.sendMessage(ADMIN_USERNAME, { message: text, silent: opts.silent });
        console.log(`[notify] Sent to @${ADMIN_USERNAME}: ${text.substring(0, 60)}...`);
    } catch (e: any) {
        console.error(`[notify] Failed to deliver to @${ADMIN_USERNAME}:`, e.message);
    }
}

export function getAdminUsername() {
    return ADMIN_USERNAME;
}
