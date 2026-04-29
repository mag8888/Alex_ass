import React, { useState, useEffect, useCallback } from 'react';
import type { Dialogue } from '../types';
import { DialogueSource } from '../types';
import { useEvents } from './useEvents';

export const useChat = () => {
    const [dialogues, setDialogues] = useState<Dialogue[]>([]);
    const [currentDialogue, setCurrentDialogue] = useState<Dialogue | null>(null);
    const [filter, setFilter] = useState<'ALL' | DialogueSource>('ALL');
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(false);
    const [showRejected, setShowRejected] = useState(false);
    const [newDialogueIds, setNewDialogueIds] = useState<Set<number>>(new Set());
    const seenIds = React.useRef<Set<number>>(new Set());


    // Fetch Dialogues
    const loadDialogues = useCallback(async (isBackground = false) => {
        try {
            if (!isBackground) setLoading(true);
            const res = await fetch('/dialogues');
            if (!res.ok) throw new Error('Failed to fetch dialogues');
            const data: Dialogue[] = await res.json();
            setDialogues(data);

            // Detect new dialogues that weren't seen before
            if (isBackground && seenIds.current.size > 0) {
                const incoming = new Set(data.map(d => d.id));
                const fresh: number[] = [];
                incoming.forEach(id => { if (!seenIds.current.has(id)) fresh.push(id); });
                if (fresh.length > 0) {
                    setNewDialogueIds(prev => new Set([...prev, ...fresh]));
                }
            }
            // Update seen ids
            data.forEach(d => seenIds.current.add(d.id));
        } catch (err) {
            console.error(err);
        } finally {
            if (!isBackground) setLoading(false);
        }
    }, []);


    // Initial Load + low-frequency safety poll (60s) — SSE handles immediate updates
    useEffect(() => {
        loadDialogues(false);
        const interval = setInterval(() => loadDialogues(true), 60000);
        return () => clearInterval(interval);
    }, [loadDialogues]);

    // Refetch active chat helper
    const refetchActive = useCallback(async (dialogueId: number) => {
        try {
            const res = await fetch(`/dialogues/${dialogueId}`);
            if (res.ok) {
                const full: Dialogue = await res.json();
                setCurrentDialogue(prev => (prev?.id === full.id ? full : prev));
            }
        } catch (e) { console.error(e); }
    }, []);

    // Real-time updates via SSE
    useEvents((event) => {
        if (event.type === 'dialogue:updated' || event.type === 'message:new' ||
            event.type === 'message:draft' || event.type === 'message:sent') {
            // Refresh sidebar list
            loadDialogues(true);
            // Refresh open chat if it matches
            if ('dialogueId' in event && currentDialogue?.id === event.dialogueId) {
                refetchActive(event.dialogueId);
            }
        }
        if (event.type === 'user:status') {
            loadDialogues(true);
        }
    });

    // Derived State: Filtered List
    const filteredDialogues = dialogues.filter(d => {
        // 1. Rejected Filter
        if (!showRejected && d.user.status === 'REJECTED') return false;

        // 2. Tab Filter
        if (filter !== 'ALL') {
            const isScout = d.source === 'SCOUT' || (d.user.sourceChatId !== null);
            if (filter === 'SCOUT' && !isScout) return false;
            if (filter === 'INBOUND' && isScout) return false;
        }

        // 3. Search Filter
        if (search) {
            const term = search.toLowerCase();
            const fn = (d.user.firstName || '').toLowerCase();
            const ln = (d.user.lastName || '').toLowerCase();
            const un = (d.user.username || '').toLowerCase();
            return fn.includes(term) || ln.includes(term) || un.includes(term);
        }
        return true;
    });

    const clearCurrentChat = () => setCurrentDialogue(null);

    const selectChat = async (id: number) => {
        if (id === 0) { clearCurrentChat(); return; }
        console.log('[DEBUG] selectChat called for ID:', id);
        // Clear new-dialogue highlight when user opens it
        setNewDialogueIds(prev => { const next = new Set(prev); next.delete(id); return next; });

        // 1. Optimistic update (show partial data immediately)
        const partial = dialogues.find(d => d.id === id);
        if (partial) {
            console.log('[DEBUG] Found partial dialogue:', partial.id);
            setCurrentDialogue(partial);
        }

        try {
            setLoading(true);
            const res = await fetch(`/dialogues/${id}`);
            if (!res.ok) throw new Error('Failed to fetch chat details');
            const fullDialogue: Dialogue = await res.json();
            console.log('[DEBUG] Fetched full dialogue:', fullDialogue.id, fullDialogue.messages?.length, 'messages');
            setCurrentDialogue(fullDialogue);
        } catch (e) {
            console.error('[DEBUG] selectChat error:', e);
        } finally {
            setLoading(false);
        }
    };

    const syncChats = async () => {
        try {
            setLoading(true);
            await fetch('/sync-chats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ limit: 100 })
            });
            await loadDialogues();
        } catch (e) {
            alert('Sync failed');
        } finally {
            setLoading(false);
        }
    };

    const sendMessage = async (dialogueId: number, text: string) => {
        try {
            await fetch('/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dialogueId, message: text })
            });
            await selectChat(dialogueId);
            loadDialogues(true); // Refresh list to update sort order
        } catch (e) {
            console.error(e);
            alert('Failed to send message');
        }
    };

    const updateUserStatus = async (userId: number, status: string) => {
        try {
            await fetch(`/users/${userId}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status })
            });
            await loadDialogues();
        } catch (e) {
            console.error(e);
        }
    };

    const updateDialogueSource = async (dialogueId: number, source: string) => {
        try {
            await fetch(`/dialogues/${dialogueId}/source`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source })
            });
            await loadDialogues();
            if (currentDialogue?.id === dialogueId) await selectChat(dialogueId);
        } catch (e) {
            console.error(e);
        }
    };

    const toggleArchive = async (dialogueId: number) => {
        try {
            await fetch(`/dialogues/${dialogueId}/archive`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            await loadDialogues();
            if (currentDialogue?.id === dialogueId) setCurrentDialogue(null);
        } catch (e) {
            console.error(e);
        }
    };

    const regenerateResponse = async (dialogueId: number, instructions?: string) => {
        console.log(`[Frontend] regenerateResponse called for Dialogue ${dialogueId}`);
        try {
            setLoading(true);
            const res = await fetch(`/dialogues/${dialogueId}/regenerate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instructions })
            });
            if (!res.ok) {
                const err = await res.json();
                console.error('[Frontend] Regeneration failed:', err);
                throw new Error(err.error || 'Failed');
            }
            await selectChat(dialogueId);
            loadDialogues(true); // Refresh list
        } catch (e) {
            console.error(e);
            alert('Failed to regenerate response');
        } finally {
            setLoading(false);
        }
    };
    const confirmDraft = async (messageId: number, text: string) => {
        try {
            const res = await fetch(`/messages/${messageId}/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            if (!res.ok) throw new Error('Failed to send draft');
            if (currentDialogue) await selectChat(currentDialogue.id);
            loadDialogues(true);
        } catch (e) {
            console.error(e);
            alert('Failed to send draft');
        }
    };

    const deleteMessage = async (messageId: number) => {
        try {
            await fetch(`/messages/${messageId}`, { method: 'DELETE' });
            if (currentDialogue) await selectChat(currentDialogue.id);
        } catch (e) {
            console.error(e);
        }
    };

    const toggleAutoMode = async (userId: number, enabled: boolean) => {
        try {
            await fetch(`/users/${userId}/auto-mode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            });
            if (currentDialogue) await selectChat(currentDialogue.id);
            await loadDialogues(true);
        } catch (e) {
            console.error(e);
            alert('Failed to toggle auto-mode');
        }
    };

    const cleanupDrafts = async (dialogueId: number) => {
        try {
            await fetch(`/dialogues/${dialogueId}/cleanup-drafts`, { method: 'POST' });
            if (currentDialogue?.id === dialogueId) await selectChat(dialogueId);
        } catch (e) { console.error(e); }
    };

    const resetDialogue = async (dialogueId: number) => {
        if (!confirm('Точно сбросить диалог? Все сообщения будут удалены, статус → NEW. Это нельзя отменить.')) return;
        try {
            await fetch(`/dialogues/${dialogueId}/reset`, { method: 'POST' });
            if (currentDialogue?.id === dialogueId) await selectChat(dialogueId);
            await loadDialogues(true);
        } catch (e) { console.error(e); alert('Failed'); }
    };

    const fullReset = async () => {
        const a = prompt('ВНИМАНИЕ: это полностью сотрёт всех юзеров, диалоги, сообщения, scout. Введите "WIPE" чтобы подтвердить:');
        if (a !== 'WIPE') return;
        try {
            const res = await fetch('/admin/reset-db', { method: 'POST' });
            const data = await res.json();
            alert(data.success ? 'База очищена' : `Ошибка: ${data.error || 'неизвестная'}`);
            setCurrentDialogue(null);
            await loadDialogues();
        } catch (e: any) { alert(e.message); }
    };

    const startOnboarding = async (dialogueId: number) => {
        try {
            setLoading(true);
            const res = await fetch(`/dialogues/${dialogueId}/start-onboarding`, { method: 'POST' });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed');
            }
            await selectChat(dialogueId);
            await loadDialogues(true);
        } catch (e: any) {
            console.error(e);
            alert(`Failed to start onboarding: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    return {
        dialogues: filteredDialogues,
        currentDialogue,
        newDialogueIds,
        selectChat,
        loadDialogues,
        syncChats,
        sendMessage,
        confirmDraft,
        deleteMessage,
        updateUserStatus,
        updateDialogueSource,
        toggleArchive,
        filter,
        setFilter,
        search,
        setSearch,
        loading,
        showRejected,
        setShowRejected,
        regenerateResponse,
        toggleAutoMode,
        startOnboarding,
        cleanupDrafts,
        resetDialogue,
        fullReset,
    };
};
