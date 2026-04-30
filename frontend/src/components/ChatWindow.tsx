import React, { useState } from 'react';
import type { Dialogue } from '../types';
import { useChat } from '../hooks/useChat';
import ClientCard from './ClientCard';
import { Send, Archive, ShieldAlert, UserCheck, ArrowRightLeft, CreditCard, RefreshCw, Trash2, Edit2, Bot, Sparkles, ArrowLeft, MoreVertical, Eraser, RotateCcw, Check, CheckCheck } from 'lucide-react';

// ─── Quick Templates ────────────────────────────────────────────────────
const QUICK_TEMPLATES = [
    { label: '👋 Привет', text: 'Привет! Увидел ваше сообщение — хотел познакомиться.' },
    { label: '🤝 Нетворкинг', text: 'Мы занимаемся онлайн-нетворкингом и можем ежедневно связывать вас с нужными людьми.' },
    { label: '🎯 Оффер', text: 'Наш сервис даёт 5–10 тёплых интро ежедневно. Было бы интересно попробовать?' },
    { label: '📅 Встреча', text: 'Можем созвониться на 15 минут — удобно на этой неделе?' },
    { label: '✅ ОК', text: 'Отлично, договорились! Напишу вам до конца дня.' },
];

interface DraftMessageProps {
    message: any;
    dialogueId: number;
    onSend: (id: number, text: string) => void;
    onRegenerate: (id: number) => void;
    onDelete: (id: number) => void;
    onRecordOverride?: (dialogueId: number, operatorMessage: string, replacedDraft: string) => Promise<any>;
}

