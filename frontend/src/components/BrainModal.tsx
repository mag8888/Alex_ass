import React, { useEffect, useState } from 'react';
import { X, Brain, Trash2, Edit2, Plus, Check, Loader2, Zap } from 'lucide-react';

interface LearnedScenario {
    id: number;
    stage: 'DISCOVERY' | 'OFFER' | 'QUALIFICATION' | 'CLOSED';
    trigger: string;
    recommend: string;
    avoid?: string | null;
    source: 'manual' | 'human_override' | 'auto_analyzer';
    successScore: number;
    usageCount: number;
    isActive: boolean;
    notes?: string | null;
    createdAt: string;
    lastUsedAt?: string | null;
}

interface BrainModalProps {
    onClose: () => void;
}

const STAGES: LearnedScenario['stage'][] = ['DISCOVERY', 'OFFER', 'QUALIFICATION', 'CLOSED'];
const SOURCE_LABEL: Record<string, string> = {
    manual: '✍️ Вручную',
    human_override: '👤 Override',
    auto_analyzer: '🤖 Auto',
};

const BrainModal: React.FC<BrainModalProps> = ({ onClose }) => {
    const [items, setItems] = useState<LearnedScenario[]>([]);
    const [loading, setLoading] = useState(true);
    const [filterStage, setFilterStage] = useState<string>('all');
    const [filterSource, setFilterSource] = useState<string>('all');
    const [analyzing, setAnalyzing] = useState(false);
    const [editing, setEditing] = useState<LearnedScenario | null>(null);
    const [creating, setCreating] = useState(false);

    const load = async () => {
        setLoading(true);
        try {
            const res = await fetch('/brain/scenarios');
            const data = await res.json();
            setItems(data || []);
        } finally { setLoading(false); }
    };

    useEffect(() => { load(); }, []);

    const filtered = items.filter(i => {
        if (filterStage !== 'all' && i.stage !== filterStage) return false;
        if (filterSource !== 'all' && i.source !== filterSource) return false;
        return true;
    });

    const toggleActive = async (s: LearnedScenario) => {
        await fetch(`/brain/scenarios/${s.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isActive: !s.isActive }),
        });
        load();
    };

    const remove = async (s: LearnedScenario) => {
        if (!confirm(`Удалить паттерн «${s.trigger.slice(0, 60)}…»?`)) return;
        await fetch(`/brain/scenarios/${s.id}`, { method: 'DELETE' });
        load();
    };

    const runAnalyzer = async () => {
        setAnalyzing(true);
        try {
            const res = await fetch('/brain/analyze-now', { method: 'POST' });
            const data = await res.json();
            alert(`Готово. Диалогов проанализировано: ${data.dialogues}, извлечено: ${data.extracted}, новых паттернов: ${data.saved}.`);
            load();
        } catch (e: any) {
            alert(`Ошибка анализа: ${e.message}`);
        } finally { setAnalyzing(false); }
    };

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
            <div className="bg-card w-full md:max-w-4xl md:rounded-xl shadow-xl border border-border overflow-hidden flex flex-col max-h-[95vh] safe-bottom">
                <div className="bg-muted/50 p-4 flex justify-between items-center border-b border-border shrink-0">
                    <h3 className="font-semibold text-lg flex items-center gap-2">
                        <Brain className="w-5 h-5 text-purple-500" /> Conversation Brain
                    </h3>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-2 -mr-2"><X className="h-5 w-5" /></button>
                </div>

                {/* Toolbar */}
                <div className="p-3 border-b border-border bg-muted/20 flex flex-wrap gap-2 items-center">
                    <select className="bg-muted text-xs rounded px-2 py-1.5" value={filterStage} onChange={e => setFilterStage(e.target.value)}>
                        <option value="all">Все стадии</option>
                        {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <select className="bg-muted text-xs rounded px-2 py-1.5" value={filterSource} onChange={e => setFilterSource(e.target.value)}>
                        <option value="all">Все источники</option>
                        <option value="manual">✍️ Вручную</option>
                        <option value="human_override">👤 Override</option>
                        <option value="auto_analyzer">🤖 Auto</option>
                    </select>
                    <span className="text-xs text-muted-foreground ml-auto">{filtered.length} шт</span>
                    <button onClick={() => setCreating(true)} className="bg-primary text-primary-foreground px-2 py-1.5 rounded text-xs flex items-center gap-1 hover:bg-primary/90">
                        <Plus className="w-3 h-3" /> Добавить
                    </button>
                    <button onClick={runAnalyzer} disabled={analyzing}
                        className="bg-purple-500 text-white px-2 py-1.5 rounded text-xs flex items-center gap-1 hover:bg-purple-600 disabled:opacity-50">
                        {analyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                        Анализ сейчас
                    </button>
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    {loading && <div className="text-center py-8 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>}
                    {!loading && filtered.length === 0 && (
                        <div className="text-center py-12 text-muted-foreground text-sm">
                            Паттернов пока нет.<br />
                            <span className="text-[11px]">Они накапливаются: автоматически из реальных диалогов (cron 04:00 UTC) и из ручных правок драфтов в чате.</span>
                        </div>
                    )}
                    {filtered.map(s => (
                        <div key={s.id} className={`border rounded-md p-3 ${s.isActive ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-border bg-muted/20 opacity-70'}`}>
                            <div className="flex justify-between items-start gap-2 mb-1">
                                <div className="flex items-center gap-2 flex-wrap text-[10px]">
                                    <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-600 font-semibold">{s.stage}</span>
                                    <span className="text-muted-foreground">{SOURCE_LABEL[s.source] || s.source}</span>
                                    {s.usageCount > 0 && <span className="text-muted-foreground">use {s.usageCount}×</span>}
                                </div>
                                <div className="flex gap-1">
                                    <button onClick={() => toggleActive(s)} className={`p-1 rounded hover:bg-muted ${s.isActive ? 'text-emerald-600' : 'text-muted-foreground'}`} title={s.isActive ? 'Деактивировать' : 'Активировать'}>
                                        <Check className="w-3.5 h-3.5" />
                                    </button>
                                    <button onClick={() => setEditing(s)} className="p-1 rounded hover:bg-muted text-muted-foreground" title="Изменить"><Edit2 className="w-3.5 h-3.5" /></button>
                                    <button onClick={() => remove(s)} className="p-1 rounded hover:bg-red-500/10 text-red-500" title="Удалить"><Trash2 className="w-3.5 h-3.5" /></button>
                                </div>
                            </div>
                            <div className="text-xs"><strong>Trigger:</strong> {s.trigger}</div>
                            <div className="text-xs mt-1"><strong>Reply:</strong> {s.recommend}</div>
                            {s.avoid && <div className="text-xs text-red-500 mt-1"><strong>Avoid:</strong> {s.avoid}</div>}
                            {s.notes && <div className="text-[10px] text-muted-foreground mt-1 italic">{s.notes}</div>}
                        </div>
                    ))}
                </div>

                {(editing || creating) && (
                    <ScenarioEditor
                        initial={editing}
                        onClose={() => { setEditing(null); setCreating(false); }}
                        onSaved={() => { setEditing(null); setCreating(false); load(); }}
                    />
                )}
            </div>
        </div>
    );
};

