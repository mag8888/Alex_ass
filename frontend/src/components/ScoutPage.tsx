import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { scanChat, analyzeLead, importLead, api, sendScoutDM, replyInChat, getScanHistory, getScanHistoryEntry, updateUserStatus, getScoutChats } from '../api';
import { Play, Loader2, Sparkles, Save, ShieldAlert, Send, MessageSquare, RefreshCw, History as HistoryIcon, X } from 'lucide-react';

// --- Status Helpers ---
const USER_STATUSES = ['NEW', 'LEAD', 'QUALIFIED', 'MATCHED', 'CUSTOMER', 'BLOCKED', 'REJECTED'] as const;
type UserStatusType = typeof USER_STATUSES[number];

const STATUS_EMOJI: Record<UserStatusType, string> = {
    NEW: '🆕',
    LEAD: '🔥',
    QUALIFIED: '✅',
    MATCHED: '🤝',
    CUSTOMER: '💎',
    BLOCKED: '🚫',
    REJECTED: '❌',
};

const getUserStatusEmoji = (status?: string) => STATUS_EMOJI[(status as UserStatusType) || 'LEAD'] || '🔥';

// Profile completeness based on sender info
const getProfileEmoji = (profile?: any) => {
    if (!profile) return '';
    const filledFields = [profile.activity, profile.city, profile.businessCard].filter(Boolean).length;
    if (filledFields === 0) return '📋'; // Empty
    if (filledFields < 2) return '📝'; // Partial
    return '📊'; // Mostly complete
};

interface Lead {
    id: number; // Message ID from Telegram
    text: string;
    date: number;
    isAdmin: boolean;
    sender: {
        id: string;
        username: string | null;
        firstName: string | null;
        lastName: string | null;
        accessHash: string | null;
    };
    // Local state
    analysis?: {
        profile: any;
        draft: string;
        selectedScenarios?: string[]; // Track selected scenarios
        customName?: string; // Editable name for template
        customContext?: string; // New custom context field
    };
    isAnalyzing?: boolean;
    isImported?: boolean;
    isSending?: boolean; // sending status
    customContext?: string;
    userStatus?: string; // Current status fetched/set
}

const SCENARIO_OPTIONS = [
    { id: 'greeting', label: '👋 Приветствие (Имя)', text: (p: any) => `${p.firstName ? `${p.firstName}, Привет` : 'Привет'}, ` },
    { id: 'hook_interest', label: '👌 Интересный проект', text: (p: any) => `У вас интересное направление(${p.activity || 'работа'})!` },
    { id: 'context_chat', label: '👀 Видел в чате', text: (_: any) => `Увидел ваше сообщение в чате по нетворкингу.` },
    { id: 'poll_context', label: '📊 Участие в опросе', text: (p: any) => p.pollVote ? `Видел, что вы проголосовали "${p.pollVote}" в нашем опросе.` : `Видел ваш ответ в опросе.` },
    { id: 'offer_club', label: '🚀 Оффер: Клуб', text: (_: any) => `Мы делаем онлайн - нетворкинг и можем знакомить вас с полезными людьми каждый день.` },
    { id: 'offer_service', label: '🤖 Оффер: ИИ сервис', text: (_: any) => `Мы сделали сервис, который дает 5 - 10 теплых интро ежедневно.` },
    { id: 'cta_soft', label: '❓ CTA: Мягкий', text: (_: any) => `Было бы интересно попробовать ? ` },
];

// Local storage hook helper
const useLocalStorage = <T,>(key: string, initialValue: T) => {
    const [storedValue, setStoredValue] = useState<T>(() => {
        try {
            const item = window.localStorage.getItem(key);
            return item ? JSON.parse(item) : initialValue;
        } catch (error) {
            console.error(error);
            return initialValue;
        }
    });
    const setValue = (value: T | ((val: T) => T)) => {
        try {
            const valueToStore = value instanceof Function ? value(storedValue) : value;
            setStoredValue(valueToStore);
            window.localStorage.setItem(key, JSON.stringify(valueToStore));
        } catch (error) {
            console.error(error);
        }
    };
    return [storedValue, setValue] as const;
};

