import React, { useEffect, useState } from 'react';
import { X, Users, Sparkles, Send, Loader2 } from 'lucide-react';

interface MatchUser {
    id: number;
    telegramId: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    city: string | null;
    activity: string | null;
    requests: string | null;
    bestClients: string | null;
}

interface Match {
    user: MatchUser;
    score: number;
    matchedKeywords: string[];
    profileCompleteness: number;
}

interface MatchModalProps {
    sourceUserId: number;
    sourceUserName: string;
    onClose: () => void;
    onConnected?: () => void;
}

const MatchModal: React.FC<MatchModalProps> = ({ sourceUserId, sourceUserName, onClose, onConnected }) => {
    const [matches, setMatches] = useState<Match[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [connecting, setConnecting] = useState<number | null>(null);

    useEffect(() => {
        let mounted = true;
        (async () => {
            try {
                const res = await fetch(`/users/${sourceUserId}/matches?limit=10`);
                const data = await res.json();
                if (mounted) setMatches(data.matches || []);
            } catch (e) {
                console.error(e);
                if (mounted) setMatches([]);
            } finally {
                if (mounted) setLoading(false);
            }
        })();
        return () => { mounted = false; };
    }, [sourceUserId]);

    const handleConnect = async (partnerId: number) => {
        if (!confirm(`Создать черновики интро-сообщений для обоих пользователей?`)) return;
        setConnecting(partnerId);
        try {
            const res = await fetch(`/users/${sourceUserId}/connect/${partnerId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Failed');
            alert('Готово! Черновики добавлены в оба диалога. Открой и нажми "Send Now" чтобы отправить.');
            onConnected?.();
            onClose();
        } catch (e: any) {
            alert(`Ошибка: ${e.message}`);
        } finally {
            setConnecting(null);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
            <div className="bg-card w-full md:max-w-2xl md:rounded-xl shadow-xl border border-border overflow-hidden flex flex-col max-h-[90vh] safe-bottom">
                {/* Header */}
                <div className="bg-muted/50 p-4 flex justify-between items-center border-b border-border shrink-0">
                    <div>
                        <h3 className="font-semibold text-lg flex items-center gap-2">
                            <Users className="w-5 h-5 text-emerald-500" /> Match-кандидаты
                        </h3>
                        <p className="text-xs text-muted-foreground">для {sourceUserName}</p>
                    </div>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-2 -mr-2">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {loading && (
                        <div className="text-center py-12 text-muted-foreground">
                            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
                            Ищу подходящих людей в базе...
                        </div>
                    )}

                    {!loading && matches?.length === 0 && (
                        <div className="text-center py-12 text-muted-foreground text-sm">
                            <Sparkles className="w-10 h-10 mx-auto mb-2 opacity-30" />
                            Подходящих людей пока не нашёл.<br />
                            <span className="text-xs">Нужно больше заполненных профилей или у этого пользователя слабая requests-секция.</span>
                        </div>
                    )}

                    {!loading && matches?.map((m) => (
                        <div key={m.user.id} className="border border-border rounded-lg p-3 hover:border-emerald-500/40 transition-colors">
                            <div className="flex items-start justify-between gap-3 mb-2">
                                <div className="min-w-0 flex-1">
                                    <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
                                        {m.user.firstName} {m.user.lastName}
                                        {m.user.username && <span className="text-xs text-muted-foreground">@{m.user.username}</span>}
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 font-semibold">
                                            score {m.score}
                                        </span>
                                    </div>
                                    {m.user.activity && (
                                        <div className="text-xs text-muted-foreground mt-0.5">{m.user.activity}{m.user.city ? ` • ${m.user.city}` : ''}</div>
                                    )}
                                </div>
                                <button
                                    onClick={() => handleConnect(m.user.id)}
                                    disabled={connecting !== null}
                                    className="bg-emerald-600 text-white px-3 py-1.5 rounded-md text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1 shrink-0"
                                >
                                    {connecting === m.user.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                                    Connect
                                </button>
                            </div>

                            {m.matchedKeywords.length > 0 && (
                                <div className="flex flex-wrap gap-1 mb-2">
                                    {m.matchedKeywords.map((k, i) => (
                                        <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded ${k.startsWith('*')
                                            ? 'bg-purple-500/10 text-purple-500' : 'bg-blue-500/10 text-blue-500'}`}>
                                            {k.replace(/^\*/, '')}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {m.user.requests && (
                                <div className="text-xs text-muted-foreground">
                                    <strong className="opacity-70">Requests:</strong> {m.user.requests.substring(0, 120)}{m.user.requests.length > 120 ? '...' : ''}
                                </div>
                            )}
                            {m.user.bestClients && (
                                <div className="text-xs text-muted-foreground mt-1">
                                    <strong className="opacity-70">Best clients:</strong> {m.user.bestClients.substring(0, 120)}{m.user.bestClients.length > 120 ? '...' : ''}
                                </div>
                            )}

                            <div className="mt-2 h-1 bg-muted rounded overflow-hidden">
                                <div
                                    className="h-full bg-emerald-500/60"
                                    style={{ width: `${Math.round(m.profileCompleteness * 100)}%` }}
                                    title={`Профиль заполнен на ${Math.round(m.profileCompleteness * 100)}%`}
                                />
                            </div>
                        </div>
                    ))}
                </div>

                <div className="p-3 border-t border-border bg-muted/20 text-[10px] text-muted-foreground text-center">
                    🟦 кандидат подходит под мои "requests" • 🟪 я подхожу под его "requests"
                </div>
            </div>
        </div>
    );
};

export default MatchModal;
