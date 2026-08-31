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
    assert.doesNotMatch(source, /attachWorkflowDeskStateProjection|workflowDesk\.(?:migration|documentState)|\bmigration\s*=\s*Object\.freeze|freezeWorkflowTabProjection|\btabs:\s*Object\.freeze\(open\.map/);
    assert.doesNotMatch(readFileSync(`${root}/js/core/state.js`, 'utf8'), /activeWorkflow(?:Name|Id)/);
});

test('Workflow persistence adapters cannot write pending identity state', () => {
    const manager = readFileSync(`${root}/js/features/workflow/workflow-manager.js`, 'utf8');
    assert.doesNotMatch(manager, /\.identityPendingSave\s*=\s*false/);
    assert.doesNotMatch(manager, /\.documentSaved\(\)/);
});

test('save-all cannot reconstruct identity-bound saves from mutable Workflow tabs', () => {
    const manager = readFileSync(`${root}/js/features/workflow/workflow-manager.js`, 'utf8');
    const saveAll = manager.match(/async function saveAllOpenWorkflows\(\)[\s\S]*?\n    }/)?.[0] || '';
    assert.match(saveAll, /workflowDesk\.snapshot\(\)\.open/);
    assert.match(saveAll, /workflowDesk\.workflows\(workflowIds\)\.save\(\)/);
    assert.doesNotMatch(saveAll, /workflowDesk\.workflow\(|ensureWorkflowIdentity/);
});

test('Workflow tab presentation cannot store or decide authoritative running state', () => {
    const workflowSources = [
        'js/features/workflow/workflow-manager.js',
        'js/features/workflow/workflow-selection-adapter.js',
        'js/features/workflow/workflow-folder-policy.js'
    ].map((path) => readFileSync(`${root}/${path}`, 'utf8')).join('\n');
    assert.doesNotMatch(workflowSources, /\btab\??\.running\b|\btab\.running\s*=/);
});

test('Workflow manager cannot repair or allocate authoritative Workflow identity', () => {
    const manager = readFileSync(`${root}/js/features/workflow/workflow-manager.js`, 'utf8');
    assert.doesNotMatch(manager, /function ensureWorkflowIdentity|ensureUniqueWorkflowIdentities/);
    assert.doesNotMatch(manager, /\btab\.workflowId\s*=(?!=)|\btab\.identityPendingSave\s*=(?!=)/);
    assert.match(manager, /ensureWorkflowIdentity:\s*\(tab, data\)\s*=>\s*ensureWorkflowDocumentIdentity/);
});

test('committed Workflow presentation cannot retain pending explicit-save authority', () => {
    const adapter = readFileSync(`${root}/js/features/workflow/workflow-selection-adapter.js`, 'utf8');
    assert.doesNotMatch(adapter, /tab\.identityPendingSave\s*=/);
    assert.match(readFileSync(`${root}/js/features/workflow/workflow-desk.js`, 'utf8'), /delete workflow\.identityPendingSave/);
});

test('Workflow mutation rollback keeps its projection ownership token', () => {
    const manager = readFileSync(`${root}/js/features/workflow/workflow-manager.js`, 'utf8');
    assert.match(
        manager,
        /rollbackWorkflowMutation:\s*\(operation, projectionToken\)[\s\S]*?rollbackWorkflowMutationProjection\(operation, projectionToken\)/
    );
});

test('normalized Workflow references cannot fall back to mutable names', () => {
    const identity = readFileSync(`${root}/js/features/workflow/workflow-identity.js`, 'utf8');
    assert.doesNotMatch(identity, /typeof workflow === ['"]string['"]/);
    assert.doesNotMatch(identity, /state\?\.activeWorkflowName/);
    assert.doesNotMatch(identity, /ensureUniqueWorkflowIdentities|isWorkflowReferenceActive/);
});
