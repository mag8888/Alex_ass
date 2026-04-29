import React, { useState } from 'react';
import type { User } from '../types';
import { X, Briefcase, MapPin, DollarSign, Target, Heart, Award, Link as LinkIcon, BrainCircuit, Users } from 'lucide-react';
import MatchModal from './MatchModal';

interface ClientCardProps {
    user: User;
    onClose: () => void;
}

const PROFILE_KEYS: (keyof User)[] = [
    'activity', 'city', 'businessCard', 'bestClients', 'requests', 'hobbies', 'currentIncome', 'desiredIncome',
];

function profileScore(u: User): number {
    return PROFILE_KEYS.filter(k => {
        const v = u[k];
        return v && String(v).trim().length > 0;
    }).length;
}

const ClientCard: React.FC<ClientCardProps> = ({ user, onClose }) => {
    const [showMatches, setShowMatches] = useState(false);
    const filled = profileScore(user);
    const total = PROFILE_KEYS.length;
    const pct = Math.round((filled / total) * 100);
    const progressColor = pct < 40 ? 'bg-red-500' : pct < 75 ? 'bg-amber-500' : 'bg-emerald-500';

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end md:items-center justify-center p-0 md:p-4">
            <div className="bg-card w-full md:max-w-md md:rounded-xl shadow-xl border border-border overflow-hidden flex flex-col max-h-[95vh] safe-bottom">
                {/* Header */}
                <div className="bg-muted/50 p-4 flex justify-between items-center border-b border-border shrink-0">
                    <h3 className="font-semibold text-lg">Client Card</h3>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-2 -mr-2">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5">
                    {/* Header Info */}
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 md:w-16 md:h-16 rounded-full bg-primary/10 flex items-center justify-center text-2xl font-bold text-primary shrink-0">
                            {user.firstName?.[0] || 'U'}
                        </div>
                        <div className="min-w-0 flex-1">
                            <h2 className="text-lg md:text-xl font-bold truncate">{user.firstName} {user.lastName}</h2>
                            <p className="text-xs md:text-sm text-muted-foreground truncate">@{user.username || 'No username'}</p>
                            <span className={`text-xs px-2 py-0.5 rounded-full mt-1 inline-block ${user.status === 'LEAD' ? 'bg-orange-500/10 text-orange-500' :
                                user.status === 'REJECTED' ? 'bg-red-500/10 text-red-500' :
                                user.status === 'MATCHED' ? 'bg-purple-500/10 text-purple-500' :
                                'bg-green-500/10 text-green-500'
                                }`}>
                                {user.status}
                            </span>
                        </div>
                    </div>

                    {/* Profile completeness */}
                    <div>
                        <div className="flex justify-between items-center text-xs mb-1">
                            <span className="font-medium">Профиль заполнен</span>
                            <span className="text-muted-foreground">{filled}/{total} ({pct}%)</span>
                        </div>
                        <div className="h-2 bg-muted rounded overflow-hidden">
                            <div className={`h-full ${progressColor} transition-all`} style={{ width: `${pct}%` }} />
                        </div>
                    </div>

                    {/* Match action */}
                    <button
                        onClick={() => setShowMatches(true)}
                        disabled={filled < 2}
                        className="w-full bg-emerald-600 text-white py-2.5 rounded-md text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        <Users className="w-4 h-4" /> Найти match-кандидатов
                    </button>
                    {filled < 2 && (
                        <p className="text-[10px] text-muted-foreground text-center -mt-2">
                            (нужно минимум 2 заполненных поля профиля для поиска)
                        </p>
                    )}

                    {/* Fields Grid */}
                    <div className="grid grid-cols-1 gap-4">
                        <InfoItem icon={MapPin} label="City" value={user.city} />
                        <InfoItem icon={Briefcase} label="Activity" value={user.activity} />
                        <InfoItem icon={DollarSign} label="Income" value={user.currentIncome ? `${user.currentIncome} (Goal: ${user.desiredIncome})` : user.desiredIncome ? `Goal: ${user.desiredIncome}` : null} />
                        <InfoItem icon={Target} label="Requests" value={user.requests} />
                        <InfoItem icon={Heart} label="Hobbies" value={user.hobbies} />
                        <InfoItem icon={Award} label="Best Clients" value={user.bestClients} />
                        <InfoItem icon={BrainCircuit} label="AI Strategy / Goal" value={user.networkingGoal} />

                        {/* Source Info */}
                        <div className="flex items-start gap-3">
                            <LinkIcon className={`h-5 w-5 mt-0.5 ${user.sourceChat ? 'text-blue-500' : 'text-muted-foreground/30'}`} />
                            <div>
                                <div className="text-xs font-medium text-muted-foreground uppercase">Source / Inviter</div>
                                {user.sourceChat ? (
                                    <>
                                        <div className="text-sm font-medium">{user.sourceChat.title || 'Unknown Source'}</div>
                                        {user.sourceChat.link && (
                                            <a href={user.sourceChat.link} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:underline truncate block max-w-[200px]">
                                                {user.sourceChat.link}
                                            </a>
                                        )}
                                    </>
                                ) : (
                                    <div className="text-sm text-muted-foreground/50 italic">—</div>
                                )}
                            </div>
                        </div>

                        {/* Business Card / Bio */}
                        <div className="mt-2 text-sm bg-muted/50 p-3 rounded-md">
                            <strong className="block mb-1 text-xs uppercase opacity-70">Business Card / Bio</strong>
                            {user.businessCard || <span className="text-muted-foreground/50 italic">—</span>}
                        </div>
                    </div>
                </div>

                <div className="p-4 border-t border-border bg-muted/20 text-center text-xs text-muted-foreground shrink-0">
                    ID: {user.id} • TG: {user.telegramId}
                </div>
            </div>
            {showMatches && (
                <MatchModal
                    sourceUserId={user.id}
                    sourceUserName={`${user.firstName || ''} ${user.lastName || ''}`.trim() || `@${user.username}`}
                    onClose={() => setShowMatches(false)}
                />
            )}
        </div>
    );
};

const InfoItem = ({ icon: Icon, label, value }: { icon: any, label: string, value?: string | null }) => {
    return (
        <div className="flex items-start gap-3">
            <Icon className={`h-5 w-5 mt-0.5 ${value ? 'text-muted-foreground' : 'text-muted-foreground/30'}`} />
            <div>
                <div className="text-xs font-medium text-muted-foreground uppercase">{label}</div>
                <div className={`text-sm ${value ? '' : 'text-muted-foreground/50 italic'}`}>
                    {value || '—'}
                </div>
            </div>
        </div>
    );
};

export default ClientCard;
