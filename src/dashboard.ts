// ── Active Dashboard — что готово / можно масштабировать / на каком этапе ──
// Roman: "нужно сделать активный дашборд что готово что можем масштабировать
// на каком этапе". Возвращает HTML с актуальным статусом всех систем.

import prisma from './db';
import { getOutreachQueueStatus } from './outreachQueue';
import { getNewUsersScannerStatus } from './newUsersScanner';
import { getPendingStatus } from './pendingSends';
import { getMeetupFollowupStatus } from './meetupFollowup';

type Stage = 'LIVE' | 'SCALING' | 'BUILDING' | 'WAITING' | 'IDEA';

interface Component {
    name: string;
    description: string;
    stage: Stage;
    metric?: string | null;
    nextStep?: string | null;
}

function stageLabel(s: Stage) {
    return ({
        LIVE: '🟢 LIVE',
        SCALING: '📈 МАСШТАБИРУЕМ',
        BUILDING: '🔨 СТРОИТСЯ',
        WAITING: '⏳ ЖДЁМ',
        IDEA: '💡 ИДЕЯ',
    } as const)[s];
}

async function buildComponents(): Promise<Component[]> {
    // Live metrics
    const totalUsers = await prisma.user.count();
    const activeAutoReply = await prisma.user.count({ where: { autoReply: true } });
    const totalDialogues = await prisma.dialogue.count();
    const sentMessages = await prisma.message.count({ where: { sender: 'OPERATOR', status: 'SENT' } });
    const todayMsgs = await prisma.message.count({
        where: {
            sender: 'OPERATOR',
            createdAt: { gt: new Date(Date.now() - 24 * 3600_000) },
        },
    });
    const learnedScenarios = await prisma.learnedScenario.count({ where: { isActive: true } }).catch(() => 0);
    const oq = getOutreachQueueStatus();
    const nus = getNewUsersScannerStatus();
    const pend = getPendingStatus();
    const meetup = getMeetupFollowupStatus();

    return [
        // ─── ВВОД (новые юзеры) ──────────────────────────────────────────────
        {
            name: 'newUsersScanner',
            description: 'Каждые 30 мин подбирает новых WM-юзеров, шлёт персонализированный welcome, ставит autoReply=true',
            stage: 'LIVE',
            metric: `всего отправлено: ${nus.totalSent} | last tick: ${nus.lastTickAt ? new Date(nus.lastTickAt).toLocaleString('ru') : '—'}`,
            nextStep: 'WM-команде: добавить createdSince фильтр + надёжный webhook',
        },
        {
            name: 'OutreachQueue',
            description: 'Каждые 20 мин re-outreach к WM-юзерам не контактированным >7 дней (10-22 МСК)',
            stage: 'LIVE',
            metric: `сегодня: ${oq.dailySent}/${oq.dailyCap} | сейчас: ${oq.workingNow ? 'работает' : 'спит'}`,
            nextStep: 'Сейчас лимит 36/день, можем поднять до 50 после verify-аккаунта',
        },
        {
            name: 'webhook user.created',
            description: 'Wave Match шлёт webhook при регистрации → мы шлём welcome через 7 мин',
            stage: 'WAITING',
            metric: 'webhook не доходит (Katya, Alex, Egor пропустили)',
            nextStep: 'WM-команде: проверить активную подписку + HMAC secret',
        },

        // ─── ОБРАБОТКА (диалог) ──────────────────────────────────────────────
        {
            name: 'GPT-replier (listener)',
            description: 'GPT-4o + Claude Sonnet 4.6 fallback. 15 принципов в системном промпте.',
            stage: 'LIVE',
            metric: `всего ${sentMessages} сообщений отправлено, ${todayMsgs} за 24ч`,
            nextStep: 'Anti-loop detection (как с ADZI1 — повторный ответ)',
        },
        {
            name: 'Match Engine',
            description: 'Скоринг offer↔need + hobby/interest overlap, top-3 кандидата в системный промпт',
            stage: 'LIVE',
            metric: 'работает на каждое входящее сообщение',
            nextStep: 'Proactive — 1 раз в день предлагать новые матчи существующим юзерам',
        },
        {
            name: 'External fetcher (Принцип #12)',
            description: 'Авто-парсит t.me/URL/handle при получении ссылки от юзера → инжектит в промпт',
            stage: 'LIVE',
            metric: 'wow-эффект подтверждён (ADZI1: бот сразу резюмировал сайт)',
        },
        {
            name: 'Voice transcription',
            description: 'Whisper транскрибирует voice messages → бот ведёт диалог как с текстом',
            stage: 'LIVE',
        },
        {
            name: 'Conversation Brain',
            description: 'Self-improving: ежедневный анализатор извлекает паттерны из диалогов + manual overrides',
            stage: 'LIVE',
            metric: `${learnedScenarios} активных паттернов`,
            nextStep: 'A/B тест применённых паттернов vs контрольная группа',
        },

        // ─── ВЫХОД (отправка / контроль) ─────────────────────────────────────
        {
            name: 'Multi-part outreach',
            description: '---SPLIT--- маркер режет ответ на отдельные сообщения с задержками 1.5-2.5с',
            stage: 'LIVE',
            metric: 'cold = 3 burst, warm = 1 message',
        },
        {
            name: 'Pending Sends Queue',
            description: 'Драфт → DM Роману с ✅/❌ ссылками → 10 мин auto-fire если не нажал',
            stage: 'LIVE',
            metric: `сейчас в очереди: ${pend.length}`,
        },
        {
            name: 'Contextual reactions (12 правил)',
            description: '🙏 спасибо, 🤝 deal, 🔥 fire, ⚡ short-yes, ❤ heart, 😁 lol, etc',
            stage: 'LIVE',
            metric: 'ставится только ПОСЛЕ успешной отправки ответа',
        },
        {
            name: 'Meetup Follow-up Cron',
            description: 'Через 22ч после welcome без ответа — приглашение на четверговую встречу',
            stage: 'LIVE',
            metric: `всего отправлено: ${meetup.totalSent}`,
            nextStep: 'Когда наберём 50+ интересов по темам — запустить первую встречу',
        },

        // ─── МАСШТАБ ─────────────────────────────────────────────────────────
        {
            name: 'Auto-reply pipeline',
            description: 'autoReply=true → бот отвечает мгновенно без ревью',
            stage: 'SCALING',
            metric: `${activeAutoReply}/${totalUsers} юзеров на autoReply`,
            nextStep: 'После накопления 100 диалогов — auto-tune промпта по результатам',
        },

        // ─── ОЖИДАНИЕ ВНЕШНИХ ЗАВИСИМОСТЕЙ ───────────────────────────────────
        {
            name: 'Match Credits / Paywall',
            description: '10 free → $20/мес=10 / $100/мес=100 / +3 за реферала',
            stage: 'WAITING',
            metric: 'TZ передан WM-команде (docs/TZ-credits-referrals-subscriptions.md)',
            nextStep: 'WM v1.4 API → подключаем за 1-2 дня',
        },
        {
            name: 'WM profile.username field в listUsers',
            description: 'Сейчас listUsers возвращает username=null, мы делаем 50 enrich-запросов',
            stage: 'WAITING',
            nextStep: 'WM-команде: включить username в WMUserListItem schema',
        },

        // ─── ИДЕИ / РОДМАП ───────────────────────────────────────────────────
        {
            name: 'Club-Leader Outreach Pipeline (B2B)',
            description: 'Personal outreach к 50 лидерам клубов (Бали/Москва/Дубай). Цель: 2 paying clubs/мес',
            stage: 'IDEA',
            nextStep: 'Сегментация: добавить `userType: club_leader` в WM схему',
        },
        {
            name: 'Speaker Network Activation',
            description: '200+ спикеров из PDF → personal pitch от @roman_arctur с revenue share',
            stage: 'IDEA',
            nextStep: 'Roman: список топ-10 кому пишем первым',
        },
        {
            name: 'Whitelabel Sales Funnel ($3k/мес)',
            description: 'Лендинг + демо-видео + календарь Романа. Целевая: клубы 100+ резидентов.',
            stage: 'IDEA',
        },
        {
            name: 'Wave Match Stars Program',
            description: 'Топ-10 активных/мес → бесплатный Premium + закрытый канал. Геймификация из PDF.',
            stage: 'IDEA',
        },
        {
            name: 'Industry Vertical Squads',
            description: 'Bali Entrepreneurs / AI / Real Estate — отдельные feed подборок',
            stage: 'IDEA',
            metric: 'критмасса: 8+ Bali, 4+ AI, 3+ Real Estate уже есть',
        },
    ];
}

