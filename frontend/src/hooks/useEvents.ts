import { useEffect, useRef } from 'react';

export type AppEvent =
    | { type: 'message:new'; dialogueId: number; userId: number; sender: string; text: string }
    | { type: 'message:draft'; dialogueId: number; userId: number; text: string }
    | { type: 'message:sent'; dialogueId: number; userId: number; text: string }
    | { type: 'user:status'; userId: number; status: string }
    | { type: 'dialogue:updated'; dialogueId: number };

type Handler = (e: AppEvent) => void;

export function useEvents(handler: Handler) {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        const es = new EventSource('/events');
        const types: AppEvent['type'][] = [
            'message:new', 'message:draft', 'message:sent', 'user:status', 'dialogue:updated',
        ];
        const listeners = types.map(type => {
            const fn = (ev: MessageEvent) => {
                try {
                    const data = JSON.parse(ev.data);
                    handlerRef.current(data);
                } catch (e) { /* ignore */ }
            };
            es.addEventListener(type, fn);
            return { type, fn };
        });

        es.onerror = () => {
            // EventSource auto-reconnects; just log once
            console.warn('[SSE] connection error, browser will retry');
        };

        return () => {
            for (const l of listeners) es.removeEventListener(l.type, l.fn as any);
            es.close();
        };
    }, []);
}
