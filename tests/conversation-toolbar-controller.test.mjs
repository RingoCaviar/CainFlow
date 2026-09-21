import assert from 'node:assert/strict';
import test from 'node:test';

import { createConversationToolbarController } from '../js/features/conversation/conversation-toolbar-controller.js';

function makeElement() {
    const listeners = new Map();
    return {
        textContent: '', title: '', hidden: false, disabled: false,
        addEventListener(type, callback) { listeners.set(type, callback); },
        click() { listeners.get('click')?.(); },
    };
}

test('Conversation toolbar exposes only conversation actions and returns to Canvas without stopping the run', async () => {
    const ids = [
        'conversation-toolbar-title', 'conversation-toolbar-status', 'conversation-toolbar-return-canvas',
        'conversation-toolbar-stop', 'conversation-toolbar-context', 'conversation-toolbar-new',
        'conversation-toolbar-list', 'conversation-toolbar-stage-nodes', 'conversation-toolbar-stage-history',
        'conversation-toolbar-record', 'conversation-toolbar-theme', 'conversation-toolbar-settings',
        'btn-theme-toggle', 'btn-settings'
    ];
    const elements = new Map(ids.map((id) => [id, makeElement()]));
    const calls = [];
    const toolbar = createConversationToolbarController({
        documentRef: { getElementById: (id) => elements.get(id) || null },
        workspaceModeController: { activate: (mode) => calls.push(`mode:${mode}`) },
        conversationWorkbenchController: {
            getToolbarSnapshot: () => ({ title: '镜头讨论', workflowLabel: '商业海报', stagedContextCount: 2, isRunning: true }),
            createConversation: () => calls.push('new'), togglePane: (pane) => calls.push(`pane:${pane}`),
            stageSelectedNodes: () => calls.push('nodes'), stageSelectedHistory: () => calls.push('history'),
            showExecutionRecord: () => calls.push('record'), stopCurrentRun: () => calls.push('stop')
        }
    });
    toolbar.init();

    assert.equal(elements.get('conversation-toolbar-title').textContent, '镜头讨论');
    assert.equal(elements.get('conversation-toolbar-context').textContent, '上下文 · 2');
    assert.equal(elements.get('conversation-toolbar-status').textContent, '生成中');
    assert.match(elements.get('conversation-toolbar-return-canvas').title, /继续在后台运行/);
    elements.get('conversation-toolbar-return-canvas').click();
    elements.get('conversation-toolbar-stop').click();
    elements.get('conversation-toolbar-stage-nodes').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['mode:canvas', 'stop', 'nodes']);
});
