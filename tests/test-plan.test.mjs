import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedFiles, loadManifest, selectTests, validateManifest, discoverTests } from '../scripts/test-plan.mjs';
import { commandsFor, executeCommands, parseOptions } from '../scripts/run-tests.mjs';
import { chromiumNetworkArgs } from './helpers/browser-theme-fixture.mjs';

test('isolated Chromium launches use the upstream Windows loopback workaround only on Windows', () => {
    assert.deepEqual(chromiumNetworkArgs('win32'), ['--disable-features=TcpPortRandomizationWin']);
    assert.deepEqual(chromiumNetworkArgs('linux'), []);
    assert.deepEqual(chromiumNetworkArgs('darwin'), []);
    const expected = process.platform === 'win32' ? ['--disable-features=TcpPortRandomizationWin'] : [];
    assert.deepEqual(chromiumNetworkArgs(), expected);
});

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = () => ({ groups: ['ui', 'update'], rules: [
    { pattern: '^js/ui/', groups: ['ui'] },
    { pattern: '^js/update/', groups: ['update'] },
    { pattern: '^js/core/', full: true, reason: 'Shared state' },
    { pattern: '^docs/', ignore: true },
], tests: {
    'tests/logic.test.mjs': { tier: 'fast', groups: ['ui'] },
    'tests/dialog.test.mjs': { tier: 'browser', groups: ['ui'] },
    'tests/restart.test.mjs': { tier: 'integration', groups: ['update'] },
    'tests/test_restart.py': { tier: 'python', groups: ['update'] },
} });

test('daily always retains the fast baseline and adds all affected tiers', () => {
    const plan = selectTests(fixture(), { changed: ['js/update/controller.js'] });
    assert.equal(plan.effectiveMode, 'daily');
    assert.deepEqual(plan.phases.fast, ['tests/logic.test.mjs']);
    assert.deepEqual(plan.phases.integration, ['tests/restart.test.mjs']);
    assert.deepEqual(plan.phases.python, ['tests/test_restart.py']);
    assert.deepEqual(plan.phases.browser, []);
});

test('manual groups add coverage, and changed test files retain their module peers', () => {
    const plan = selectTests(fixture(), { changed: ['tests/restart.test.mjs'], groups: ['ui'] });
    assert.equal(Object.values(plan.phases).flat().length, 4);
    assert.throws(() => selectTests(fixture(), { groups: ['typo'] }), /Unknown group/);
});

test('unknown or shared changes escalate even when a narrow group was supplied', () => {
    for (const path of ['js/core/state.js', 'new-subsystem/source.js']) {
        const plan = selectTests(fixture(), { changed: [path], groups: ['ui'] });
        assert.equal(plan.effectiveMode, 'full');
        assert.equal(Object.values(plan.phases).flat().length, 4);
        assert.equal(plan.reasons.length, 1);
    }
});

test('docs-only daily runs keep fast tests and explicit full includes every test', () => {
    assert.deepEqual(selectTests(fixture(), { changed: ['docs/help.md'] }).phases.browser, []);
    const plan = selectTests(fixture(), { mode: 'full' });
    assert.deepEqual(Object.values(plan.phases).flat().sort(), Object.keys(fixture().tests).sort());
});

test('test inventory rejects unregistered, stale and incorrectly classified tests', () => {
    const manifest = fixture(), paths = Object.keys(manifest.tests);
    assert.throws(() => validateManifest(manifest, [...paths, 'tests/new.test.mjs']), /Unregistered: tests\/new/);
    assert.throws(() => validateManifest(manifest, paths.slice(1)), /Missing files: tests\/logic/);
    manifest.tests['tests/test_restart.py'].tier = 'fast';
    assert.throws(() => validateManifest(manifest, paths), /Invalid test registration/);
});

test('repository inventory is exhaustive and full commands schedule each test exactly once', () => {
    const manifest = loadManifest(root), plan = selectTests(manifest, { mode: 'full' });
    const scheduled = Object.values(plan.phases).flat();
    assert.deepEqual(scheduled.sort(), discoverTests(root));
    assert.equal(new Set(scheduled).size, scheduled.length);
    const commands = commandsFor(plan, parseOptions([]));
    assert.equal(commands.filter(command => command.label === 'Python tests').length, 1);
    const jsArgs = commands.filter(command => command.args.includes('--test')).flatMap(command => command.args.filter(arg => arg.endsWith('.test.mjs')));
    assert.deepEqual(jsArgs.sort(), scheduled.filter(path => path.endsWith('.mjs')).sort());
    assert.ok(commands.find(command => command.label.startsWith('fast')).args.includes('--test-concurrency=4'));
    assert.ok(commands.find(command => command.label.startsWith('browser')).args.includes('--test-concurrency=2'));
    const browserCommands = commands.filter(command => command.label.startsWith('browser'));
    assert.equal(browserCommands.length, Math.ceil(plan.phases.browser.length / 20));
    assert.ok(browserCommands.every(command => command.args.filter(arg=>arg.endsWith('.test.mjs')).length<=20));
});

