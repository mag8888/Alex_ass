import React, { useEffect, useState } from 'react';
import { X, Megaphone, Send, Loader2, Eye, Edit3, BarChart3 } from 'lucide-react';

interface Template {
    id: number;
    name: string;
    content: string;
}

interface PreviewItem {
    userId: number;
    telegramId: string;
    username: string | null;
    firstName: string | null;
    gender: 'MALE' | 'FEMALE' | 'UNKNOWN';
    profileScore: number;
    rendered: string;
}

interface BroadcastModalProps {
    onClose: () => void;
}

interface ScenarioStats {
    templateId: number;
    name: string;
    sent: number;
    replied: number;
    lead: number;
    matched: number;
    customer: number;
    replyRate: number;
    leadRate: number;
    matchRate: number;
    avgReplySeconds: number | null;
}

const SCENARIO_LABELS: Record<string, string> = {
    wm_welcome_after_registration: '👋 Welcome — после регистрации',
    wm_reactivation_general: '🔄 Реактивация — общий запрос',
    wm_reactivation_clients_or_team: '🎯 Клиенты или команда?',
    wm_profile_completion: '📝 Меньше слов — точнее матч',
    wm_specific_match_offer: '🤝 Есть кандидат — визитку?',
    wm_soft_checkin: '☕ Тёплое касание',
    wm_request_specialist: '🛠 Поиск специалиста',
    wm_offer_to_introduce: '🪢 Предложение интро',
    wm_revival_long_paused: '⏰ Долгая пауза — что нового',
    wm_event_or_club_invite: '🎟 Клуб или event',
};