const ScoutPage = () => {
    const { username } = useParams();
    const [leads, setLeads] = useState<Lead[]>([]);
    const [scanning, setScanning] = useState(false);
    const [scanLimit, setScanLimit] = useState(50);
    const [scanKeywords, setScanKeywords] = useState('');
    const [chatTitle, setChatTitle] = useState<string>('');

    // History
    const [showHistory, setShowHistory] = useState(false);
    const [historyItems, setHistoryItems] = useState<any[]>([]);

    // Templates
    const [templates, setTemplates] = useLocalStorage<{ id: string, name: string, content: string }[]>('scout_templates', []);
    const [selectedTemplate, setSelectedTemplate] = useState<string>('');

    // Parse All state
    const [parseAllProgress, setParseAllProgress] = useState<{ current: number; total: number; chatName: string } | null>(null);
    const [allLeads, setAllLeads] = useState<Lead[]>([]); // Aggregated leads from all chats
    const [showAllLeads, setShowAllLeads] = useState(false);

    useEffect(() => {
        if (username) {
            handleScan(username);
        } else {
            setLeads([]);
            setChatTitle('');
        }
    }, [username]);

    const handleScan = async (chatUsername: string) => {
        setScanning(true);
        setLeads([]);
        setChatTitle(chatUsername); // Default
        try {
            const data = await scanChat(chatUsername, scanLimit, scanKeywords);
            // Support both old array format and new object format
            if (Array.isArray(data)) {
                setLeads(data);
            } else {
                setLeads(data.leads);
                setChatTitle(data.chatTitle || chatUsername);
            }
        } catch (e: any) {
            console.error(e);
            alert(`Scan failed: ${e.response?.data?.error || e.message}`);
        } finally {
            setScanning(false);
        }
    };

    const handleParseAll = async () => {
        try {
            const chats = await getScoutChats();
            if (!chats || chats.length === 0) {
                alert('No scout chats found. Add chats in the Scout tab first.');
                return;
            }

            const aggregated: Lead[] = [];
            setShowAllLeads(true);
            setAllLeads([]);

            for (let i = 0; i < chats.length; i++) {
                const chat = chats[i];
                const chatName = chat.title || chat.username || chat.link;
                setParseAllProgress({ current: i + 1, total: chats.length, chatName });

                try {
                    const data = await scanChat(chat.username || chat.link, scanLimit, scanKeywords);
                    const leads = (Array.isArray(data) ? data : data.leads) || [];
                    aggregated.push(...leads);
                    setAllLeads([...aggregated]); // Update incrementally
                } catch (e) {
                    console.warn(`[ParseAll] Failed to scan ${chatName}:`, e);
                }
            }

            setParseAllProgress(null);
            setChatTitle(`All Chats (${chats.length})`);
        } catch (e: any) {
            console.error(e);
            alert(`Parse All failed: ${e.message}`);
            setParseAllProgress(null);
        }
    };

    const toggleHistory = async () => {
        if (!showHistory) {
            try {
                const history = await getScanHistory();
                setHistoryItems(history);
            } catch (e) {
                console.error(e);
            }
        }
        setShowHistory(!showHistory);
    };

    const loadHistoryEntry = async (id: number) => {
        try {
            setScanning(true);
            const entry = await getScanHistoryEntry(id);
            setLeads(entry.leads); // Leads stored as JSON, should be compatible
            if (entry.chat) {
                setChatTitle(entry.chat.title || entry.chat.username || entry.chat.link || 'History Scan');
            }
            setScanKeywords(entry.keywords || '');
            setShowHistory(false);
        } catch (e) {
            console.error(e);
            alert('Failed to load history');
        } finally {
            setScanning(false);
        }
    };

    const handleAnalyze = async (index: number) => {
        const lead = leads[index];
        const newLeads = [...leads];
        newLeads[index].isAnalyzing = true;
        setLeads(newLeads);

        try {
            const result = await analyzeLead(lead.text, lead.sender);

            // User wants flexible selection. Let's select Greeting + Context + Offer by default.
            let defaultScenarios = ['greeting', 'context_chat', 'offer_service', 'cta_soft'];
            let pollVote = null;

            // Check for Poll
            if (lead.text.startsWith('[POLL]')) {
                const match = lead.text.match(/Voted "([^"]+)"/);
                if (match) {
                    pollVote = match[1];
                }
                defaultScenarios = defaultScenarios.map(s => s === 'context_chat' ? 'poll_context' : s);
            }

            // Helper to generate text
            // Added support for customContext injection
            const generateDraft = (scenarios: string[], profile: any, customCtx?: string) => {
                const safeScenarios = Array.isArray(scenarios) ? scenarios : [];
                let text = safeScenarios
                    .map(id => SCENARIO_OPTIONS.find(o => o.id === id)?.text(profile) || '')
                    .join(' ');

                if (customCtx) {
                    text += ` ${customCtx}`;
                }
                return text;
            };

            const profileWithPoll = {
                ...result.profile,
                firstName: lead.sender.firstName || 'Friend',
                pollVote: pollVote,
                channelBox: chatTitle // Pass channel title to scenarios if we want
            };

            newLeads[index].analysis = {
                ...result,
                selectedScenarios: defaultScenarios,
                customName: lead.sender.firstName || 'Friend',
                draft: generateDraft(defaultScenarios, profileWithPoll),
                profile: profileWithPoll,
                // Initialize customContext
                customContext: ''
            };
        } catch (e) {
            console.error(e);
            alert('Analysis failed');
        } finally {
            newLeads[index].isAnalyzing = false;
            setLeads(newLeads);
        }
    };

    const handleImport = async (index: number) => {
        const lead = leads[index];
        if (!lead.analysis || !username) return;

        try {
            try {
                await api.post('/scout/feedback', {
                    text: lead.text,
                    senderUsername: lead.sender.username,
                    senderId: lead.sender.id,
                    scannedChatId: 0,
                    relevance: 'RELEVANT'
                });
            } catch (e) {
                console.warn('Feedback failed', e);
            }

            // Save context as message?
            // "Automatically subst receiving channel as inviter"
            // We can pass `chatTitle` as context if backend supports it.
            // For now, it's just importing the user.
            await importLead(lead.sender, lead.analysis.profile, lead.analysis.draft, 0);

            const newLeads = [...leads];
            newLeads[index].isImported = true;
            setLeads(newLeads);
        } catch (e) {
            console.error(e);
            alert('Import failed');
        }
    };

    const handleDismiss = async (index: number) => {
        const lead = leads[index];
        if (!lead.analysis) return;

        try {
            await api.post('/scout/feedback', {
                text: lead.text,
                senderUsername: lead.sender.username,
                senderId: lead.sender.id,
                scannedChatId: 0,
                relevance: 'IRRELEVANT'
            });

            const newLeads = leads.filter((_, i) => i !== index);
            setLeads(newLeads);
        } catch (e) {
            console.error(e);
            alert('Dismiss failed');
        }
    };

    // Helper to apply a template
    const applyTemplate = (index: number, templateId: string) => {
        const newLeads = [...leads];
        const template = templates.find(t => t.id === templateId);
        if (!template || !newLeads[index].analysis) return;

        const analysis = newLeads[index].analysis!;
        // Substitute variables
        let content = template.content;
        content = content.replace(/{name}/g, analysis.customName || 'Friend');
        content = content.replace(/{channel}/g, chatTitle || 'Chat');

        analysis.draft = content;
        setLeads(newLeads);
        setSelectedTemplate(''); // Reset dropdown
    };

    const saveAsTemplate = (content: string) => {
        const name = prompt('Enter template name:', 'New Template');
        if (name) {
            setTemplates(prev => [...prev, { id: Date.now().toString(), name, content }]);
        }
    };

    if (!username) {
        return (
            <div className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center">
                    <div className="grayscale text-4xl mb-2">🔭</div>
                    <p>Select a chat from the Scout tab to view leads.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col p-6 overflow-y-auto bg-background/50">
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h2 className="text-2xl font-bold flex items-center gap-2">@{chatTitle || username}</h2>
                    <p className="text-sm text-muted-foreground">Found {leads.length} leads in {chatTitle}</p>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 bg-background border rounded px-2 py-1">
                        <span className="text-xs text-muted-foreground">Limit:</span>
                        <input
                            type="number"
                            className="w-12 text-sm bg-transparent focus:outline-none"
                            value={scanLimit}
                            onChange={(e) => setScanLimit(Number(e.target.value))}
                            min={10}
                            max={500}
                        />
                    </div>
                    <div className="flex items-center gap-1 bg-background border rounded px-2 py-1 w-64">
                        <span className="text-xs text-muted-foreground">Keywords:</span>
                        <input
                            type="text"
                            className="w-full text-sm bg-transparent focus:outline-none"
                            value={scanKeywords}
                            onChange={(e) => setScanKeywords(e.target.value)}
                            placeholder="default (i.e. 'need, offer')"
                        />
                    </div>
                    <button
                        onClick={toggleHistory}
                        className={`p-2 rounded border border-border hover:bg-muted ${showHistory ? 'bg-muted text-primary' : 'text-muted-foreground'}`}
                        title="Scan History"
                    >
                        <HistoryIcon className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => handleScan(username!)}
                        disabled={scanning}
                        className="flex items-center gap-2 bg-secondary text-secondary-foreground px-4 py-2 rounded hover:bg-secondary/80 disabled:opacity-50"
                    >
                        {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                        {scanning ? 'Scanning...' : 'Rescan'}
                    </button>
                    <button
                        onClick={handleParseAll}
                        disabled={!!parseAllProgress}
                        className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded hover:bg-primary/90 disabled:opacity-50"
                        title="Scan all scout chats and collect leads"
                    >
                        {parseAllProgress ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>⚡</span>}
                        {parseAllProgress ? `${parseAllProgress.current}/${parseAllProgress.total}...` : 'Parse All'}
                    </button>
                </div>
            </div>

            {/* Parse All Progress & Results */}
            {(parseAllProgress || showAllLeads) && (
                <div className="mb-4 p-4 bg-primary/5 border border-primary/20 rounded-lg max-w-3xl mx-auto w-full">
                    <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                            <span className="font-semibold text-sm">⚡ Parse All Results</span>
                            <span className="text-sm text-muted-foreground">({allLeads.length} leads found)</span>
                        </div>
                        <div className="flex items-center gap-2">
                            {parseAllProgress && (
                                <span className="text-xs text-muted-foreground">Scanning: {parseAllProgress.chatName} ({parseAllProgress.current}/{parseAllProgress.total})</span>
                            )}
                            {!parseAllProgress && (
                                <button
                                    onClick={() => { setShowAllLeads(false); setAllLeads([]); }}
                                    className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 border border-border rounded"
                                >Clear</button>
                            )}
                        </div>
                    </div>
                    {parseAllProgress && (
                        <div className="w-full bg-border rounded-full h-1.5 mb-2">
                            <div
                                className="bg-primary h-1.5 rounded-full transition-all duration-500"
                                style={{ width: `${(parseAllProgress.current / parseAllProgress.total) * 100}%` }}
                            />
                        </div>
                    )}
                </div>
            )}

            <div className="space-y-6 max-w-3xl mx-auto w-full">
                {/* Which leads to show: all-leads mode or single-chat mode */}
                {(showAllLeads ? allLeads : leads).length === 0 && !scanning && !parseAllProgress && (
                    <div className="text-muted-foreground text-center py-10">No relevant leads found in last 50 messages.</div>
                )}

                {(showAllLeads ? allLeads : leads).map((lead, idx) => (
                    <div key={idx} className={`border rounded - lg p - 4 bg - card shadow - sm ${lead.isImported ? 'opacity-50 border-green-500/30' : 'border-border'} `}>
                        {/* Header */}
                        <div className="flex justify-between items-start mb-2">
                            <div className="flex items-center gap-2 flex-wrap">
                                <div className="font-bold text-lg text-primary flex items-center gap-1">
                                    {lead.sender.firstName} {lead.sender.lastName}
                                    {/* Profile completeness emoji (shows when analyzed) */}
                                    {lead.analysis && <span title="Profile completeness">{getProfileEmoji(lead.analysis.profile)}</span>}
                                </div>
                                <div className="text-sm text-muted-foreground">@{lead.sender.username || 'No Username'}</div>
                                {lead.isAdmin && (
                                    <span className="bg-red-500/10 text-red-400 text-xs px-2 py-0.5 rounded border border-red-500/20 flex items-center gap-1">
                                        <ShieldAlert className="w-3 h-3" /> 👑 Admin
                                    </span>
                                )}
                                {/* User status badge with emoji */}
                                <span className="text-xs bg-muted px-2 py-0.5 rounded border border-border/50" title="User status">
                                    {getUserStatusEmoji(lead.userStatus || 'LEAD')} {lead.userStatus || 'LEAD'}
                                </span>
                                {/* Quick status change (Admin control) */}
                                {!lead.isAdmin && (
                                    <select
                                        className="text-xs bg-background border border-border rounded px-1.5 py-0.5 text-muted-foreground cursor-pointer hover:border-primary/50 transition-colors"
                                        value={lead.userStatus || 'LEAD'}
                                        onChange={async (e) => {
                                            const newStatus = e.target.value;
                                            try {
                                                await updateUserStatus(lead.sender.id, newStatus);
                                                const newLeads = [...leads];
                                                newLeads[idx].userStatus = newStatus;
                                                setLeads(newLeads);
                                            } catch (err) {
                                                alert('Failed to update status');
                                            }
                                        }}
                                        title="Change user status"
                                    >
                                        {USER_STATUSES.map(s => (
                                            <option key={s} value={s}>{STATUS_EMOJI[s]} {s}</option>
                                        ))}
                                    </select>
                                )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                                {new Date(lead.date * 1000).toLocaleString()}
                            </div>
                        </div>

                        {/* Message */}
                        <div className="bg-muted/30 p-3 rounded mb-4 text-sm whitespace-pre-wrap font-mono text-muted-foreground border border-border/50">
                            "{lead.text}"
                        </div>

                        {/* Actions / Analysis */}
                        {!lead.analysis ? (
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={() => {
                                        const list = showAllLeads ? [...allLeads] : [...leads];
                                        list.splice(idx, 1);
                                        showAllLeads ? setAllLeads(list) : setLeads(list);
                                    }}
                                    className="flex items-center gap-1 px-3 py-2 rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors text-sm"
                                    title="Пропустить этот лид"
                                >
                                    <X className="w-3.5 h-3.5" /> Пропустить
                                </button>
                                <button
                                    onClick={() => handleAnalyze(idx)}
                                    disabled={lead.isAnalyzing}
                                    className="flex items-center gap-2 bg-purple-600 text-white px-4 py-2 rounded shadow hover:bg-purple-700 transition-colors disabled:opacity-50"
                                >
                                    {lead.isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                    Analyze
                                </button>
                            </div>
                        ) : (
                            <div className="bg-purple-500/5 border border-purple-500/20 rounded-lg p-4 animate-in fade-in duration-300">
                                {/* ... Stats Grid ... */}
                                <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
                                    <div><span className="text-muted-foreground">Activity:</span> <span className="text-foreground font-medium">{lead.analysis.profile.activity || '—'}</span></div>
                                    <div><span className="text-muted-foreground">City:</span> <span className="text-foreground font-medium">{lead.analysis.profile.city || '—'}</span></div>
                                    <div className="col-span-2"><span className="text-muted-foreground">Business Card:</span> <span className="text-foreground">{lead.analysis.profile.businessCard || '—'}</span></div>
                                </div>

                                {/* Name Editing */}
                                <div className="mb-4">
                                    <label className="text-xs text-muted-foreground uppercase font-bold mb-1 block">Recipient Name:</label>
                                    <input
                                        type="text"
                                        className="w-full bg-background border border-border rounded p-2 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
                                        value={lead.analysis.customName || ''}
                                        onChange={(e) => {
                                            const newLeads = [...leads];
                                            if (newLeads[idx].analysis) {
                                                newLeads[idx].analysis!.customName = e.target.value;
                                                setLeads(newLeads);
                                            }
                                        }}
                                        placeholder="Name"
                                    />
                                </div>

                                {/* Scenarios & Tools */}
                                <div className="mb-4">
                                    <div className="flex justify-between items-center mb-1">
                                        <label className="text-xs text-muted-foreground uppercase font-bold">Draft Proposal:</label>
                                        <div className="flex gap-2">
                                            {/* Templates Dropdown */}
                                            {templates.length > 0 && (
                                                <select
                                                    className="text-xs bg-background border border-border rounded px-1"
                                                    onChange={(e) => applyTemplate(idx, e.target.value)}
                                                    value={selectedTemplate}
                                                >
                                                    <option value="">-- Apply Template --</option>
                                                    {templates.map(t => (
                                                        <option key={t.id} value={t.id}>{t.name}</option>
                                                    ))}
                                                </select>
                                            )}

                                            <button
                                                onClick={() => {
                                                    const newLeads = [...leads];
                                                    const analysis = newLeads[idx].analysis!;
                                                    // Re-run generation with current name and scenarios
                                                    const generateText = (ids: string[]) => {
                                                        const safeIds = Array.isArray(ids) ? ids : [];
                                                        let txt = safeIds.map(id => SCENARIO_OPTIONS.find(o => o.id === id)?.text({ ...analysis.profile, firstName: analysis.customName }) || '').join(' ');
                                                        if (analysis.customContext) txt += ` ${analysis.customContext}`;
                                                        return txt;
                                                    };
                                                    analysis.draft = generateText(analysis.selectedScenarios || []);
                                                    setLeads(newLeads);
                                                }}
                                                className="text-xs text-purple-600 hover:text-purple-700 flex items-center gap-1"
                                            >
                                                <RefreshCw className="w-3 h-3" /> Regenerate
                                            </button>
                                        </div>
                                    </div>

                                    {/* Scenario Checkboxes */}
                                    <div className="flex flex-wrap gap-2 mb-2 bg-muted/20 p-2 rounded border border-border/50">
                                        {SCENARIO_OPTIONS.map(option => (
                                            <label key={option.id} className="flex items-center gap-1.5 text-xs cursor-pointer select-none hover:bg-muted/50 p-1 rounded transition-colors">
                                                <input
                                                    type="checkbox"
                                                    className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                                    checked={lead.analysis?.selectedScenarios?.includes(option.id) || false}
                                                    onChange={(e) => {
                                                        const newLeads = [...leads];
                                                        const analysis = newLeads[idx].analysis!;
                                                        const Scenarios = analysis.selectedScenarios || [];

                                                        let newScenarios;
                                                        if (e.target.checked) {
                                                            newScenarios = [...Scenarios, option.id];
                                                            newScenarios.sort((a, b) => {
                                                                return SCENARIO_OPTIONS.findIndex(o => o.id === a) - SCENARIO_OPTIONS.findIndex(o => o.id === b);
                                                            });
                                                        } else {
                                                            newScenarios = Scenarios.filter(id => id !== option.id);
                                                        }

                                                        analysis.selectedScenarios = newScenarios;

                                                        // Regenerate Draft Loop
                                                        const generateText = (ids: string[]) => {
                                                            const safeIds = Array.isArray(ids) ? ids : [];
                                                            let txt = safeIds.map(id => SCENARIO_OPTIONS.find(o => o.id === id)?.text({ ...analysis.profile, firstName: analysis.customName }) || '').join(' ');
                                                            if (analysis.customContext) txt += ` ${analysis.customContext}`;
                                                            return txt;
                                                        };
                                                        analysis.draft = generateText(newScenarios);

                                                        setLeads(newLeads);
                                                    }}
                                                />
                                                {option.label}
                                            </label>
                                        ))}
                                    </div>

                                    {/* Custom Context Input */}
                                    <div className="mb-2">
                                        <input
                                            type="text"
                                            className="w-full bg-red-50/50 border border-red-200 rounded p-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-red-400 transition-colors"
                                            placeholder="Вставьте свой текст здесь (добавится в конец)..."
                                            value={(lead.analysis as any).customContext || ''}
                                            onChange={(e) => {
                                                const newLeads = [...leads];
                                                if (newLeads[idx].analysis) {
                                                    (newLeads[idx].analysis as any).customContext = e.target.value;
                                                    // Trigger regeneration? Or wait for Manual Regenerate?
                                                    // User might want to type and see results. Let's auto-update draft.

                                                    const analysis = newLeads[idx].analysis!;
                                                    const generateText = (ids: string[]) => {
                                                        const safeIds = Array.isArray(ids) ? ids : [];
                                                        let txt = safeIds.map(id => SCENARIO_OPTIONS.find(o => o.id === id)?.text({ ...analysis.profile, firstName: analysis.customName }) || '').join(' ');
                                                        txt += ` ${e.target.value}`; // Use new value immediately
                                                        return txt;
                                                    };
                                                    analysis.draft = generateText(analysis.selectedScenarios || []);

                                                    setLeads(newLeads);
                                                }
                                            }}
                                        />
                                    </div>

                                    <textarea
                                        className="w-full bg-background border border-purple-500/30 rounded p-2 text-sm h-24 focus:outline-none focus:ring-1 focus:ring-purple-500 font-sans"
                                        value={lead.analysis.draft}
                                        onChange={(e) => {
                                            const newLeads = [...leads];
                                            if (newLeads[idx].analysis) {
                                                newLeads[idx].analysis!.draft = e.target.value;
                                                setLeads(newLeads);
                                            }
                                        }}
                                    />

                                    <div className="flex justify-end mt-1">
                                        <button
                                            onClick={() => saveAsTemplate(lead.analysis!.draft)}
                                            className="text-[10px] text-muted-foreground hover:text-purple-600 underline"
                                        >
                                            Save as Template
                                        </button>
                                    </div>
                                </div>

                                <div className="flex justify-end gap-2 items-center">
                                    <button
                                        onClick={() => setLeads(prev => { const n = [...prev]; delete n[idx].analysis; return n; })}
                                        className="mr-auto px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
                                    >
                                        Cancel
                                    </button>

                                    {/* Send Buttons */}
                                    <button
                                        onClick={async () => {
                                            if (!username || lead.isSending) return;
                                            try {
                                                const newLeads = [...leads];
                                                newLeads[idx].isSending = true;
                                                setLeads(newLeads);

                                                await sendScoutDM(lead.sender.username || lead.sender.id, lead.analysis!.draft, lead.analysis!.customName || 'Friend', lead.sender.accessHash || undefined);

                                                alert('Sent to DM!');
                                                // Mark imported?
                                                handleImport(idx);
                                            } catch (e) {
                                                alert('Failed to send DM');
                                            } finally {
                                                const newLeads = [...leads];
                                                newLeads[idx].isSending = false;
                                                setLeads(newLeads);
                                            }
                                        }}
                                        disabled={lead.isSending}
                                        className="flex items-center gap-1 px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
                                    >
                                        <Send className="w-3 h-3" /> Send DM
                                    </button>

                                    <button
                                        onClick={async () => {
                                            if (!username || lead.isSending) return;
                                            try {
                                                const newLeads = [...leads];
                                                newLeads[idx].isSending = true;
                                                setLeads(newLeads);

                                                await replyInChat(username, lead.id, lead.analysis!.draft);

                                                alert('Replied in Chat!');
                                            } catch (e) {
                                                alert('Failed to reply');
                                            } finally {
                                                const newLeads = [...leads];
                                                newLeads[idx].isSending = false;
                                                setLeads(newLeads);
                                            }
                                        }}
                                        disabled={lead.isSending}
                                        className="flex items-center gap-1 px-3 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 text-sm"
                                    >
                                        <MessageSquare className="w-3 h-3" /> Reply in Chat
                                    </button>

                                    {!lead.isImported && (
                                        <div className="flex gap-2 ml-2 pl-2 border-l border-border/50">
                                            <button
                                                onClick={() => handleImport(idx)}
                                                disabled={lead.isImported}
                                                className="flex-1 bg-purple-600 text-white py-2 px-3 rounded hover:bg-purple-700 disabled:opacity-50 text-sm font-medium"
                                            >
                                                {lead.isImported ? 'Imported' : 'Import (👍)'}
                                            </button>
                                            <button
                                                onClick={() => handleDismiss(idx)}
                                                className="px-3 py-2 border border-red-200 text-red-600 rounded hover:bg-red-50 text-sm font-medium"
                                            >
                                                Dismiss (👎)
                                            </button>
                                        </div>
                                    )}
                                    {lead.isImported && (
                                        <span className="flex items-center gap-2 text-green-500 font-medium px-4 py-2">
                                            <Save className="w-4 h-4" /> Imported
                                        </span>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
            {/* History Sidebar */}
            {showHistory && (
                <div className="absolute top-0 right-0 h-full w-80 bg-background border-l border-border shadow-xl z-50 flex flex-col animate-in slide-in-from-right duration-300">
                    <div className="p-4 border-b border-border flex justify-between items-center bg-muted/20">
                        <h3 className="font-bold flex items-center gap-2"><HistoryIcon className="w-4 h-4" /> Scan History</h3>
                        <button onClick={() => setShowHistory(false)} className="text-muted-foreground hover:text-foreground">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        {(!historyItems || historyItems.length === 0) ? (
                            <div className="text-center text-muted-foreground text-sm py-8">No history found</div>
                        ) : (
                            historyItems.map((item) => (
                                <div
                                    key={item.id}
                                    onClick={() => loadHistoryEntry(item.id)}
                                    className="border border-border/50 rounded p-3 hover:bg-muted/50 cursor-pointer transition-colors text-sm"
                                >
                                    <div className="font-medium text-foreground mb-1">
                                        {item.chat?.title || item.chat?.username || 'Unknown Chat'}
                                    </div>
                                    <div className="flex justify-between text-xs text-muted-foreground">
                                        <span>{new Date(item.createdAt).toLocaleDateString()} {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                        <span className="bg-secondary px-1.5 py-0.5 rounded text-secondary-foreground">{item.leadsCount} leads</span>
                                    </div>
                                    {item.keywords && (
                                        <div className="mt-1 text-xs text-muted-foreground truncate opacity-70">
                                            Keywords: {item.keywords}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default ScoutPage;
