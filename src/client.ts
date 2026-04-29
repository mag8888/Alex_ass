import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import fs from "fs";
import path from "path";

const API_ID = parseInt(process.env.TELEGRAM_API_ID || "0");
const API_HASH = process.env.TELEGRAM_API_HASH || "";
// Allow overriding via env (Railway volume sometimes mounts at a different path)
const SESSION_DIR = process.env.SESSION_DIR || "session_data";
const SESSION_FILE = path.join(SESSION_DIR, "session.txt");

if (!fs.existsSync(SESSION_DIR)) {
    try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (_) { }
}

let client: TelegramClient;
let currentQR: Buffer | null = null;

export function getQR() {
    return currentQR;
}

function loadSessionString(): string {
    // 1) File on volume — preferred so saved session survives redeploys
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const fromFile = fs.readFileSync(SESSION_FILE, "utf8").trim();
            if (fromFile.length > 10) {
                console.log(`[client] Loaded session from ${SESSION_FILE} (${fromFile.length} chars)`);
                return fromFile;
            }
            console.log(`[client] ${SESSION_FILE} exists but is empty/short — falling back to env`);
        }
    } catch (e: any) {
        console.warn(`[client] Could not read ${SESSION_FILE}:`, e.message);
    }

    // 2) Env variable (set on Railway after first successful QR login)
    const fromEnv = (process.env.TELEGRAM_SESSION || "").trim();
    if (fromEnv.length > 10) {
        console.log(`[client] Loaded session from TELEGRAM_SESSION env (${fromEnv.length} chars)`);
        // Persist to file so subsequent restarts skip the env path
        try { fs.writeFileSync(SESSION_FILE, fromEnv); } catch (_) { }
        return fromEnv;
    }

    console.log(`[client] No session found — QR login required`);
    return "";
}

export async function initClient() {
    console.log("Initializing GramJS Client...");

    if (!API_ID || !API_HASH) {
        console.warn("⚠️  TELEGRAM_API_ID or TELEGRAM_API_HASH is missing. Bot listener will NOT start.");
        return null;
    }

    const sessionString = loadSessionString();
    const stringSession = new StringSession(sessionString);

    client = new TelegramClient(stringSession, API_ID, API_HASH, {
        connectionRetries: 5,
    });

    try {
        console.log("[DEBUG] Connecting to Telegram servers...");
        const connectPromise = client.connect();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timed out')), 15000),
        );
        await Promise.race([connectPromise, timeoutPromise]);
        console.log("[DEBUG] Connected to Telegram servers.");

        // ── Skip QR flow when session is already valid ──────────────────────
        let alreadyAuthed = false;
        try {
            alreadyAuthed = await client.isUserAuthorized();
        } catch (e: any) {
            console.warn("[client] isUserAuthorized check failed:", e.message);
        }

        if (alreadyAuthed) {
            console.log("[client] ✅ Existing session is valid — skipping QR login");
            currentQR = null;
            return client;
        }

        console.log("[client] Session not authorized — starting QR login flow");
        const qrcode = require('qrcode-terminal');

        client.signInUserWithQrCode(
            { apiId: API_ID, apiHash: API_HASH },
            {
                onError: (e) => console.error("[CRITICAL] QR Login Error:", e),
                qrCode: async (code) => {
                    console.log("[DEBUG] QR Code received from Telegram!");
                    currentQR = code.token;
                    try { qrcode.generate(code.token.toString('base64'), { small: true }); } catch (_) { }
                }
            }
        ).then(async () => {
            console.log("[client] ✅ QR login complete — user authenticated");
            currentQR = null;

            const newSession = client.session.save() as unknown as string;
            if (newSession && newSession !== sessionString) {
                try {
                    fs.writeFileSync(SESSION_FILE, newSession);
                    console.log(`[client] Session saved to ${SESSION_FILE}`);
                } catch (e: any) {
                    console.error(`[client] Failed to write ${SESSION_FILE}:`, e.message);
                }
                console.log("\n⚠️  COPY THIS SESSION STRING FOR RAILWAY ENV (TELEGRAM_SESSION):");
                console.log(newSession);
                console.log("---SESSION END---\n");
            }
        }).catch(e => {
            console.error("[CRITICAL] signInUserWithQrCode failed/rejected:", e);
        });

    } catch (e) {
        console.error("Failed to start client:", e);
    }

    return client;
}

export async function reconnectClient() {
    console.log("Reconnecting client...");
    if (client) {
        try { await client.disconnect(); } catch (e) { console.error("Disconnect failed", e); }
    }
    await initClient();
    return true;
}

export function getClient() {
    return client;
}