export async function renderDashboardHTML(): Promise<string> {
    const components = await buildComponents();
    const grouped: Record<Stage, Component[]> = {
        LIVE: [], SCALING: [], BUILDING: [], WAITING: [], IDEA: [],
    };
    for (const c of components) grouped[c.stage].push(c);

    const order: Stage[] = ['LIVE', 'SCALING', 'WAITING', 'BUILDING', 'IDEA'];

    const sections = order.map(stage => {
        const items = grouped[stage];
        if (items.length === 0) return '';
        return `
        <section style="margin-bottom:32px">
            <h2 style="font-size:18px;color:#aaa;border-bottom:1px solid #333;padding-bottom:6px;margin-bottom:12px">
                ${stageLabel(stage)} <span style="color:#666;font-weight:400;font-size:13px">— ${items.length}</span>
            </h2>
            ${items.map(c => `
                <div style="background:#161616;border:1px solid #2a2a2a;border-radius:8px;padding:14px;margin-bottom:8px">
                    <div style="font-weight:600;color:#fff;margin-bottom:4px">${c.name}</div>
                    <div style="font-size:13px;color:#bbb;margin-bottom:6px;line-height:1.4">${c.description}</div>
                    ${c.metric ? `<div style="font-size:12px;color:#7dd3fc">📊 ${c.metric}</div>` : ''}
                    ${c.nextStep ? `<div style="font-size:12px;color:#fbbf24;margin-top:4px">→ ${c.nextStep}</div>` : ''}
                </div>
            `).join('')}
        </section>`;
    }).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Wave Match — Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0b0b0b;color:#eee;margin:0;padding:24px;max-width:920px;margin:0 auto}
  h1{font-size:24px;margin-bottom:4px}
  .sub{color:#888;font-size:13px;margin-bottom:24px}
</style></head>
<body>
<h1>🌊 Wave Match — Dashboard</h1>
<div class="sub">Обновлено: ${new Date().toLocaleString('ru')} • Авто-рефреш по F5</div>
${sections}
<div style="text-align:center;color:#555;font-size:11px;margin-top:32px">
  /admin/dashboard — Wave Chat ассистент @Mag_88888888
</div>
</body></html>`;
}