const DraftMessage: React.FC<DraftMessageProps> = ({ message, dialogueId, onSend, onRegenerate, onDelete, onRecordOverride }) => {
    const [text, setText] = useState(message.text);
    const [savedAsPattern, setSavedAsPattern] = useState(false);

    const handleSend = async () => {
        // If operator edited the text, capture it as a learned pattern before sending
        if (onRecordOverride && text.trim() !== (message.text || '').trim()) {
            await onRecordOverride(dialogueId, text, message.text || '');
            setSavedAsPattern(true);
        }
        onSend(message.id, text);
    };

    const handleSavePattern = async () => {
        if (!onRecordOverride) return;
        await onRecordOverride(dialogueId, text, message.text || '');
        setSavedAsPattern(true);
    };

    return (
        <div className="flex justify-end w-full">
            <div className="max-w-[85%] w-full rounded-lg p-4 text-sm shadow-md border-2 border-dashed border-indigo-300 bg-indigo-50/80 dark:bg-indigo-950/20">
                <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-indigo-500 uppercase tracking-wider flex items-center gap-1">
                        <Edit2 className="w-3 h-3" /> Draft Proposal
                    </span>
                    <div className="flex gap-1">
                        <button onClick={() => onRegenerate(message.id)} className="p-1 hover:bg-indigo-200 rounded text-indigo-600" title="Regenerate">
                            <RefreshCw className="w-3 h-3" />
                        </button>
                        <button onClick={() => onDelete(message.id)} className="p-1 hover:bg-red-200 rounded text-red-600" title="Discard">
                            <Trash2 className="w-3 h-3" />
                        </button>
                    </div>
                </div>

                <textarea
                    className="w-full bg-background/50 border border-border rounded p-2 text-sm min-h-[80px] focus:outline-none focus:ring-1 focus:ring-indigo-500 mb-2 resize-none"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                />

                <div className="flex justify-between items-center gap-2 flex-wrap">
                    <div className="text-[10px] text-muted-foreground">
                        AI Generated • Not sent
                        {savedAsPattern && <span className="ml-2 text-emerald-600">🧠 saved as pattern</span>}
                    </div>
                    <div className="flex gap-2">
                        {onRecordOverride && !savedAsPattern && text.trim() !== (message.text || '').trim() && (
                            <button
                                onClick={handleSavePattern}
                                className="bg-emerald-100 text-emerald-700 px-2 py-1.5 rounded-md text-xs hover:bg-emerald-200"
                                title="Сохранить как обучающий паттерн (бот будет использовать в похожих диалогах)"
                            >
                                🧠 Save pattern
                            </button>
                        )}
                        <button
                            onClick={handleSend}
                            className="bg-indigo-600 text-white px-3 py-1.5 rounded-md text-xs font-semibold hover:bg-indigo-700 flex items-center gap-1 transition-colors"
                        >
                            <Send className="w-3 h-3" /> Send Now
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

interface ChatWindowProps {
    dialogue: Dialogue | null;
    actions: ReturnType<typeof useChat>;
}

const ChatWindow: React.FC<ChatWindowProps> = ({ dialogue, actions }) => {
    const [input, setInput] = useState('');
    const [showClientCard, setShowClientCard] = useState(false);
    const [showActionsMenu, setShowActionsMenu] = useState(false);
    const messagesEndRef = React.useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    React.useEffect(() => {
        scrollToBottom();
    }, [dialogue?.messages]);

    if (!dialogue) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
                <div className="text-4xl mb-4">💬</div>
                <p>Select a chat to start messaging</p>
            </div>
        );
    }

    const handleSend = async () => {
        if (!input.trim()) return;
        await actions.sendMessage(dialogue.id, input);
        setInput('');
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const isRejected = dialogue.user.status === 'REJECTED';
    const isScout = dialogue.source === 'SCOUT';
    const autoOn = !!dialogue.user.autoReply;

    const closeChat = () => actions.selectChat(0); // selectChat(0) clears (no dialogue with id 0)

    return (
        <div className="flex flex-col h-full bg-background/50">
            {/* Header */}
            <div className="px-3 py-2 md:p-4 border-b border-border bg-card/50 backdrop-blur flex justify-between items-center gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    {/* Back button — only visible on mobile */}
                    <button
                        onClick={closeChat}
                        className="md:hidden p-2 -ml-1 rounded-md hover:bg-muted shrink-0"
                        title="Back"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <button onClick={() => setShowClientCard(true)} className="text-left min-w-0 flex-1">
                        <h2 className="font-semibold text-base md:text-lg flex items-center gap-1 md:gap-2 truncate">
                            <span className="truncate">{dialogue.user.firstName} {dialogue.user.lastName}</span>
                            {dialogue.user.username && <span className="hidden md:inline text-sm text-muted-foreground shrink-0">@{dialogue.user.username}</span>}
                            {isRejected && <span className="text-[10px] bg-red-500/10 text-red-500 px-1.5 py-0.5 rounded shrink-0">Rejected</span>}
                        </h2>
                        <div className="flex items-center gap-2 text-[10px] md:text-xs text-muted-foreground">
                            {dialogue.user.username && <span className="md:hidden">@{dialogue.user.username}</span>}
                            <span className="hidden md:inline">ID: {dialogue.user.telegramId}</span>
                            <span className="text-primary flex items-center gap-1">
                                <CreditCard className="w-3 h-3" /> Profile
                            </span>
                        </div>
                    </button>
                </div>

                {/* Primary actions (always visible) */}
                <div className="flex gap-1 md:gap-2 shrink-0">
                    <button
                        onClick={() => actions.toggleAutoMode(dialogue.userId, !autoOn)}
                        className={`text-xs px-2 md:px-3 py-1.5 rounded-md flex items-center gap-1 font-medium ${autoOn
                            ? 'bg-indigo-500 text-white hover:bg-indigo-600'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}
                        title={autoOn ? 'AI отвечает сам' : 'AI создаёт черновики'}
                    >
                        <Bot className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Auto</span> {autoOn ? 'ON' : 'OFF'}
                    </button>
                    <button
                        onClick={() => actions.startOnboarding(dialogue.id)}
                        className="text-xs px-2 md:px-3 py-1.5 rounded-md bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 flex items-center gap-1 font-medium"
                        title="Запустить онбординг"
                    >
                        <Sparkles className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Onboarding</span>
                    </button>

                    {/* Secondary actions in dropdown */}
                    <div className="relative">
                        <button
                            onClick={() => setShowActionsMenu(v => !v)}
                            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground"
                            title="More actions"
                        >
                            <MoreVertical className="w-4 h-4" />
                        </button>
                        {showActionsMenu && (
                            <>
                                <div className="fixed inset-0 z-30" onClick={() => setShowActionsMenu(false)} />
                                <div className="absolute right-0 top-full mt-1 z-40 bg-card border border-border rounded-md shadow-lg w-44 py-1">
                                    {!isScout ? (
                                        <button
                                            onClick={() => { actions.updateDialogueSource(dialogue.id, 'SCOUT'); setShowActionsMenu(false); }}
                                            className="w-full px-3 py-2 text-left text-xs hover:bg-muted flex items-center gap-2"
                                        >
                                            <ArrowRightLeft className="w-3.5 h-3.5" /> Move to Scout
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => { actions.updateDialogueSource(dialogue.id, 'INBOUND'); setShowActionsMenu(false); }}
                                            className="w-full px-3 py-2 text-left text-xs hover:bg-muted flex items-center gap-2"
                                        >
                                            <ArrowRightLeft className="w-3.5 h-3.5" /> Move to Direct
                                        </button>
                                    )}
                                    {dialogue.user.status !== 'REJECTED' ? (
                                        <button
                                            onClick={() => { actions.updateUserStatus(dialogue.userId, 'REJECTED'); setShowActionsMenu(false); }}
                                            className="w-full px-3 py-2 text-left text-xs hover:bg-red-500/10 text-red-500 flex items-center gap-2"
                                        >
                                            <ShieldAlert className="w-3.5 h-3.5" /> Reject
                                        </button>
                                    ) : (
                                        <button
                                            onClick={() => { actions.updateUserStatus(dialogue.userId, 'LEAD'); setShowActionsMenu(false); }}
                                            className="w-full px-3 py-2 text-left text-xs hover:bg-muted flex items-center gap-2"
                                        >
                                            <UserCheck className="w-3.5 h-3.5" /> Un-Reject
                                        </button>
                                    )}
                                    <button
                                        onClick={() => { actions.toggleArchive(dialogue.id); setShowActionsMenu(false); }}
                                        className="w-full px-3 py-2 text-left text-xs hover:bg-muted flex items-center gap-2"
                                    >
                                        <Archive className="w-3.5 h-3.5" /> Archive
                                    </button>
                                    <div className="border-t border-border my-1" />
                                    <button
                                        onClick={() => { actions.cleanupDrafts(dialogue.id); setShowActionsMenu(false); }}
                                        className="w-full px-3 py-2 text-left text-xs hover:bg-muted flex items-center gap-2"
                                    >
                                        <Eraser className="w-3.5 h-3.5" /> Очистить черновики
                                    </button>
                                    <button
                                        onClick={() => { actions.resetDialogue(dialogue.id); setShowActionsMenu(false); }}
                                        className="w-full px-3 py-2 text-left text-xs hover:bg-red-500/10 text-red-500 flex items-center gap-2"
                                    >
                                        <RotateCcw className="w-3.5 h-3.5" /> Сбросить диалог
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 flex flex-col">
                <div className="flex-1" /> {/* Spacer to push messages down if few */}
                {dialogue.messages && dialogue.messages.map((msg) => {
                    if (msg.status === 'DRAFT') {
                        return (
                            <DraftMessage
                                key={msg.id}
                                message={msg}
                                dialogueId={dialogue.id}
                                onSend={actions.confirmDraft}
                                onRegenerate={async (id) => {
                                    await actions.deleteMessage(id);
                                    actions.regenerateResponse(dialogue.id);
                                }}
                                onDelete={actions.deleteMessage}
                                onRecordOverride={actions.recordOverride}
                            />
                        );
                    }
                    const isVoiceTranscript = msg.text.startsWith('🎙️');
                    const isOutbound = msg.sender !== 'USER';
                    const isRead = !!msg.readAt;
                    return (
                        <div key={msg.id} className={`flex ${msg.sender === 'USER' ? 'justify-start' : 'justify-end'}`}>
                            <div className={`max-w-[80%] md:max-w-[70%] rounded-lg p-3 text-sm shadow-sm ${msg.sender === 'USER'
                                ? isVoiceTranscript ? 'bg-amber-500/10 text-foreground border border-amber-500/30' : 'bg-muted text-foreground'
                                : 'bg-primary text-primary-foreground'
                                }`}>
                                {isVoiceTranscript && (
                                    <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1">
                                        Голосовое (расшифровано)
                                    </div>
                                )}
                                <div className="whitespace-pre-wrap break-words">{isVoiceTranscript ? msg.text.replace(/^🎙️\s*/, '') : msg.text}</div>
                                <div className="text-[10px] opacity-70 text-right mt-1 flex items-center justify-end gap-1">
                                    <span>{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                    {isOutbound && msg.status === 'SENT' && (
                                        isRead
                                            ? <CheckCheck className="w-3.5 h-3.5 opacity-100" aria-label="Прочитано" />
                                            : <Check className="w-3.5 h-3.5 opacity-80" aria-label="Отправлено" />
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
                {(!dialogue.messages || dialogue.messages.length === 0) && (
                    <div className="text-center text-muted-foreground text-sm my-10">No messages yet.</div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-3 md:p-4 border-t border-border bg-card safe-bottom">
                {/* AI Tools Toolbar */}
                <div className="flex gap-2 mb-2 overflow-x-auto pb-1 flex-nowrap">
                    <button
                        onClick={() => actions.regenerateResponse(dialogue.id)}
                        className="text-xs bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20 px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors whitespace-nowrap"
                        title="Force AI to generate a reply"
                    >
                        ✨ Generate Reply
                    </button>
                    <button
                        onClick={() => {
                            const instructions = prompt("Custom instructions for AI:");
                            if (instructions) actions.regenerateResponse(dialogue.id, instructions);
                        }}
                        className="text-xs bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20 px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors whitespace-nowrap"
                        title="Generate with instructions"
                    >
                        🪄 Generate with Hint...
                    </button>

                    {/* ─── Quick Template Buttons ─── */}
                    <div className="w-px bg-border mx-1 self-stretch" />
                    {QUICK_TEMPLATES.map((t) => (
                        <button
                            key={t.label}
                            onClick={() => setInput(prev => prev ? `${prev} ${t.text}` : t.text)}
                            className="text-xs bg-muted hover:bg-muted/80 text-foreground px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors whitespace-nowrap border border-border/50"
                            title={t.text}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>

                <div className="flex gap-2">
                    <input
                        className="flex-1 bg-muted rounded-md px-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                        placeholder="Type a message..."
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!input.trim()}
                        className="bg-primary text-primary-foreground px-4 py-2 rounded-md font-medium text-sm disabled:opacity-50 hover:bg-primary/90 transition-colors flex items-center gap-2"
                    >
                        <Send className="w-4 h-4" /> Send
                    </button>
                </div>
            </div>
            {showClientCard && dialogue && (
                <ClientCard user={dialogue.user} onClose={() => setShowClientCard(false)} />
            )}
        </div>
    );
};

export default ChatWindow;

