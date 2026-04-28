import type { FastifyRequest, FastifyReply } from 'fastify';

export type AppEvent =
    | { type: 'message:new'; dialogueId: number; userId: number; sender: string; text: string }
    | { type: 'message:draft'; dialogueId: number; userId: number; text: string }
    | { type: 'message:sent'; dialogueId: number; userId: number; text: string }
    | { type: 'user:status'; userId: number; status: string }
    | { type: 'dialogue:updated'; dialogueId: number };

type Subscriber = (event: AppEvent) => void;
const subscribers = new Set<Subscriber>();

export function emitEvent(event: AppEvent) {
    for (const sub of subscribers) {
        try {
            sub(event);
        } catch (e) {
            console.error('[events] subscriber error:', e);
        }
    }
}

export async function sseHandler(req: FastifyRequest, reply: FastifyReply) {
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    reply.raw.write(`: connected\n\n`);

    const sub: Subscriber = (event) => {
        try {
            reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        } catch (e) {
            // client gone
        }
    };
    subscribers.add(sub);

    const heartbeat = setInterval(() => {
        try { reply.raw.write(`: ping\n\n`); } catch (_) { }
    }, 25_000);

    req.raw.on('close', () => {
        clearInterval(heartbeat);
        subscribers.delete(sub);
    });
}
