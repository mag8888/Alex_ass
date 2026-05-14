#!/usr/bin/env tsx
// Acceptance tests per docs/SETUP-aiass-final.md §4 v2 (9 tests).
// Run: DNAI_STUDIO_API_KEY=<key> npx tsx scripts/dnai-integration-test.ts

import {
    ping,
    review,
    memoryLoad,
    memorySave,
} from '../src/dnaiClient';

interface TestResult { name: string; ok: boolean; error?: string }

async function run() {
    const results: TestResult[] = [];
    const test = async (name: string, fn: () => Promise<void>) => {
        try { await fn(); results.push({ name, ok: true }); }
        catch (e: any) { results.push({ name, ok: false, error: e.message }); }
    };

    // === Health ===
    await test('1. Ping', async () => {
        const r: any = await ping();
        if (r.status !== 'ok') throw new Error('Status not ok');
        if (!r.capabilities?.modes?.includes('fallback')) throw new Error('No fallback mode');
    });

    // === Memory ===
    await test('2. Memory Moneo (>=8 entries)', async () => {
        const r = await memoryLoad('arthur', 'moneo-game');
        if (r.count < 8) throw new Error(`Expected >=8, got ${r.count}`);
    });

    await test('3. Memory Alma (>=9 entries)', async () => {
        const r = await memoryLoad('arthur', 'alma-product');
        if (r.count < 9) throw new Error(`Expected >=9, got ${r.count}`);
    });

    // === Review chain ===
    await test('4. Review GO/TWEAK on greeting', async () => {
        const r = await review({
            dialogueId: 't' + Date.now(),
            draft: 'Здравствуйте! Чтобы быстрее помочь — подскажите по какому направлению пишете?',
            recentMessages: [{ sender: 'USER', text: 'Привет', createdAt: new Date().toISOString() }],
            mode: 'fallback',
        });
        if (!['GO', 'TWEAK', 'GO_FALLBACK'].includes(r.verdict)) throw new Error(`Got ${r.verdict}`);
    });

    await test('5. Review TWEAK or NO-GO on «ты»', async () => {
        const r = await review({
            dialogueId: 't' + Date.now(),
            draft: 'Привет, ты что хотел?',  // нарушает «всегда Вы»
            recentMessages: [{ sender: 'USER', text: 'Здравствуйте', createdAt: new Date().toISOString() }],
            mode: 'fallback',
        });
        // Может быть TWEAK (Марк правит), NO-GO (Аида блокирует) или GO_FALLBACK (Аида недоступна)
        if (!['TWEAK', 'NO-GO', 'GO_FALLBACK'].includes(r.verdict)) throw new Error(`Got ${r.verdict}`);
    });

    await test('6. Review NO-GO on partnership ask', async () => {
        const r = await review({
            dialogueId: 't' + Date.now(),
            draft: 'Партнёрство стоит 20% от продаж',
            recentMessages: [{ sender: 'USER', text: 'Хочу партнёрство, какие условия?', createdAt: new Date().toISOString() }],
            clientContext: { stage: 'OFFER' },
            mode: 'fallback',
        });
        // Ожидаем NO-GO (Аида работает) или GO_FALLBACK (Аида недоступна — ваш Brain должен сам ловить)
        if (!['NO-GO', 'GO_FALLBACK'].includes(r.verdict)) throw new Error(`Got ${r.verdict}`);
        if (r.verdict === 'NO-GO') {
            if (!r.escalation || r.escalation.to !== '@roman_arctur') throw new Error('No escalation block');
        }
    });

    // === Idempotency ===
    await test('7. Idempotency (same key → same response)', async () => {
        const key = 'idem-' + Date.now();
        const r1 = await review({ dialogueId: 'd1', draft: 'Здравствуйте!', mode: 'fallback' }, key);
        const r2 = await review({ dialogueId: 'd1', draft: 'Здравствуйте!', mode: 'fallback' }, key);
        if (r1.metadata?.runId !== r2.metadata?.runId) throw new Error('Not idempotent');
    });

    // === Memory round-trip ===
    await test('8. Memory round-trip save → load', async () => {
        const content = 'Integration test ' + Date.now();
        await memorySave({ agent_id: 'arthur', project_key: 'integration-test', content, kind: 'lesson' });
        const r = await memoryLoad('arthur', 'integration-test');
        if (!r.items.some((i: any) => i.content === content)) throw new Error('Round-trip failed');
    });

    // === Skip review chain (instant fallback) ===
    await test('9. skipReviewChain returns GO_FALLBACK instantly', async () => {
        const start = Date.now();
        const r = await review({
            dialogueId: 't' + Date.now(),
            draft: 'Тестовый ответ',
            options: { skipReviewChain: true },
        });
        if (r.verdict !== 'GO_FALLBACK') throw new Error(`Got ${r.verdict}, expected GO_FALLBACK`);
        if (Date.now() - start > 2000) throw new Error(`Too slow: ${Date.now() - start}ms`);
    });

    // Report
    console.log('\n=== DNAI INTEGRATION TESTS ===');
    results.forEach(r => console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.error ? `: ${r.error}` : ''}`));
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
