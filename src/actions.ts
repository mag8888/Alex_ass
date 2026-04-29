import { Api } from "telegram";
import { getClient } from "./client";
import { MessageStatus, MessageSender } from '@prisma/client';
import prisma from './db';
import { emitEvent } from './events';
import { notifyAdmin, notifyLeads, buildUserCard } from './notify';
import { detectGender } from './gender';

// --- DB Helpers ---

// --- DB Helpers ---

export async function ensureUserAndDialogue(username: string, name: string, accessHash?: string, source: 'INBOUND' | 'SCOUT' = 'INBOUND') {
    // 1. Find or Create User
    let user = await prisma.user.findFirst({
        where: { telegramId: username }
    });

    if (!user) {
        const inferredGender = detectGender(name);
        user = await prisma.user.create({
            data: {
                telegramId: username,
                username: username,
                firstName: name,
                status: 'NEW',
                gender: inferredGender,
                accessHash: accessHash || null
            }
        });
        console.log(`[DB] Created new user: ${username}${inferredGender !== 'UNKNOWN' ? ` (gender auto: ${inferredGender})` : ''}`);

    } else {
        // Update info if changed
        const dataToUpdate: any = {};
        if (user.firstName !== name) dataToUpdate.firstName = name;
        if (user.username !== username) dataToUpdate.username = username;
        if (accessHash && user.accessHash !== accessHash) dataToUpdate.accessHash = accessHash;
        // Auto-detect gender for existing user if unknown
        if (user.gender === 'UNKNOWN' && (name || user.firstName)) {
            const inferredGender = detectGender(name || user.firstName);
            if (inferredGender !== 'UNKNOWN') dataToUpdate.gender = inferredGender;
        }

        if (Object.keys(dataToUpdate).length > 0) {
            user = await prisma.user.update({
                where: { id: user.id },
                data: dataToUpdate
            });
        }
    }

    // 2. Find or Create Active Dialogue
    let dialogue = await prisma.dialogue.findFirst({
        where: { userId: user.id, status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' }
    });

    if (!dialogue) {
        dialogue = await prisma.dialogue.create({
            data: {
                userId: user.id,
                status: 'ACTIVE',
                source: source // Use provided source
            }
        });
        console.log(`[DB] Created new dialogue for user: ${username} (Source: ${source})`);
    }

    return { user, dialogue };
}

// Upgrade user status when we SEND them a message: NEW → CHAT, and CHAT → LEAD after 3 outgoing msgs
export async function upgradeStatusOnSend(dialogueId: number) {
    try {
        const dialogue = await prisma.dialogue.findUnique({
            where: { id: dialogueId },
            include: { user: true }
        });
        if (!dialogue?.user) return;
        const user = dialogue.user;

        if (user.status === 'NEW') {
            await prisma.user.update({ where: { id: user.id }, data: { status: 'CHAT' } });
            console.log(`[DB] ${user.username} NEW → CHAT (first DM sent)`);
            emitEvent({ type: 'user:status', userId: user.id, status: 'CHAT' });
            return;
        }

        if (user.status === 'CHAT') {
            // Count outgoing (OPERATOR/SIMULATOR) messages in this dialogue
            const outCount = await prisma.message.count({
                where: { dialogueId, sender: { in: ['OPERATOR', 'SIMULATOR'] } }
            });
            if (outCount >= 3) {
                const updatedUser = await prisma.user.update({ where: { id: user.id }, data: { status: 'LEAD' } });
                console.log(`[DB] ${user.username} CHAT → LEAD (3 messages sent)`);
                emitEvent({ type: 'user:status', userId: user.id, status: 'LEAD' });
                // Stats: mark recent OutreachAttempts (≤30 days) as LEAD-converted
                const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
                await prisma.outreachAttempt.updateMany({
                    where: { userId: user.id, becameLeadAt: null, sentAt: { gte: cutoff } },
                    data: { becameLeadAt: new Date() },
                }).catch(() => { });
                if (!user.notifiedLead) {
                    // Try to enrich with WM profile (from cache, no extra HTTP if already fetched)
                    let wm = null;
                    try {
                        const { getUserByTelegramId, isWMEnabled } = await import('./wmClient');
                        if (isWMEnabled() && updatedUser.telegramId) {
                            wm = await getUserByTelegramId(updatedUser.telegramId, 'profile');
                        }
                    } catch (_) { }
                    const card = buildUserCard(updatedUser, { title: '🔥 Новый ЛИД', wm });
                    await notifyLeads(card);
                    await prisma.user.update({ where: { id: user.id }, data: { notifiedLead: true } });
                }
            }
        }
    } catch (e) {
        console.error('[DB] upgradeStatusOnSend error:', e);
    }
}

export async function saveMessageToDb(dialogueId: number, sender: MessageSender, text: string, status: MessageStatus = 'SENT') {
    try {
        const [msg] = await prisma.$transaction([
            prisma.message.create({
                data: { dialogueId, sender, text, status }
            }),
            prisma.dialogue.update({
                where: { id: dialogueId },
                data: { updatedAt: new Date() }
            })
        ]);

        console.log(`[DB] Saved ${sender} message: "${text.substring(0, 20)}..."`);
        emitEvent({ type: 'dialogue:updated', dialogueId });
        return msg;
    } catch (e) {
        console.error(`[DB] Failed to save message: ${e}`);
        return null;
    }
}

// --- Actions ---

export async function sendDraftMessage(page: any, messageId: number, customText?: string) {
    console.log(`[Msg] Processing message ${messageId} via Userbot...`);
    const message = await prisma.message.findUnique({
        where: { id: messageId },
        include: { dialogue: { include: { user: true } } }
    });

    if (!message || !message.dialogue || !message.dialogue.user) {
        throw new Error('Message or User not found');
    }

    const username = message.dialogue.user.telegramId || message.dialogue.user.username; // Use telegramId as primary identifier if available
    const accessHash = message.dialogue.user.accessHash;

    if (!username) throw new Error('User has no username/ID');

    // Check if client is connected
    const client = getClient();
    if (!client || !client.connected) {
        throw new Error('Userbot client is not connected!');
    }

    const text = customText || message.text;

    try {
        let peer: any = username;

        // Use InputPeerUser if we have accessHash and it looks like an ID
        if (accessHash && /^\d+$/.test(username)) {
            // We need to construct InputPeerUser
            // GramJS Api is imported at top
            const userId = BigInt(username) as any;
            const hash = BigInt(accessHash) as any;
            peer = new Api.InputPeerUser({ userId, accessHash: hash });
            console.log(`[Msg] Sending to ID ${username} with AccessHash...`);
        } else {
            console.log(`[Msg] Sending to @${username}: "${text}"`);
        }

        await client.sendMessage(peer, { message: text });
        console.log(`[Msg] Sent approved message to ${username}`);

        // Status upgrade: NEW→CHAT, CHAT→LEAD on 3rd send
        const dialogueForMsg = await prisma.message.findUnique({ where: { id: messageId }, select: { dialogueId: true } });
        if (dialogueForMsg) await upgradeStatusOnSend(dialogueForMsg.dialogueId);

        // Update DB Status
        return await prisma.message.update({
            where: { id: messageId },
            data: { status: 'SENT', createdAt: new Date(), text: text }
        });

    } catch (e: any) {
        console.error(`[Msg] Failed to send message: ${e.message}`);
        throw e;
    }
}

// Refactored to use userId and GramJS directly
export async function sendMessageToUser(userId: number, text: string) {
    console.log(`[ACTION] sendMessageToUser called for userId: ${userId}`);
    const client = getClient();
    if (!client || !client.connected) {
        console.error('[ACTION] Client not connected');
        throw new Error('Telegram client not connected');
    }

    try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error(`User ID ${userId} not found`);
        console.log(`[ACTION] Found user in DB: ${user.telegramId} (@${user.username})`);

        // 1. Create Message Record First (Optimistic)
        // Find dialogue ID
        const dialogue = await prisma.dialogue.findFirst({ where: { userId } });
        const dialogueId = dialogue?.id || 0;

        const msg = await prisma.message.create({
            data: {
                dialogueId,
                sender: 'OPERATOR',
                text,
                status: 'SENT'
            }
        });

        // Update Dialogue LastUpdated timestamp to fix sorting
        await prisma.dialogue.update({
            where: { id: dialogueId },
            data: { updatedAt: new Date() }
        });

        console.log(`[ACTION] Created DB message: ${msg.id}`);

        // 2. Send via GramJS
        // Use telegramId (string) or username
        const target = user.telegramId;
        console.log(`[ACTION] Sending via GramJS to ${target}...`);

        await client.sendMessage(target, { message: text });
        console.log(`[ACTION] GramJS send successful`);

        // Status upgrade: NEW→CHAT, CHAT→LEAD on 3rd send
        if (dialogueId) await upgradeStatusOnSend(dialogueId);

        emitEvent({ type: 'message:sent', dialogueId, userId, text });
        return msg;
    } catch (e: any) {
        console.error('[ACTION] Failed to send message:', e);
        throw e;
    }
}

