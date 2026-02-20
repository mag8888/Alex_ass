import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

export const api = axios.create({
    baseURL: API_URL,
});

export interface User {
    id: number;
    telegramId: string;
    username: string | null;
    firstName: string | null;
    status: string;
}

export interface Message {
    id: number;
    dialogueId: number;
    sender: 'USER' | 'SIMULATOR' | 'OPERATOR';
    text: string;
    status: 'SENT' | 'DRAFT' | 'RECEIVED';
    createdAt: string;
}

export interface Dialogue {
    id: number;
    userId: number;
    status: string;
    stage: string;
    createdAt: string;
    updatedAt: string;
    user: User;
    messages: Message[];
    unreadCount?: number; // Optional, computed by backend
    draftCount?: number; // Optional, computed by backend
    lastMessage?: Message; // Optional
}

export const getDialogues = async () => {
    const response = await api.get<Dialogue[]>('/dialogues');
    return response.data;
};

export const getDialogue = async (id: number) => {
    const response = await api.get<Dialogue>(`/dialogues/${id}`);
    return response.data;
};

export const sendMessage = async (username: string, message: string) => {
    const response = await api.post('/send', { username, message });
    return response.data;
};

export const approveMessage = async (messageId: number, updatedText?: string) => {
    const response = await api.post(`/messages/${messageId}/approve`, { updatedText });
    return response.data;
};

export const regenerateResponse = async (dialogueId: number, instructions?: string) => {
    const response = await api.post(`/dialogues/${dialogueId}/regenerate`, { instructions });
    return response.data;
};

export const getTemplates = async () => {
    const response = await api.get<{ id: number; name: string; content: string }[]>('/templates');
    return response.data;
};

// --- Scout API ---

export const getScoutChats = async () => {
    const response = await api.get<{ id: number; title: string; username: string; link: string }[]>('/scout/chats');
    return response.data;
};

export const addScoutChat = async (link: string) => {
    const response = await api.post('/scout/chats', { link });
    return response.data;
};

export const scanChat = async (username: string, limit: number = 50, keywords?: string) => {
    const response = await api.get<{ leads: any[], chatTitle?: string }>(`/scout/chats/${username}/leads`, { params: { limit, keywords } });
    return response.data;
};

export const sendScoutDM = async (username: string, text: string, name: string, accessHash?: string) => {
    const response = await api.post('/scout/send-dm', { username, text, name, accessHash });
    return response.data;
};

export const replyInChat = async (chatUsername: string, messageId: number, text: string) => {
    const response = await api.post('/scout/reply-chat', { chatUsername, messageId, text });
    return response.data;
};

export const analyzeLead = async (text: string, user: any) => {
    const response = await api.post<{ profile: any; draft: string }>('/scout/analyze', { text, user });
    return response.data;
};

export const importLead = async (user: any, profile: any, draft: string, sourceChatId: number) => {
    const response = await api.post('/scout/import', { user, profile, draft, sourceChatId });
    return response.data;
};

// --- History API ---

export const getScanHistory = async () => {
    const response = await api.get<{ id: number; createdAt: string; keywords: string; limit: number; leadsCount: number; chat: { title?: string; username?: string; link?: string } }[]>('/scout/history');
    return response.data;
};

export const getScanHistoryEntry = async (id: number) => {
    const response = await api.get<{ leads: any[]; chat: any; keywords: string }>('/scout/history/' + id);
    return response.data;
};

// --- User Status API ---

export const updateUserStatus = async (telegramId: string, status: string) => {
    const response = await api.patch(`/users/${telegramId}/status`, { status });
    return response.data;
};

// --- Ignore Triggers (Grey List) ---

export const addIgnoreTrigger = async (keyword: string, type: 'USERNAME' | 'KEYWORD' = 'USERNAME') => {
    const response = await api.post('/triggers', { keyword, type });
    return response.data;
};


