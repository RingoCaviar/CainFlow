import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('Agent scroll-to-bottom preserves reading position and fits a narrow panel in each theme', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-scroll.html');
    assert.deepEqual(result, { light: true, dark: true, pink: true });
});

test('restored images wait for their part of the visible transcript and keep focus on refresh', async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false }, async ({ evaluate, send, waitFor }) => {
        await evaluate(`(async () => {
            const { registry } = await import('/js/app/bootstrap.js').then(module => module.bootstrapCainFlowApp());
            window.agentForMediaTest = registry.promptAgentController;
            window.agentAssetReads = [];
            const fetchOriginal = window.fetch;
            const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='), unit => unit.charCodeAt(0));
            window.fetch = (input, options) => {
                const url = new URL(String(input), location.href);
                const key = decodeURIComponent(url.pathname.split('/').at(-1));
                if (url.pathname.startsWith('/api/storage/assets/') && key.startsWith('media:history-fixture-')) {
                    agentAssetReads.push(key);
                    return Promise.resolve(new Response(png, { headers: { 'Content-Type': 'image/png' } }));
                }
                return fetchOriginal(input, options);
            };
            const resultMessage = id => ({ role: 'agent', text: id, promptPlan: { prompt: '测试结果' },
                runs: [{ runId: id, status: 'completed', persistenceStatus: 'saved', mediaAssetKeys: ['media:history-fixture-' + id] }] });
            agentForMediaTest.restoreWorkflow({
                archivedMessages: [resultMessage('early')],
                messages: [...Array.from({ length: 50 }, (_, index) => ({ role: 'agent', text: '中间消息 ' + index })), resultMessage('late')]
            });
            window.agentRunViews = [...document.querySelectorAll('#prompt-agent-messages .prompt-agent-run-state')];
            agentForMediaTest.refreshResults();
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
        })()`);
        assert.deepEqual(await evaluate('agentAssetReads'), [], 'closed panel has no asset reads');
        await evaluate('agentForMediaTest.open()');
        await waitFor("Boolean(agentRunViews[1]?.querySelector('img'))");
        assert.deepEqual(await evaluate('agentAssetReads'), ['media:history-fixture-late']);
        await evaluate("document.getElementById('prompt-agent-messages').focus({ preventScroll: true })");
        const home = { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, modifiers: 2 };
        await send('Input.dispatchKeyEvent', { ...home, type: 'keyDown' });
        await send('Input.dispatchKeyEvent', { ...home, type: 'keyUp' });
        await waitFor("Boolean(agentRunViews[0].querySelector('img'))");
        const result = await evaluate(`(async () => {
            const thumbnail = agentRunViews[0].querySelector('img');
            thumbnail.focus({ preventScroll: true });
            agentForMediaTest.refreshResults('late');
            agentForMediaTest.refreshResults();
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            return { retained: document.activeElement === thumbnail && thumbnail.isConnected, reads: agentAssetReads };
        })()`);
        assert.deepEqual(result, { retained: true, reads: ['media:history-fixture-late', 'media:history-fixture-early'] });
    });
});

test('restoring archived and current turns lays out the transcript as one batch', async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false }, async ({ send, evaluate }) => {
        await send('Performance.enable');
        const layoutCount = async () => (await send('Performance.getMetrics')).metrics.find(metric => metric.name === 'LayoutCount').value;
        await evaluate(`(async () => {
            window.agentForRestoreTest = (await import('/js/app/bootstrap.js').then(module => module.bootstrapCainFlowApp())).registry.promptAgentController;
            agentForRestoreTest.open();
        })()`);
        const before = await layoutCount();
        const result = await evaluate(`(async () => {
            const { normalizeCanvasPlan } = await import('/js/features/prompt-agent/prompt-agent-canvas-plan.js');
            const turns = Array.from({ length: 500 }, (_, index) => ({
                role: index % 2 ? 'agent' : 'user',
                text: '消息 ' + index
            }));
            turns.at(-1).canvasPlan = normalizeCanvasPlan({
                version: 1,
                steps: [{ id: 'note', type: 'Text', title: '恢复方案', parameters: { text: '计划文本' } }],
                connections: []
            }, { nodes: [], connections: [] });
            agentForRestoreTest.restoreWorkflow({ archivedMessages: turns.slice(0, 400), messages: turns.slice(400) });
            agentForRestoreTest.open();
            const transcript = document.getElementById('prompt-agent-messages');
            const apply = Array.from(transcript.querySelectorAll('.prompt-agent-canvas-actions button')).find(button => button.textContent === '仅应用');
            return {
                count: transcript.children.length,
                first: transcript.firstElementChild.querySelector('.prompt-agent-message-body').textContent,
                last: transcript.lastElementChild.querySelector('.prompt-agent-message-body').textContent,
                atBottom: Math.abs(transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop) <= 1,
                canApply: Boolean(apply && !apply.disabled)
            };
        })()`);
        const layouts = (await layoutCount()) - before;
        assert.deepEqual(result, { count: 500, first: '消息 0', last: '消息 499', atBottom: true, canApply: true });
        assert.ok(layouts <= 20, `500-turn restore triggered ${layouts} layouts`);
    });
});