export async function createDraftMessage(dialogueId: number, text: string) {
    // ─ Replace, don't stack ─────────────────────────────────────────────────
    // If there are unsent drafts already, drop them — only ONE active draft
    // per dialogue keeps the operator UI clean.
    const [, msg] = await prisma.$transaction([
        prisma.message.deleteMany({
            where: { dialogueId, status: MessageStatus.DRAFT },
        }),
        prisma.message.create({
            data: {
                dialogueId,
                sender: 'SIMULATOR', // legacy enum
                text,
                status: MessageStatus.DRAFT,
            },
        }),
        prisma.dialogue.update({
            where: { id: dialogueId },
            data: { updatedAt: new Date() },
        }),
    ]);
    const dlg = await prisma.dialogue.findUnique({ where: { id: dialogueId }, select: { userId: true } });
    if (dlg) emitEvent({ type: 'message:draft', dialogueId, userId: dlg.userId, text });
    return msg;
}

// Stubs for compatibility
export async function openChat(page: any, username: string) { return username; }
export async function checkLogin(page: any) { return true; }
export async function startDialogue(page: any, username: string) { }

// --- Scouting ---
// --- Scouting ---
export async function scanChatForLeads(chatUsername: string, limit: number = 50, customKeywords?: string[], accessHash?: string) {
    console.log(`[Scout] Scanning ${chatUsername} for leads (limit: ${limit})...`);
    const client = getClient();
    if (!client || !client.connected) throw new Error('Client not connected');

    let messages: any[] = [];
    let inputPeer: any = chatUsername;

    try {
        // Check if chatUsername is a numeric ID (as string)
        if (/^-?\d+$/.test(chatUsername)) {
            try {
                // If accessHash is provided, construct InputPeer
                // Usually for channels/megagroups
                if (accessHash) {
                    const id = BigInt(chatUsername);
                    const hash = BigInt(accessHash);
                    // Try Channel first (most likely for scout)
                    inputPeer = new Api.InputPeerChannel({
                        channelId: id as any,
                        accessHash: hash as any
                    });
                } else {
                    // Try simple ID if possible (might fail if not in cache)
                    inputPeer = BigInt(chatUsername);
                }
            } catch (e) {
                console.warn(`[Scout] Could not convert ${chatUsername} to BigInt/InputPeer.`);
            }
        }

        // Telegram API max per call is 100 — paginate to reach the full limit
        const BATCH_SIZE = 100;
        let offsetId = 0;
        let fetched = 0;

        const fetchBatch = async (peer: any, offset: number): Promise<any[]> => {
            return await client.getMessages(peer, { limit: Math.min(BATCH_SIZE, limit - fetched), offsetId: offset });
        };

        try {
            while (fetched < limit) {
                const batch = await fetchBatch(inputPeer, offsetId);
                if (!batch || batch.length === 0) break; // No more messages
                messages.push(...batch);
                fetched += batch.length;
                offsetId = batch[batch.length - 1].id; // Next page starts from last ID
                console.log(`[Scout] Fetched ${fetched}/${limit} messages from ${chatUsername}...`);
                if (batch.length < BATCH_SIZE) break; // Last page, no more available
                // Small delay to avoid Telegram flood limits
                await new Promise(r => setTimeout(r, 300));
            }
        } catch (e: any) {
            if (e.message && e.message.includes('Could not find the input entity')) {
                console.log(`[Scout] Entity not found in cache. Refreshing dialogs...`);
                await client.getDialogs({ limit: 50 });
                // Retry with resolved entity
                try {
                    if (typeof inputPeer === 'bigint' || typeof inputPeer === 'number' || typeof inputPeer === 'string') {
                        const resolved = await client.getEntity(inputPeer as any);
                        if (resolved) inputPeer = resolved;
                    }
                    // Single batch retry after resolution
                    const batch = await fetchBatch(inputPeer, 0);
                    messages.push(...batch);
                } catch (retryErr) {
                    console.error(`[Scout] Retry failed:`, retryErr);
                    throw new Error(`Could not resolve chat ${chatUsername}. If using an ID, ensure you are joined to the chat or use a Username/Link.`);
                }
            } else {
                throw e;
            }
        }

        console.log(`[Scout] Total messages fetched: ${messages.length}`);


        const leads: any[] = [];

        // Broader Networking Keywords
        const defaultKeywords = [
            // Requests
            'ищу', 'нужен', 'надо', 'подскажите', 'куплю', 'заказать', 'help', 'need', 'want', 'клиент', 'трафик',
            // Offers / Intros
            'занимаюсь', 'работаю', 'проект', 'всем привет', 'меня зовут', 'разработчик', 'маркетолог', 'таргетолог', 'дизайнер', 'предлагаю', 'могу',
            // Context
            'сотрудничество', 'партнерство', 'нетворкинг', 'знакомство', 'бизнес'
        ];

        // If custom keywords provided, use them. Otherwise default.
        const keywords = (customKeywords && customKeywords.length > 0) ? customKeywords.map(k => k.toLowerCase()) : defaultKeywords;

        // Fetch admins to check statuses (optimization: fetch once)
        // Note: getting participants might be restricted in some channels/groups.
        // We will try to check sender properties first.

        for (const msg of messages) {
            if (!msg.message || !msg.sender) continue;

            // Skip bots and self
            const senderInfo = msg.sender as any;
            if (senderInfo.bot || msg.out) continue;

            const text = msg.message.toLowerCase();
            const isMatch = keywords.some(k => text.includes(k));

            if (isMatch) {
                const sender = await msg.getSender() as any;
                if (!sender) continue;

                // Attempt to detect Admin
                let isAdmin = false;
                try {
                    // 1. Check if the message is from the linked channel (in Discussion Groups)
                    // If msg.sender_id matches the chat's channel_id, it's an admin post.
                    // This is common in "Channel Discussion" groups.
                    if (sender.className === 'Channel' || sender.className === 'Chat') {
                        isAdmin = true;
                    }

                    // 2. Explicit Participant Check (if not already found)
                    if (!isAdmin) {
                        const participant = await client.invoke(
                            new Api.channels.GetParticipant({
                                channel: chatUsername,
                                participant: sender.id
                            })
                        );

                        const p = (participant as any).participant;
                        // Check for Admin or Creator
                        if (p && (
                            p.className === 'ChannelParticipantAdmin' ||
                            p.className === 'ChannelParticipantCreator' ||
                            (p.adminRights && p.adminRights.className !== 'ChatAdminRightsNone') // Extended check
                        )) {
                            isAdmin = true;
                        }
                    }
                } catch (e) {
                    // console.log('Checking admin failed:', e);
                }

                leads.push({
                    id: msg.id,
                    text: msg.message,
                    date: msg.date,
                    isAdmin: isAdmin,
                    sender: {
                        id: sender.id.toString(),
                        username: sender.username,
                        firstName: sender.firstName,
                        lastName: sender.lastName,
                        accessHash: sender.accessHash ? sender.accessHash.toString() : null
                    }
                });
            }

            // --- Poll Detection ---
            if (msg.media && msg.media.className === 'MessageMediaPoll' && msg.media.poll) {
                const poll = msg.media.poll;
                // Only process public polls
                if (!poll.publicVoters) {
                    console.log(`[Scout] Skipping anonymous poll: ${poll.question}`);
                    continue;
                }

                console.log(`[Scout] Found Public Poll: "${poll.question}"`);

                try {
                    // Fetch votes
                    // We need the InputPeer for the chat, which we have as `inputPeer` (variable from earlier)
                    // AND the message ID.

                    // The gramjs inputPeer might be an ID or an object. 
                    // `getMessages` used it, so it should be valid.

                    // We need to iterate over options or just get all?
                    // GetPollVotes requires an option if we want specific results, but maybe we can iterate or there is a helper?
                    // Api.messages.GetPollVotes gives votes for a specific option or all? 
                    // It takes `option?: Buffer`. If undefined, maybe all? No, documentation says filter by option usually.
                    // Let's iterate over `poll.answers`.

                    for (const answer of poll.answers) {
                        const optionText = answer.text;
                        const optionData = answer.option; // Buffer

                        // Pagination for votes? Limit is usually small in this context or we take first 50.
                        const votesRes = await client.invoke(
                            new Api.messages.GetPollVotes({
                                peer: inputPeer,
                                id: msg.id,
                                option: optionData,
                                limit: 50
                            })
                        ) as any;

                        // votesRes has .users (list of User) and .votes (list of MessageUserVote?)
                        // We are interested in the users.

                        if (votesRes && votesRes.users && votesRes.users.length > 0) {
                            for (const user of votesRes.users) {
                                // Avoid duplicates if we already added this user from text scan?
                                // Or just add them as a separate lead type.
                                // Let's add them.

                                // Filter out self/bots
                                if (user.bot || user.isSelf) continue;

                                leads.push({
                                    id: msg.id, // Use Poll Message ID
                                    text: `[POLL] Voted "${optionText}" in question: "${poll.question}"`,
                                    date: msg.date,
                                    isAdmin: false, // Hard to tell without checking participant, assume false or check later
                                    sender: {
                                        id: user.id.toString(),
                                        username: user.username,
                                        firstName: user.firstName,
                                        lastName: user.lastName,
                                        accessHash: user.accessHash ? user.accessHash.toString() : null
                                    }
                                });
                            }
                        }
                    }

                } catch (e) {
                    console.error(`[Scout] Failed to fetch poll votes:`, e);
                }
            }
        }

        console.log(`[Scout] Found ${leads.length} potential leads.`);

        // Update DB Count and Save History
        let scannedChat;
        try {
            scannedChat = await prisma.scannedChat.findFirst({
                where: {
                    OR: [
                        { username: chatUsername },
                        { link: { contains: chatUsername } }
                    ]
                }
            });

            if (scannedChat) {
                await prisma.scannedChat.update({
                    where: { id: scannedChat.id },
                    data: { lastLeadsCount: leads.length, scannedAt: new Date() }
                });

                // Save Scan History
                await prisma.scanHistory.create({
                    data: {
                        scannedChatId: scannedChat.id,
                        keywords: keywords.join(', '),
                        limit: limit,
                        leads: leads as any, // Cast to any for Json compatibility
                        leadsCount: leads.length
                    }
                });
                console.log(`[Scout] Saved scan history for chat ${scannedChat.id}`);
            } else {
                console.warn(`[Scout] ScannedChat not found for ${chatUsername}, skipping history save.`);
            }
        } catch (dbError) {
            console.warn(`[Scout] DB error during history save (non-critical):`, dbError);
        }

        // Fetch Chat Title

        // Fetch Chat Title
        let chatTitle = chatUsername;
        try {
            // We used inputPeer earlier.
            const entity = await client.getEntity(inputPeer);
            if (entity) {
                chatTitle = (entity as any).title || (entity as any).username || chatUsername;
            }
        } catch (e) {
            console.warn('[Scout] Failed to fetch chat title:', e);
        }

        return { leads, chatTitle };

    } catch (e: any) {
        console.error(`[Scout] Search failed: ${e.message}`);
        throw e;
    }
}

export async function sendReplyInChat(chatUsername: string, messageId: number, text: string) {
    const client = getClient();
    if (!client || !client.connected) throw new Error('Client not connected');

    try {
        await client.sendMessage(chatUsername, {
            message: text,
            replyTo: messageId
        });
        return { success: true };
    } catch (e: any) {
        console.error(`[Scout] Failed to reply in chat: ${e.message}`);
        throw e;
    }
}

export async function sendScoutDM(username: string, text: string, name: string, accessHash?: string) {
    // 1. Ensure User/Dialogue exists (so we track it in CRM)
    const { user, dialogue } = await ensureUserAndDialogue(username, name, accessHash, 'SCOUT');

    // 2. Send Message
    try {
        await sendMessageToUser(user.id, text);
        return { success: true, dialogueId: dialogue.id };
    } catch (e) {
        throw e;
    }
}
