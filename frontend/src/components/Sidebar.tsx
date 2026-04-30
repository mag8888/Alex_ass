import React, { useState, useEffect } from 'react';
import { useChat } from '../hooks/useChat';
import { Search, RotateCw, Plus, MessageSquare, Binoculars, Megaphone, Brain } from 'lucide-react';
import BroadcastModal from './BroadcastModal';
import BrainModal from './BrainModal';
import { DialogueSource, UserStatus } from '../types';
import { getScoutChats, addScoutChat } from '../api';
import { useNavigate, useLocation } from 'react-router-dom';

interface SidebarProps {
    chatState: ReturnType<typeof useChat>;
}

interface ScannedChat {
    id: number;
    title: string;
    username: string;
    link: string;
    lastLeadsCount: number;
}

const Sidebar: React.FC<SidebarProps> = ({ chatState }) => {
    const navigate = useNavigate();
    const location = useLocation();

    const [activeTab, setActiveTab] = useState<'chats' | 'scout'>('chats');
    const [scoutChats, setScoutChats] = useState<ScannedChat[]>([]);
    const [newChatLink, setNewChatLink] = useState('');
    const [showAddChat, setShowAddChat] = useState(false);
    const [showBroadcast, setShowBroadcast] = useState(false);
    const [showBrain, setShowBrain] = useState(false);

    const {
        dialogues,
        currentDialogue,
        newDialogueIds,
        selectChat,
        search,
        setSearch,
        filter,
        setFilter,
        syncChats,
        showRejected,
        setShowRejected,
        loading,
        fullReset,
    } = chatState;


    // Load Scout Chats when tab is active
    useEffect(() => {
        if (activeTab === 'scout') {
            loadScoutChats();
        }
    }, [activeTab]);

    const loadScoutChats = async () => {
        try {
            const data = await getScoutChats();
            setScoutChats(data as any); // Type cast for now due to API definition mismatch if any
        } catch (e) {
            console.error(e);
        }
    };

    const handleAddChat = async () => {
        if (!newChatLink) return;
        try {
            await addScoutChat(newChatLink);
            setNewChatLink('');
            setShowAddChat(false);
            loadScoutChats();
        } catch (e) {
            alert('Failed to add chat');
        }
    };

    const handleTabChange = (tab: 'chats' | 'scout') => {
        setActiveTab(tab);
        if (tab === 'chats') {
            navigate('/');
        } else {
            // Default to first scout chat or just stay on scout base
            navigate('/scout');
        }
    };

    return (
        <div className="flex flex-col h-full bg-card md:border-r md:border-border">
            {/* Tabs */}
            <div className="flex border-b border-border safe-top">
                <button
                    onClick={() => handleTabChange('chats')}
                    className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 border-b-2 transition-colors ${activeTab === 'chats' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                    <MessageSquare className="w-4 h-4" /> Chats
                </button>
                <button
                    onClick={() => handleTabChange('scout')}
                    className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 border-b-2 transition-colors ${activeTab === 'scout' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                    <Binoculars className="w-4 h-4" /> Scout
                </button>
            </div>

            {/* Header / Search (Conditional per Tab) */}
            <div className="p-4 border-b border-border space-y-3">
                {activeTab === 'chats' ? (
                    <>
                        <div className="flex items-center gap-2">
                            <div className="relative flex-1">
                                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <input
                                    type="text"
                                    placeholder="Search chats..."
                                    className="w-full pl-9 pr-4 py-2 bg-muted text-sm rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                />
                            </div>
                            <button
                                onClick={() => setShowBroadcast(true)}
                                className="p-2 hover:bg-orange-500/10 rounded-md transition-colors text-orange-500"
                                title="Рассылка по базе"
                            >
                                <Megaphone className="h-5 w-5" />
                            </button>
                            <button
                                onClick={() => setShowBrain(true)}
                                className="p-2 hover:bg-purple-500/10 rounded-md transition-colors text-purple-500"
                                title="Conversation Brain — обучающие паттерны"
                            >
                                <Brain className="h-5 w-5" />
                            </button>
                            <button
                                onClick={syncChats}
                                disabled={loading}
                                className="p-2 hover:bg-muted rounded-md transition-colors text-muted-foreground hover:text-foreground"
                                title="Sync with Telegram"
                            >
                                <RotateCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
                            </button>
                        </div>

                        {/* Filters */}
                        <div className="flex items-center justify-between">
                            <div className="flex bg-muted p-1 rounded-lg">
                                {(['ALL', 'INBOUND', 'SCOUT'] as const).map((f) => (
                                    <button
                                        key={f}
                                        onClick={() => setFilter(f as any)}
                                        className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filter === f
                                            ? 'bg-background text-foreground shadow-sm'
                                            : 'text-muted-foreground hover:text-foreground'
                                            }`}
                                    >
                                        {f === 'INBOUND' ? 'Direct' : f === 'ALL' ? 'All' : 'Scout'}
                                    </button>
                                ))}
                            </div>

                            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={showRejected}
                                    onChange={(e) => setShowRejected(e.target.checked)}
                                    className="rounded border-border bg-muted"
                                />
                                Rejected
                            </label>
                        </div>
                    </>
                ) : (
                    /* Scout Header */
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            {!showAddChat ? (
                                <button
                                    onClick={() => setShowAddChat(true)}
                                    className="w-full bg-primary text-primary-foreground py-2 rounded-md text-sm font-medium flex items-center justify-center gap-2 hover:bg-primary/90"
                                >
                                    <Plus className="w-4 h-4" /> Add New Chat
                                </button>
                            ) : (
                                <div className="flex gap-2 w-full">
                                    <input
                                        className="flex-1 bg-muted rounded px-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                                        placeholder="t.me/chat"
                                        value={newChatLink}
                                        onChange={e => setNewChatLink(e.target.value)}
                                        autoFocus
                                    />
                                    <button onClick={handleAddChat} className="bg-primary text-primary-foreground px-3 rounded text-sm">Add</button>
                                    <button onClick={() => setShowAddChat(false)} className="bg-muted text-muted-foreground px-3 rounded text-sm">✕</button>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* List Content */}
            <div className="flex-1 overflow-y-auto">
                {activeTab === 'chats' ? (
                    // Existing Chat List
                    dialogues.map((d) => {
                        const isActive = currentDialogue?.id === d.id;
                        const isNew = newDialogueIds.has(d.id) || d.user.status === 'NEW';
                        const isScout = d.source === DialogueSource.SCOUT || d.user.sourceChatId;
                        const lastMsg = d.messages?.[0];

                        return (
                            <div
                                key={d.id}
                                onClick={() => { navigate('/'); selectChat(d.id); }}
                                className={`p-3 border-b border-border/50 cursor-pointer transition-colors hover:bg-muted/50 ${isActive && location.pathname === '/' ? 'bg-muted border-l-4 border-l-primary' :
                                    isNew ? 'bg-green-500/8 border-l-4 border-l-green-500 animate-pulse-once' : ''
                                    }`}
                            >
                                <div className="flex justify-between items-start mb-1">
                                    <div className="font-medium text-sm truncate pr-2 flex items-center gap-1">
                                        {d.user.firstName || 'User'} {d.user.lastName}
                                        {d.user.username && <span className="text-muted-foreground text-xs ml-1">@{d.user.username}</span>}
                                        {isNew && (
                                            <span className="ml-1 text-[10px] font-bold bg-green-500 text-white px-1.5 py-0.5 rounded-full animate-bounce">NEW</span>
                                        )}
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${isScout
                                        ? 'bg-purple-500/10 text-purple-500'
                                        : 'bg-green-500/10 text-green-500'
                                        }`}>
                                        {isScout ? 'SCOUT' : 'DIRECT'}
                                    </span>
                                    {d.user.status === UserStatus.LEAD && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-500 font-medium">🔥 Lead</span>
                                    )}
                                </div>

                                <div className="text-xs text-muted-foreground truncate">
                                    {lastMsg ? lastMsg.text : <span className="italic">No messages</span>}
                                </div>
                            </div>
                        );
                    })
                ) : (
                    // Scout Chat List
                    scoutChats.map(chat => {
                        const isActive = location.pathname.includes(`/scout/${chat.username}`);
                        return (
                            <div
                                key={chat.id}
                                onClick={() => navigate(`/scout/${chat.username}`)}
                                className={`p-4 border-b border-border/50 cursor-pointer transition-colors hover:bg-muted/50 ${isActive ? 'bg-muted border-l-4 border-l-primary' : ''}`}
                            >
                                <div className="flex justify-between items-center mb-1">
                                    <div className="font-medium text-sm truncate">{chat.title || chat.username}</div>
                                    <div className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-sm min-w-[20px] text-center">
                                        {chat.lastLeadsCount || 0}
                                    </div>
                                </div>
                                <div className="text-xs text-muted-foreground truncate opacity-70">
                                    @{chat.username}
                                </div>
                            </div>
                        );
                    })
                )}

                {/* Empty States */}
                {activeTab === 'chats' && dialogues.length === 0 && !loading && (
                    <div className="p-8 text-center text-muted-foreground text-sm">No chats found</div>
                )}
                {activeTab === 'scout' && scoutChats.length === 0 && (
                    <div className="p-8 text-center text-muted-foreground text-sm">No scout chats yet. Add one!</div>
                )}
            </div>

            {showBroadcast && <BroadcastModal onClose={() => setShowBroadcast(false)} />}
            {showBrain && <BrainModal onClose={() => setShowBrain(false)} />}

            {/* Connection Status Footer */}
            <div className="p-3 border-t border-border bg-muted/30 text-xs safe-bottom">
                <div className="flex justify-between items-center mb-2">
                    <StatusIndicator />
                    <div className="flex items-center gap-2">
                        <button
                            onClick={fullReset}
                            className="text-[10px] text-red-500/70 hover:text-red-500 hover:underline"
                            title="Полный сброс БД (двойное подтверждение)"
                        >
                            Wipe
                        </button>
                        <span className="text-[10px] text-muted-foreground opacity-50">v1.4</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

const StatusIndicator = () => {
    // ... (Keep existing implementation)
    const [status, setStatus] = React.useState<{ connected: boolean, me?: any } | null>(null);
    const [showQr, setShowQr] = React.useState(false);
    const [qrBlob, setQrBlob] = React.useState<string | null>(null);

    React.useEffect(() => {
        const check = async () => {
            try {
                const res = await fetch('/status');
                const data = await res.json();
                setStatus(data);
            } catch (e) {
                setStatus({ connected: false });
            }
        };
        check();
        const interval = setInterval(check, 5000);
        return () => clearInterval(interval);
    }, []);

    const handleReconnect = async () => {
        if (showQr) { setShowQr(false); return; }
        try { await fetch('/reconnect', { method: 'POST' }); } catch (e) { }
        await new Promise(r => setTimeout(r, 2000));
        setShowQr(true);
        const res = await fetch('/login-qr');
        if (res.ok) {
            const blob = await res.blob();
            setQrBlob(URL.createObjectURL(blob));
        } else {
            // Handle error
        }
    };

    if (!status) return <div>Checking...</div>;

    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${status.connected ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className={status.connected ? 'text-green-600' : 'text-red-600'}>
                        {status.connected ? (status.me?.username ? `@${status.me.username}` : (status.me?.firstName || 'Online')) : 'Disconnected'}
                    </span>
                </div>
                {!status.connected && (
                    <button onClick={handleReconnect} className="text-[10px] bg-primary text-primary-foreground px-2 py-1 rounded">Login</button>
                )}
            </div>
            {showQr && qrBlob && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    {/* QR Modal */}
                    <div className="bg-background p-6 rounded-lg shadow-xl"><img src={qrBlob} className="w-64" /><button onClick={() => setShowQr(false)}>Close</button></div>
                </div>
            )}
        </div>
    );
};

export default Sidebar;
