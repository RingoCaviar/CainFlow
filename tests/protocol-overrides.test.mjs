import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clearProtocolOverride,
    getProtocol,
    getProtocolOverride,
    getProtocolSnapshot,
    registerProtocol,
    setProtocolOverride
} from '../js/features/execution/protocols/index.js';
import { OpenaiProtocol } from '../js/features/execution/protocols/openai.js';
import {
    createProtocolOverrideExport,
    parseProtocolOverrideImport
} from '../js/features/execution/protocols/protocol-overrides.js';
import { importDeclarativeProtocolConfiguration } from '../js/features/settings/protocol-developer-panel.js';

test('built-in overrides preserve stable ID and merge independently from the baseline', () => {
    const base = getProtocol('openai');
    assert.ok(base);
    assert.equal(base.baseSchemaVersion, 1);
    assert.ok(base.baseRevision);
    const baseUrl = base.urlTemplate;
    setProtocolOverride('openai', {
        protocolId: 'openai',
        baseSchemaVersion: base.schemaVersion,
        revision: 7,
        config: { id: 'openai', label: 'OpenAI 覆盖', parameters: { prompt: { note: 'user note' } } }
    });

    const resolved = getProtocol('openai');
    assert.equal(resolved.id, 'openai');
    assert.equal(resolved.label, 'OpenAI 覆盖');
    assert.equal(resolved.urlTemplate, baseUrl);
    assert.equal(resolved.parameters.prompt.note, 'user note');
    assert.equal(getProtocolOverride('openai').revision, 7);
    clearProtocolOverride('openai');
    assert.equal(getProtocol('openai').label, OpenaiProtocol.label);
});

test('an override tied to an unknown future baseline remains read-only', () => {
    setProtocolOverride('openai', {
        protocolId: 'openai',
        baseSchemaVersion: 999,
        revision: 1,
        config: { id: 'openai', label: '未来配置' }
    });
    const resolved = getProtocol('openai');
    assert.equal(resolved.readOnly, true);
    assert.match(resolved.executionBlockedReason, /更新版本/);
    clearProtocolOverride('openai');
});

test('an override tied to a different baseline revision remains read-only', () => {
    const base = getProtocol('openai');
    setProtocolOverride('openai', {
        protocolId: 'openai',
        baseSchemaVersion: base.schemaVersion,
        baseRevision: 'different-baseline',
        revision: 2,
        config: { id: 'openai', label: '冲突配置' }
    });
    const resolved = getProtocol('openai');
    assert.equal(resolved.readOnly, true);
    assert.match(resolved.executionBlockedReason, /不兼容/);
    clearProtocolOverride('openai');
});

test('execution snapshots stay immutable after a later override', () => {
    registerProtocol(OpenaiProtocol);
    const snapshot = getProtocolSnapshot('openai');
    const originalLabel = snapshot.label;
    assert.equal(Object.isFrozen(snapshot), true);
    setProtocolOverride('openai', {
        protocolId: 'openai',
        baseSchemaVersion: 1,
        revision: 9,
        config: { id: 'openai', label: '后来编辑' }
    });
    assert.equal(snapshot.label, originalLabel);
    assert.equal(getProtocol('openai').label, '后来编辑');
    clearProtocolOverride('openai');
});

test('override envelopes round-trip protocol identity and metadata', () => {
    const base = getProtocol('openai');
    const envelope = createProtocolOverrideExport(base, {
        protocolId: 'openai',
        baseSchemaVersion: 1,
        baseRevision: 'baseline',
        revision: 3,
        config: { id: 'openai', label: '导出覆盖' }
    });
    const imported = parseProtocolOverrideImport(envelope);
    assert.equal(imported.protocolId, 'openai');
    assert.equal(imported.baseRevision, 'baseline');
    assert.equal(imported.config.label, '导出覆盖');
});

test('override imports accept non-video built-in declarative protocols', () => {
    const imported = importDeclarativeProtocolConfiguration(JSON.stringify({
        ...OpenaiProtocol,
        label: 'OpenAI 覆盖'
    }));
    assert.equal(imported.id, 'openai');
    assert.deepEqual(imported.taskTypes, ['chat', 'image']);
    assert.equal(imported.label, 'OpenAI 覆盖');
});
