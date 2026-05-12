#!/usr/bin/env tsx
// Acceptance tests per docs/TZ-aiass-team.md §5 (8 tests).
// Run: DNAI_STUDIO_API_KEY=<key> npx tsx scripts/dnai-integration-test.ts

import {
    ping,
    review,
    memoryLoad,
    memorySave,
} from '../src/dnaiClient';

interface TestResult { name: string; ok: boolean; error?: string }

async function test(name: string, fn: () => Promise<void>, results: TestResult[]) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e: any) { results.push({ name, ok: false, error: e.message }); }
}

async function run() {
    const results: TestResult[] = [];

    await test('1. Ping', async () => {
        const r: any = await ping();
        if (r.status !== 'ok') throw new Error(`Status: ${r.status}`);
        if (!r.capabilities?.review?.includes('arthur')) throw new Error('Arthur not in capabilities');
    }, results);

    await test('2. Memory load — Moneo (≥8 items)', async () => {
        const r = await memoryLoad('arthur', 'moneo-game');
        if (r.count < 8) throw new Error(`Expected ≥8, got ${r.count}`);
        if (!r.items.some((i: any) => i.content?.includes('15 мая'))) throw new Error('No "15 мая" in items');
    }, results);

    await test('3. Memory load — Alma (≥9 items)', async () => {
        const r = await memoryLoad('arthur', 'alma-product');
        if (r.count < 9) throw new Error(`Expected ≥9, got ${r.count}`);
        if (!r.items.some((i: any) => i.content?.includes('1000'))) throw new Error('No "1000" in items');
    }, results);

    await test('4. Review GO/TWEAK — приветствие', async () => {
        const r = await review({
            dialogueId: 't' + Date.now(),
            draft: 'Здравствуйте! По какому продукту пишете: Moneo, Alma или Wave Match?',
            recentMessages: [{ sender: 'USER', text: 'Привет', createdAt: new Date().toISOString() }],
            clientContext: { stage: 'DISCOVERY' },
        });
        if (!['GO', 'TWEAK'].includes(r.verdict)) throw new Error(`Got ${r.verdict}`);
    }, results);

    await test('5. Review TWEAK ты→Вы', async () => {
        const r = await review({
            dialogueId: 't' + Date.now(),
            draft: 'Привет, ты что хотел?',
            recentMessages: [{ sender: 'USER', text: 'Здравствуйте', createdAt: new Date().toISOString() }],
            clientContext: { stage: 'DISCOVERY' },
        });
        if (r.verdict === 'GO') throw new Error('Should be TWEAK or NO-GO for ты');
    }, results);

    await test('6. Review NO-GO — партнёрство', async () => {
        const r = await review({
            dialogueId: 't' + Date.now(),
            draft: 'Условия партнёрства: 20% от продаж',
            recentMessages: [{ sender: 'USER', text: 'Хочу партнёрство', createdAt: new Date().toISOString() }],
            clientContext: { stage: 'OFFER' },
        });
        if (r.verdict !== 'NO-GO') throw new Error(`Got ${r.verdict}, expected NO-GO`);
        if (!r.escalation?.to?.includes('roman')) throw new Error('No escalation to Roman');
    }, results);

    await test('7. Idempotency — два вызова с тем же ключом', async () => {
        const key = 'idem-' + Date.now();
        const r1 = await review({ dialogueId: 'd1', draft: 'Здравствуйте!' }, key);
        const r2 = await review({ dialogueId: 'd1', draft: 'Здравствуйте!' }, key);
        if (r1.metadata?.runId !== r2.metadata?.runId) throw new Error(`runId differ: ${r1.metadata?.runId} vs ${r2.metadata?.runId}`);
    }, results);

    await test('8. Memory save → load round-trip', async () => {
        const content = 'Test entry ' + Date.now();
        await memorySave({ agent_id: 'arthur', project_key: 'integration-test', content, kind: 'lesson' });
        const r = await memoryLoad('arthur', 'integration-test');
        if (!r.items.some((i: any) => i.content === content)) throw new Error('Round-trip failed');
    }, results);

    console.log('=== INTEGRATION TEST RESULTS ===');
    results.forEach(r => console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.error ? `: ${r.error}` : ''}`));
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
