export type UserStatus =
    | 'NEW'
    | 'CHAT'
    | 'LEAD'
    | 'QUALIFIED'
    | 'REJECTED'
    | 'MATCHED'
    | 'BLOCKED'
    | 'CUSTOMER';

export const UserStatus = {
    NEW: 'NEW',
    CHAT: 'CHAT',
    LEAD: 'LEAD',
    QUALIFIED: 'QUALIFIED',
    REJECTED: 'REJECTED',
    MATCHED: 'MATCHED',
    BLOCKED: 'BLOCKED',
    CUSTOMER: 'CUSTOMER',
} as const;

export type DialogueStatus = 'ACTIVE' | 'ARCHIVED';
export const DialogueStatus = {
    ACTIVE: 'ACTIVE',
    ARCHIVED: 'ARCHIVED',
} as const;

export type DialogueSource = 'INBOUND' | 'SCOUT';
export const DialogueSource = {
    INBOUND: 'INBOUND',
    SCOUT: 'SCOUT',
} as const;

export type MessageSender = 'USER' | 'SIMULATOR' | 'OPERATOR';
export const MessageSender = {
    USER: 'USER',
    SIMULATOR: 'SIMULATOR',
    OPERATOR: 'OPERATOR',
} as const;

export type MessageStatus = 'SENT' | 'DRAFT' | 'RECEIVED';
export const MessageStatus = {
    SENT: 'SENT',
    DRAFT: 'DRAFT',
    RECEIVED: 'RECEIVED',
} as const;

export interface User {
    id: number;
    telegramId: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    bio?: string;
    status: UserStatus;
    notes?: string;
    sourceChatId?: number;
    createdAt: string;
    updatedAt: string;
    // Profile Fields
    city?: string;
    activity?: string;
    currentIncome?: string;
    desiredIncome?: string;
    requests?: string;
    hobbies?: string;
    bestClients?: string;
    businessCard?: string;
    sourceChat?: {
        title: string | null;
        link: string | null;
    };
    networkingGoal?: string;
    autoReply?: boolean;
    profileStatus?: 'EMPTY' | 'PARTIAL' | 'COMPLETE';
}

export interface Message {
    id: number;
    dialogueId: number;
    sender: MessageSender;
    text: string;
    status: MessageStatus;
    createdAt: string; // ISO Date string
    updatedAt?: string;
}

export interface Dialogue {
    id: number;
    userId: number;
    status: DialogueStatus;
    stage: string;
    source: DialogueSource;
    createdAt: string;
    updatedAt: string;
    user: User;
    messages: Message[];
    unreadCount?: number; // Computed on backend usually, or derived
}
