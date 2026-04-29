import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Voice transcription via OpenAI Whisper ──────────────────────────────────
// Telegram voice messages are .ogg/.opus — Whisper handles them natively.
// Cost: ~$0.006 / minute. Average TG voice ≈ 30 sec → ~$0.003 per message.

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
    if (_openai) return _openai;
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    _openai = new OpenAI({ apiKey: key });
    return _openai;
}

export interface TranscriptionResult {
    text: string;
    durationMs: number;
}

export async function transcribeVoice(buffer: Buffer, hint?: string): Promise<TranscriptionResult | null> {
    const client = getOpenAI();
    if (!client) {
        console.error('[voice] OPENAI_API_KEY missing — cannot transcribe');
        return null;
    }

    const start = Date.now();
    // Whisper requires a real file, not a buffer
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `tg-voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.ogg`);
    fs.writeFileSync(tmpFile, buffer);

    try {
        const resp = await client.audio.transcriptions.create({
            file: fs.createReadStream(tmpFile),
            model: 'whisper-1',
            language: 'ru',
            // hint = previous user messages so model picks up names/jargon
            prompt: hint?.substring(0, 200),
            // Plain text response is cheapest & enough for our use case
            response_format: 'text',
        });

        // SDK quirk: when response_format='text', resp is just a string
        const text = (typeof resp === 'string' ? resp : (resp as any).text || '').trim();
        const durationMs = Date.now() - start;
        if (!text) return null;
        return { text, durationMs };
    } catch (e: any) {
        console.error('[voice] Transcription failed:', e.message);
        return null;
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) { }
    }
}

// Detect whether a Telegram message is a voice note
// (gramjs Message structure: message.media → MessageMediaDocument with DocumentAttributeAudio.voice)
export function isVoiceMessage(message: any): boolean {
    const media = message?.media;
    if (!media) return false;
    if (media.className !== 'MessageMediaDocument') return false;
    const attrs = media.document?.attributes || [];
    return attrs.some((a: any) => a.className === 'DocumentAttributeAudio' && a.voice === true);
}