const BroadcastModal: React.FC<BroadcastModalProps> = ({ onClose }) => {
    const [tab, setTab] = useState<'send' | 'stats'>('send');
    const [templates, setTemplates] = useState<Template[]>([]);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [editing, setEditing] = useState(false);
    const [editedContent, setEditedContent] = useState('');
    const [preview, setPreview] = useState<PreviewItem[] | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [loading, setLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [filter, setFilter] = useState({ minProfile: 0, statuses: ['LEAD', 'QUALIFIED', 'MATCHED', 'CHAT', 'CUSTOMER'] });
    const [stats, setStats] = useState<ScenarioStats[] | null>(null);
    const [statsLoading, setStatsLoading] = useState(false);

    useEffect(() => {
        (async () => {
            const res = await fetch('/broadcast/templates');
            const list = await res.json();
            setTemplates(list);
            if (list.length > 0) setSelectedId(list[0].id);
        })();
    }, []);

    const selectedTpl = templates.find(t => t.id === selectedId) || null;

    useEffect(() => {
        setEditedContent(selectedTpl?.content || '');
        setEditing(false);
        setPreview(null);
        setSelected(new Set());
    }, [selectedId]);

    const loadPreview = async () => {
        if (!selectedTpl) return;
        setLoading(true);
        try {
            const res = await fetch('/broadcast/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    templateId: selectedTpl.id,
                    filter: { minProfileFields: filter.minProfile, statuses: filter.statuses, limit: 200 },
                }),
            });
            const data = await res.json();
            setPreview(data.items || []);
            setSelected(new Set((data.items || []).map((i: PreviewItem) => i.userId)));
        } catch (e: any) {
            alert(`Ошибка превью: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    const saveTemplate = async () => {
        if (!selectedTpl) return;
        try {
            const res = await fetch(`/broadcast/templates/${selectedTpl.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: editedContent }),
            });
            if (!res.ok) throw new Error('Save failed');
            const tpl = await res.json();
            setTemplates(ts => ts.map(t => (t.id === tpl.id ? tpl : t)));
            setEditing(false);
            alert('Сохранено');
        } catch (e: any) { alert(e.message); }
    };

    const send = async (mode: 'draft' | 'auto') => {
        if (!selectedTpl || selected.size === 0) return;
        const action = mode === 'auto' ? 'отправить НАПРЯМУЮ' : 'создать черновики';
        if (!confirm(`Точно ${action} для ${selected.size} человек?`)) return;
        setSending(true);
        try {
            const res = await fetch('/broadcast/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ templateId: selectedTpl.id, userIds: [...selected], mode }),
            });
            const data = await res.json();
            const msg = mode === 'auto'
                ? `Отправлено: ${data.sent}. Ошибок: ${data.failed?.length || 0}`
                : `Черновиков создано: ${data.queued}. Ошибок: ${data.failed?.length || 0}. Открой диалоги — там синие черновики.`;
            alert(msg);
            onClose();
        } catch (e: any) { alert(e.message); } finally { setSending(false); }
    };

    const toggle = (id: number) => {
        const next = new Set(selected);
        next.has(id) ? next.delete(id) : next.add(id);
        setSelected(next);
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
            <div className="bg-card w-full md:max-w-3xl md:rounded-xl shadow-xl border border-border overflow-hidden flex flex-col max-h-[95vh] safe-bottom">
                <div className="bg-muted/50 px-4 pt-4 pb-0 border-b border-border shrink-0">
                    <div className="flex justify-between items-center mb-3">
                        <h3 className="font-semibold text-lg flex items-center gap-2">
                            <Megaphone className="w-5 h-5 text-orange-500" /> Рассылка по базе
                        </h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-2 -mr-2"><X className="h-5 w-5" /></button>
                    </div>
                    <div className="flex gap-1">
                        <button
                            onClick={() => setTab('send')}
                            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px ${tab === 'send' ? 'border-orange-500 text-orange-500' : 'border-transparent text-muted-foreground'}`}
                        >
                            <Send className="w-3.5 h-3.5 inline mr-1" /> Отправить
                        </button>
                        <button
                            onClick={async () => {
                                setTab('stats');
                                if (!stats) {
                                    setStatsLoading(true);
                                    try {
                                        const res = await fetch('/broadcast/stats');
                                        const data = await res.json();
                                        setStats(data.stats || []);
                                    } finally {
                                        setStatsLoading(false);
                                    }
                                }
                            }}
                            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px ${tab === 'stats' ? 'border-orange-500 text-orange-500' : 'border-transparent text-muted-foreground'}`}
                        >
                            <BarChart3 className="w-3.5 h-3.5 inline mr-1" /> Статистика
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {tab === 'stats' && (
                        <div className="space-y-2">
                            {statsLoading && (
                                <div className="text-center py-8 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
                            )}
                            {!statsLoading && stats && stats.length === 0 && (
                                <div className="text-center py-8 text-muted-foreground text-sm">Пока нет данных рассылок.</div>
                            )}
                            {!statsLoading && stats && stats.length > 0 && (
                                <>
                                    <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-2">
                                        Воронка по сценариям. Replied = ответил в течение 14 дней. Lead = upgrade ≤ 30 дней после рассылки.
                                    </div>
                                    {stats.sort((a, b) => b.sent - a.sent).map(s => (
                                        <div key={s.templateId} className="border border-border rounded-md p-3 hover:border-orange-500/40">
                                            <div className="text-sm font-medium mb-1">{SCENARIO_LABELS[s.name] || s.name}</div>
                                            <div className="grid grid-cols-4 gap-2 text-[11px]">
                                                <div>
                                                    <div className="text-muted-foreground">Отправлено</div>
                                                    <div className="text-base font-semibold">{s.sent}</div>
                                                </div>
                                                <div>
                                                    <div className="text-muted-foreground">Ответили</div>
                                                    <div className="text-base font-semibold text-emerald-500">{s.replied} <span className="text-[10px] opacity-70">({s.replyRate}%)</span></div>
                                                </div>
                                                <div>
                                                    <div className="text-muted-foreground">Стали LEAD</div>
                                                    <div className="text-base font-semibold text-orange-500">{s.lead} <span className="text-[10px] opacity-70">({s.leadRate}%)</span></div>
                                                </div>
                                                <div>
                                                    <div className="text-muted-foreground">MATCHED</div>
                                                    <div className="text-base font-semibold text-purple-500">{s.matched} <span className="text-[10px] opacity-70">({s.matchRate}%)</span></div>
                                                </div>
                                            </div>
                                            {s.avgReplySeconds !== null && s.replied > 0 && (
                                                <div className="text-[10px] text-muted-foreground mt-2">
                                                    Среднее время до ответа: {s.avgReplySeconds < 3600 ? `${Math.round(s.avgReplySeconds / 60)} мин` : `${(s.avgReplySeconds / 3600).toFixed(1)} ч`}
                                                </div>
                                            )}
                                            {/* Tiny conversion bar */}
                                            <div className="mt-2 flex h-1.5 rounded overflow-hidden bg-muted">
                                                {s.sent > 0 && <>
                                                    <div className="bg-emerald-500" style={{ width: `${s.replyRate}%` }} />
                                                    <div className="bg-orange-500" style={{ width: `${Math.max(0, s.leadRate - s.replyRate)}%` }} />
                                                </>}
                                            </div>
                                        </div>
                                    ))}
                                </>
                            )}
                        </div>
                    )}

                    {tab === 'send' && (<>
                    {/* Template picker */}
                    <div>
                        <label className="text-xs font-medium text-muted-foreground uppercase mb-1 block">Сценарий</label>
                        <select
                            className="w-full bg-muted rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                            value={selectedId ?? ''}
                            onChange={e => setSelectedId(Number(e.target.value))}
                        >
                            {templates.map(t => (
                                <option key={t.id} value={t.id}>{SCENARIO_LABELS[t.name] || t.name}</option>
                            ))}
                        </select>
                    </div>

                    {/* Template body — view or edit */}
                    {selectedTpl && (
                        <div>
                            <div className="flex justify-between items-center mb-1">
                                <label className="text-xs font-medium text-muted-foreground uppercase">Текст</label>
                                <button
                                    onClick={() => setEditing(v => !v)}
                                    className="text-xs text-indigo-500 hover:underline flex items-center gap-1"
                                >
                                    <Edit3 className="w-3 h-3" /> {editing ? 'Отмена' : 'Редактировать'}
                                </button>
                            </div>
                            {editing ? (
                                <div>
                                    <textarea
                                        value={editedContent}
                                        onChange={e => setEditedContent(e.target.value)}
                                        className="w-full bg-muted rounded-md p-3 text-sm min-h-[120px] focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                                    />
                                    <button onClick={saveTemplate} className="mt-2 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-xs">Сохранить</button>
                                </div>
                            ) : (
                                <div className="bg-muted/30 rounded-md p-3 text-sm whitespace-pre-wrap font-mono text-xs leading-relaxed">
                                    {selectedTpl.content}
                                </div>
                            )}
                            <p className="text-[10px] text-muted-foreground mt-1">
                                Переменные: <code>{'{firstName}'}</code> · <code>{'{мужской|женский|неизвестный}'}</code> формы для гендерных окончаний
                            </p>
                        </div>
                    )}

                    {/* Filter */}
                    <div className="bg-muted/30 rounded-md p-3 text-xs space-y-2">
                        <div className="font-medium text-muted-foreground uppercase">Кому отправлять</div>
                        <label className="flex items-center gap-2">
                            <input
                                type="number" min={0} max={8}
                                value={filter.minProfile}
                                onChange={e => setFilter(f => ({ ...f, minProfile: Number(e.target.value) }))}
                                className="w-14 bg-background rounded px-2 py-1 text-center"
                            />
                            <span>минимум полей профиля заполнено (0 = всем)</span>
                        </label>
                        <div className="text-[10px] text-muted-foreground">
                            Статусы: {filter.statuses.join(', ')} · Не пишем тем, кому отправляли в последние 72 часа.
                        </div>
                        <button
                            onClick={loadPreview}
                            disabled={loading}
                            className="bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-xs flex items-center gap-1 disabled:opacity-50"
                        >
                            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                            Показать получателей
                        </button>
                    </div>

                    {/* Preview */}
                    {preview && (
                        <div>
                            <div className="text-xs text-muted-foreground mb-2">
                                Найдено: <strong>{preview.length}</strong> · Выбрано: <strong>{selected.size}</strong>
                                <button onClick={() => setSelected(s => s.size === preview.length ? new Set() : new Set(preview.map(p => p.userId)))}
                                    className="ml-2 text-indigo-500 hover:underline">
                                    {selected.size === preview.length ? 'Снять все' : 'Выбрать всех'}
                                </button>
                            </div>
                            <div className="space-y-1.5 max-h-80 overflow-y-auto">
                                {preview.map(p => (
                                    <label key={p.userId} className={`flex gap-2 p-2 rounded border cursor-pointer hover:bg-muted/50 ${selected.has(p.userId) ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-border'}`}>
                                        <input
                                            type="checkbox" checked={selected.has(p.userId)}
                                            onChange={() => toggle(p.userId)}
                                            className="mt-0.5"
                                        />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-medium flex items-center gap-1 flex-wrap">
                                                {p.firstName || '—'} {p.username && <span className="text-muted-foreground">@{p.username}</span>}
                                                <span className={`text-[9px] px-1 py-0.5 rounded ${p.gender === 'MALE' ? 'bg-blue-500/10 text-blue-500' : p.gender === 'FEMALE' ? 'bg-pink-500/10 text-pink-500' : 'bg-gray-500/10 text-gray-500'}`}>
                                                    {p.gender === 'MALE' ? '♂' : p.gender === 'FEMALE' ? '♀' : '?'}
                                                </span>
                                                <span className="text-[9px] text-muted-foreground">profile: {p.profileScore}/8</span>
                                            </div>
                                            <div className="text-[11px] text-muted-foreground mt-0.5 whitespace-pre-line line-clamp-3">{p.rendered}</div>
                                        </div>
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}
                    </>)}
                </div>

                {/* Footer actions (only for Send tab) */}
                {tab === 'send' && <div className="p-3 border-t border-border bg-muted/20 flex flex-col sm:flex-row gap-2 shrink-0">
                    <button
                        onClick={() => send('draft')}
                        disabled={!preview || selected.size === 0 || sending}
                        className="flex-1 bg-indigo-500/10 text-indigo-500 py-2 rounded-md text-sm font-medium hover:bg-indigo-500/20 disabled:opacity-40 flex items-center justify-center gap-2"
                    >
                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Edit3 className="w-4 h-4" />}
                        Создать черновики ({selected.size})
                    </button>
                    <button
                        onClick={() => send('auto')}
                        disabled={!preview || selected.size === 0 || sending}
                        className="flex-1 bg-orange-600 text-white py-2 rounded-md text-sm font-medium hover:bg-orange-700 disabled:opacity-40 flex items-center justify-center gap-2"
                    >
                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        Отправить сразу ({selected.size})
                    </button>
                </div>}
            </div>
        </div>
    );
};

export default BroadcastModal;
