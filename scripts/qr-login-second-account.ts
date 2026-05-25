#!/usr/bin/env tsx
// ── Изолированный QR-login для ВТОРОГО аккаунта (Алекс) ─────────────────────
// НЕ трогает прод-сессию Артура. Создаёт свежий клиент с пустой сессией,
// рендерит QR в PNG (scripts/.qr-alex.png) + печатает tg://login URL.
// На успехе — печатает StringSession для TELEGRAM_SESSION_ALEX.
//
// Запуск: cd /Users/ADMIN/AI_ASS && npx tsx scripts/qr-login-second-account.ts
//
// Скан: на НОВОМ аккаунте → Telegram → Настройки → Устройства →
//       «Подключить устройство» → навести на QR.

import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as fs from 'fs';
import * as path from 'path';

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0');
const API_HASH = process.env.TELEGRAM_API_HASH || '';
const QR_PNG = path.join(__dirname, '.qr-alex.png');
const SESSION_OUT = path.join(__dirname, '.session-alex.txt');

async function main() {
    if (!API_ID || !API_HASH) {
        console.error('❌ TELEGRAM_API_ID / TELEGRAM_API_HASH не заданы в .env');
        process.exit(1);
    }

    const QRCode = require('qrcode');
    // Пустая сессия — это ключевой момент: новый независимый аккаунт.
    const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
        connectionRetries: 5,
    });

    console.log('[qr-alex] Подключаюсь к Telegram...');
    await client.connect();   // обязательно ДО QR-логина — иначе "Cannot send requests while disconnected"
    let qrCount = 0;

    await client.signInUserWithQrCode(
        { apiId: API_ID, apiHash: API_HASH },
        {
            onError: (e: any) => { console.error('[qr-alex] QR error:', e.message); return true; },
            qrCode: async (code: { token: Buffer }) => {
                qrCount++;
                // tg://login?token=BASE64URL
                const b64url = code.token.toString('base64')
                    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                const loginUrl = `tg://login?token=${b64url}`;
                await QRCode.toFile(QR_PNG, loginUrl, { width: 512, margin: 2 });
                console.log(`\n[qr-alex] QR обновлён (#${qrCount}). Откройте и отсканируйте:`);
                console.log(`          PNG: ${QR_PNG}`);
                console.log(`          URL: ${loginUrl}`);
                console.log('[qr-alex] (QR живёт ~30 сек, потом авто-обновляется — скан в любой момент)');
            },
        },
    );

    // Успех
    const session = client.session.save() as unknown as string;
    fs.writeFileSync(SESSION_OUT, session);
    const me: any = await client.getMe();
    console.log('\n✅ [qr-alex] Аутентификация успешна!');
    console.log(`   Аккаунт: ${me?.firstName || ''} ${me?.lastName || ''} @${me?.username || '(нет username)'} id=${me?.id}`);
    console.log(`   Session сохранён в: ${SESSION_OUT}`);
    console.log('\n⚠️  СТРОКА СЕССИИ для Railway env TELEGRAM_SESSION_ALEX:');
    console.log('───────────────────────────────────────────────────────');
    console.log(session);
    console.log('───────────────────────────────────────────────────────');

    await client.disconnect();
    process.exit(0);
}

main().catch(e => { console.error('[qr-alex] FATAL:', e); process.exit(1); });