test('real impact rules include update desktop safety and force shared persistence to full', () => {
    const manifest = loadManifest(root);
    const update = selectTests(manifest, { changed: ['js/features/update/update-manager.js'] });
    assert.equal(update.effectiveMode, 'daily');
    assert.ok(update.phases.browser.includes('tests/desktop-update-restart-app-browser.test.mjs'));
    assert.ok(update.phases.python.includes('tests/test_update_restart.py'));
    const agent = selectTests(manifest, { changed: ['js/features/prompt-agent/prompt-agent-controller.js'] });
    for (const file of ['image-assistant-app-browser.test.mjs', 'image-first-integrated-app-browser.test.mjs', 'image-generation-status-dirty-app-browser.test.mjs']) {
        assert.ok(agent.phases.browser.includes(`tests/${file}`), `Agent's indirect app chain must include ${file}`);
    }
    for (const path of ['js/features/persistence/desktop-exit.js', 'js/features/ui/theme-controller.js', 'js/features/ui/image-first-canvas.js', 'js/features/ui/global-interactions.js', 'js/features/ui/ui-controller.js', 'tests/helpers/app-browser.mjs', 'scripts/test-groups.json']) {
        assert.equal(selectTests(manifest, { changed: [path] }).effectiveMode, 'full');
    }
});

test('literal source references supplement domain groups across module boundaries', () => {
    const manifest = loadManifest(root);
    for (const [source, testFile] of [
        ['js/features/ui/image-first-canvas.js', 'image-first-mutation-budget-app-browser.test.mjs'],
        ['js/features/settings/general-settings.js', 'cache-usage-media-distribution.test.mjs'],
        ['js/features/prompt-agent/prompt-agent-canvas-ui.js', 'theme-color-audit-browser.test.mjs'],
    ]) {
        const plan = selectTests(manifest, { changed: [source] });
        assert.ok(Object.values(plan.phases).flat().includes(`tests/${testFile}`), `${source} must select ${testFile}`);
    }
});

test('Git scope combines branch commits, staged changes, unstaged changes and untracked files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cainflow-test-plan-'));
    const git = args => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
    try {
        git(['init']);
        for (const file of ['branch.js', 'staged.js', 'working.js']) writeFileSync(join(directory, file), 'initial\n');
        git(['add', '.']);
        git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base']);
        writeFileSync(join(directory, 'branch.js'), 'committed\n');
        git(['add', '.']);
        git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'branch']);
        writeFileSync(join(directory, 'staged.js'), 'staged\n'); git(['add', 'staged.js']);
        writeFileSync(join(directory, 'working.js'), 'unstaged\n');
        writeFileSync(join(directory, 'new file.js'), 'untracked\n');
        assert.deepEqual(changedFiles(directory, 'HEAD~1'), ['branch.js', 'new file.js', 'staged.js', 'working.js']);
        // Staged content can differ even if the working tree returns to HEAD.
        writeFileSync(join(directory, 'staged.js'), 'initial\n');
        assert.ok(changedFiles(directory).includes('staged.js'));
        assert.throws(() => changedFiles(directory, 'missing-ref'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('runner reports failed phases without masking them with later success', () => {
    let calls = 0;
    const messages = [], report = { log: message => messages.push(message), error: message => messages.push(message) };
    assert.equal(executeCommands([{ label: 'fails', command: 'test', args: [] }, { label: 'passes', command: 'test', args: [] }], () => ({ status: calls++ === 0 ? 1 : 0 }), report), 1);
    assert.equal(calls, 2);
    assert.ok(messages.some(message => message.startsWith('FAIL fails')));
    assert.ok(messages.some(message => message.startsWith('PASS passes')));
    assert.equal(executeCommands([{ label: 'missing executable', command: 'test', args: [] }], () => ({ error: new Error('not found'), status: null }), report), 1);
    assert.ok(messages.includes('not found'));
});

test('runner publishes original exit details and marks interrupted runs incomplete', () => {
    const commands=[{label:'first',command:'test',args:[]},{label:'second',command:'test',args:[]}];
    const report={log(){},error(){}};
    let summary;
    assert.equal(executeCommands(commands,()=>({status:null,signal:'SIGINT'}),report,{onComplete:value=>summary=value}),1);
    assert.equal(summary.complete,false);
    assert.deepEqual(summary.notRun,['second']);
    assert.equal(summary.results[0].signal,'SIGINT');
    assert.equal(summary.results[0].exitCode,null);
    let calls=0;
    assert.equal(executeCommands(commands,()=>({status:calls++===0?7:0}),report,{onComplete:value=>summary=value}),1);
    assert.equal(summary.complete,true);
    assert.equal(summary.results[0].exitCode,7);
    assert.equal(summary.results[0].passed,false);
    assert.equal(calls,2,'failure does not skip or retry another phase');
    assert.equal(executeCommands(commands.slice(0,1),()=>({status:null,signal:'SIGTERM'}),report,{onComplete:value=>summary=value}),1);
    assert.equal(summary.complete,false,'interruption of the last phase is still incomplete');
    const progress=[];
    executeCommands(commands,()=>({status:0}),report,{onProgress:value=>progress.push(value)});
    assert.equal(progress[0].complete,false);
    assert.equal(progress[0].active,'first');
    assert.deepEqual(progress[0].notRun,['second']);
    assert.equal(progress[1].results.length,1);
    assert.equal(progress[1].results[0].passed,true);
});

test('CLI validates arguments and dry-run only reports the selected plan', () => {
    assert.equal(parseOptions(['--report','results/full.json']).reportPath,'results/full.json');
    assert.throws(() => parseOptions(['--base', 'HEAD~1', '--changed', 'a.js']), /not both/);
    assert.throws(() => parseOptions(['--fast-concurrency', '0']), /positive integer/);
    assert.throws(() => parseOptions(['--group']), /Missing value/);
    assert.throws(() => parseOptions(['--unknown']), /Unknown option/);
    const output = execFileSync(process.execPath, ['scripts/run-tests.mjs', '--changed', 'docs/help.md', '--dry-run'], { cwd: root, encoding: 'utf8' });
    const plan = JSON.parse(output);
    assert.equal(plan.effectiveMode, 'daily');
    assert.deepEqual(plan.phases.browser, []);
    assert.ok(plan.commands.length > 0);
});