// ─── Editor (modal-in-modal) ─────────────────────────────────────────────────
const ScenarioEditor: React.FC<{ initial: LearnedScenario | null; onClose: () => void; onSaved: () => void; }> = ({ initial, onClose, onSaved }) => {
    const [stage, setStage] = useState<string>(initial?.stage || 'DISCOVERY');
    const [trigger, setTrigger] = useState(initial?.trigger || '');
    const [recommend, setRecommend] = useState(initial?.recommend || '');
    const [avoid, setAvoid] = useState(initial?.avoid || '');
    const [isActive, setIsActive] = useState(initial ? initial.isActive : true);
    const [saving, setSaving] = useState(false);

    const save = async () => {
        if (!trigger || !recommend) return alert('Trigger и Reply обязательны');
        setSaving(true);
        try {
            const url = initial ? `/brain/scenarios/${initial.id}` : '/brain/scenarios';
            await fetch(url, {
                method: initial ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stage, trigger, recommend, avoid: avoid || null, isActive, source: initial?.source || 'manual' }),
            });
            onSaved();
        } finally { setSaving(false); }
    };

    return (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center p-4 z-10">
            <div className="bg-card w-full max-w-lg rounded-lg shadow-xl border border-border p-4 space-y-3">
                <div className="flex justify-between items-center">
                    <h4 className="font-semibold">{initial ? 'Редактировать паттерн' : 'Новый паттерн'}</h4>
                    <button onClick={onClose}><X className="w-4 h-4" /></button>
                </div>
                <div>
                    <label className="text-xs text-muted-foreground">Stage</label>
                    <select className="w-full bg-muted rounded px-2 py-1.5 text-sm" value={stage} onChange={e => setStage(e.target.value)}>
                        {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                </div>
                <div>
                    <label className="text-xs text-muted-foreground">Trigger (когда применять)</label>
                    <textarea className="w-full bg-muted rounded p-2 text-sm min-h-[60px]" value={trigger} onChange={e => setTrigger(e.target.value)} />
                </div>
                <div>
                    <label className="text-xs text-muted-foreground">Reply (что отвечать)</label>
                    <textarea className="w-full bg-muted rounded p-2 text-sm min-h-[80px]" value={recommend} onChange={e => setRecommend(e.target.value)} />
                </div>
                <div>
                    <label className="text-xs text-muted-foreground">Avoid (что НЕ говорить, опционально)</label>
                    <textarea className="w-full bg-muted rounded p-2 text-sm min-h-[40px]" value={avoid} onChange={e => setAvoid(e.target.value)} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
                    Активный (бот будет использовать)
                </label>
                <div className="flex justify-end gap-2 pt-2">
                    <button onClick={onClose} className="px-3 py-1.5 rounded text-xs hover:bg-muted">Отмена</button>
                    <button onClick={save} disabled={saving} className="bg-primary text-primary-foreground px-3 py-1.5 rounded text-xs disabled:opacity-50">
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Сохранить'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default BrainModal;
