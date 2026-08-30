import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = [
    'js/core/state.js',
    'js/features/workflow/workflow-desk.js',
    'js/features/workflow/workflow-manager.js',
    'js/features/workflow/workflow-runtime-manager.js'
].map((path) => readFileSync(`${root}/${path}`, 'utf8')).join('\n');

test('legacy Workflow activation and coordinator modules cannot return', () => {
    assert.equal(existsSync(`${root}/js/features/workflow/workflow-activation.js`), false);
    assert.equal(existsSync(`${root}/js/features/workflow/workflow-activation-coordinator.js`), false);
    assert.doesNotMatch(source, /createWorkflow(?:Activation|SessionActivator|TargetActivator)/);
});

test('temporary Workflow migration seams and active state pair cannot return', () => {
    assert.doesNotMatch(source, /attachWorkflowDeskStateProjection|workflowDesk\.(?:migration|documentState)|\bmigration\s*=\s*Object\.freeze/);
    assert.doesNotMatch(readFileSync(`${root}/js/core/state.js`, 'utf8'), /activeWorkflow(?:Name|Id)/);
});

test('normalized Workflow references cannot fall back to mutable names', () => {
    const identity = readFileSync(`${root}/js/features/workflow/workflow-identity.js`, 'utf8');
    assert.doesNotMatch(identity, /typeof workflow === ['"]string['"]/);
    assert.doesNotMatch(identity, /state\?\.activeWorkflowName/);
});
