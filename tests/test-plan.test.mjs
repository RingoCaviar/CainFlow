import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedFiles, loadManifest, selectTests, validateManifest, discoverTests } from '../scripts/test-plan.mjs';
import { commandsFor, executeCommands, parseOptions, createReportWriter } from '../scripts/run-tests.mjs';
import { chromiumNetworkArgs } from './helpers/browser-theme-fixture.mjs';

function removeTestDirectory(directory) {
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    rmSync(target, { recursive: true, force: true });
}

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
    const jsArgs = commands.flatMap(command => command.input ? JSON.parse(command.input) : command.args.filter(arg => arg.endsWith('.test.mjs')));
    assert.deepEqual(jsArgs.sort(), scheduled.filter(path => path.endsWith('.mjs')).sort());
    assert.ok(commands.find(command => command.label.startsWith('fast')).args.includes('--test-concurrency=4'));
    assert.ok(commands.find(command => command.label.startsWith('browser')).args.includes('--concurrency'));
    assert.equal(commands.find(command => command.label.startsWith('browser')).args.at(2), '2');
    const browserCommands = commands.filter(command => command.label.startsWith('browser'));
    assert.equal(browserCommands.length, 1, 'browser files share one continuous queue');
    assert.deepEqual(JSON.parse(browserCommands[0].input), plan.phases.browser);
    assert.ok(browserCommands[0].args.join(' ').length < 2000, 'file lists travel through stdin rather than the Windows command line');
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
    } finally { removeTestDirectory(directory); }
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


test('browser queue fills a free slot before a slow file ends and preserves file isolation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cainflow-test-queue-'));
    try {
        const events = join(directory, 'events.jsonl');
        const files = [500, 20, 20].map((duration, index) => {
            const file = join(directory, `case-${index}.test.mjs`);
            writeFileSync(file, `import test from 'node:test';import assert from 'node:assert/strict';import{appendFileSync}from'node:fs';
                assert.equal(globalThis.queueIsolation,undefined);globalThis.queueIsolation=true;
                const event=kind=>appendFileSync(${JSON.stringify(events)},JSON.stringify({kind,index:${index}})+'\\n');
                test('case ${index}',async()=>{event('start');await new Promise(r=>setTimeout(r,${duration}));event('end');});`);
            return file;
        });
        const progress = join(directory, 'progress.json');
        writeFileSync(progress, JSON.stringify({ complete: false, active: 'browser', results: [{ label: 'fast', passed: true }], notRun: ['Python tests'] }));
        execFileSync(process.execPath, ['scripts/run-browser-tests.mjs', '--concurrency', '2', '--progress-report', progress],
            { cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, input: JSON.stringify(files), encoding: 'utf8' });
        const records = readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(records.findIndex(event => event.kind === 'start' && event.index === 2)
            < records.findIndex(event => event.kind === 'end' && event.index === 0));
        let active = 0, maximum = 0;
        for (const event of records) { active += event.kind === 'start' ? 1 : -1; maximum = Math.max(maximum, active); }
        assert.equal(maximum, 2);
        const report = JSON.parse(readFileSync(progress, 'utf8'));
        assert.equal(report.complete, false, 'a finished browser queue cannot complete the entire regression');
        assert.deepEqual(report.notRun, ['Python tests']);
        assert.equal(report.fileProgress.browser.complete, true);
        assert.equal(report.fileProgress.browser.results.length, 3);
        assert.ok(report.fileProgress.browser.results.every(item => item.passed));
    } finally { removeTestDirectory(directory); }
});

test('browser queue records original file exits and runs remaining files once after failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cainflow-test-queue-errors-'));
    try {
        const progress = join(directory, 'progress.json'), marker = join(directory, 'marker.txt');
        const cache = join(directory, 'timings.json');
        const files = ['fail', 'exit', 'pass'].map(name => join(directory, `${name}.test.mjs`));
        writeFileSync(files[0], "import test from 'node:test';test('fails',()=>{throw new Error('original failure')});");
        writeFileSync(files[1], 'process.exit(7);');
        writeFileSync(cache, JSON.stringify({ version: 1, durations: { [files[1]]: 9999 } }));
        writeFileSync(files[2], `import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(marker)},'once');`);
        let failure;
        try { execFileSync(process.execPath, ['scripts/run-browser-tests.mjs', '--concurrency', '2', '--progress-report', progress, '--timings', cache],
            { cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, input: JSON.stringify(files), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch (error) { failure = error; }
        assert.equal(failure?.status, 1);
        assert.equal(readFileSync(marker, 'utf8'), 'once');
        const results = JSON.parse(readFileSync(progress, 'utf8')).fileProgress.browser.results;
        assert.equal(new Set(results.map(item => item.file)).size, 3);
        assert.equal(results.filter(item => !item.passed).length, 2);
        assert.equal(results.find(item => item.file === files[1]).exitCode, 7);
        assert.equal(JSON.parse(readFileSync(cache, 'utf8')).durations[files[1]], 9999, 'early exits do not replace successful timing history');
    } finally { removeTestDirectory(directory); }
});


test('duration cache changes ordering only and corrupt cache cannot remove coverage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cainflow-test-queue-cache-'));
    try {
        const events = join(directory, 'order.txt'), cache = join(directory, 'timings.json');
        const files = [0, 1, 2].map(index => {
            const file = join(directory, `case ${index}.test.mjs`);
            writeFileSync(file, `import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(events)},'${index}');`);
            return file;
        });
        writeFileSync(cache, JSON.stringify({ version: 1, durations: { [files[2]]: 900, [files[1]]: 100 } }));
        const run = () => execFileSync(process.execPath, ['scripts/run-browser-tests.mjs', '--concurrency', '1', '--timings', cache],
            { cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, input: JSON.stringify(files), stdio: ['pipe', 'pipe', 'pipe'] });
        run();
        assert.equal(readFileSync(events, 'utf8'), '210');
        assert.equal(Object.keys(JSON.parse(readFileSync(cache, 'utf8')).durations).length, 3);
        for (const invalid of ['{broken', 'null']) {
            writeFileSync(events, ''); writeFileSync(cache, invalid);
            run();
            assert.equal(readFileSync(events, 'utf8'), '012');
        }
        writeFileSync(events, '');
        execFileSync(process.execPath, ['scripts/run-browser-tests.mjs', '--concurrency', '1', '--timings', join(events, 'cache.json')],
            { cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, input: JSON.stringify(files), stdio: ['pipe', 'pipe', 'pipe'] });
        assert.equal(readFileSync(events, 'utf8'), '012', 'an unwritable optional timing cache cannot stop tests');
    } finally { removeTestDirectory(directory); }
});

test('runner sends browser file lists through stdin and forwards checkpoint paths', () => {
    const commands = commandsFor({ effectiveMode: 'full', changed: [], phases: { fast: [], integration: [], browser: ['tests/one.test.mjs'], python: [] } },
        parseOptions(['--report', 'report.json']));
    const browser = commands.find(command => command.input);
    assert.ok(browser.args.includes('--progress-report'));
    let observed;
    assert.equal(executeCommands([browser], (command, args, options) => { observed = options; return { status: 0 }; }, { log() {}, error() {} }), 0);
    assert.deepEqual(JSON.parse(observed.input), ['tests/one.test.mjs']);
    assert.deepEqual(observed.stdio, ['pipe', 'inherit', 'inherit']);
});


test('main report resets stale runs and retains browser checkpoints across later phases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cainflow-test-checkpoint-'));
    try {
        const path = join(directory, 'report.json');
        writeFileSync(path, JSON.stringify({ fileProgress: { stale: true } }));
        const save = createReportWriter(path, { effectiveMode: 'full' });
        save({ complete: false, active: 'browser', results: [], notRun: ['Python tests'] });
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).fileProgress, {});
        const browser = { complete: true, results: [{ file: 'failed.test.mjs', passed: false, exitCode: 7 }] };
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), fileProgress: { browser } }));
        save({ complete: false, active: 'Python tests', results: [{ label: 'browser', passed: false }], notRun: [] });
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).fileProgress.browser, browser);
        save({ complete: true, active: null, results: [{ label: 'browser', passed: false }, { label: 'Python tests', passed: true }], notRun: [] });
        const final = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(final.results[0].passed, false);
        assert.equal(final.fileProgress.browser.results[0].exitCode, 7);
    } finally { removeTestDirectory(directory); }
});


test('interrupting the browser queue retains completed files and pending work', async () => {
    const { spawn } = await import('node:child_process');
    const directory = mkdtempSync(join(tmpdir(), 'cainflow-test-queue-interrupt-'));
    let child;
    try {
        const progress = join(directory, 'progress.json');
        const files = [0, 1000, 0].map((duration, index) => {
            const file = join(directory, `case-${index}.test.mjs`);
            writeFileSync(file, `import test from 'node:test';test('case',async()=>new Promise(r=>setTimeout(r,${duration})));`);
            return file;
        });
        child = spawn(process.execPath, ['scripts/run-browser-tests.mjs', '--concurrency', '1', '--progress-report', progress],
            { cwd: root, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.end(JSON.stringify(files));
        let checkpoint;
        for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
            try { checkpoint = JSON.parse(readFileSync(progress, 'utf8')); } catch {}
            if (checkpoint?.fileProgress?.browser.results.length === 1 && checkpoint.fileProgress.browser.activeFiles.length === 1) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(checkpoint.fileProgress.browser.results.length, 1);
        assert.deepEqual(checkpoint.fileProgress.browser.notRun, [files[2]]);
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM'); await exited;
        const report = JSON.parse(readFileSync(progress, 'utf8'));
        assert.equal(report.complete, false);
        assert.equal(report.fileProgress.browser.complete, false);
        assert.equal(report.fileProgress.browser.results[0].passed, true);
        assert.deepEqual(report.fileProgress.browser.notRun, [files[2]]);
    } finally { child?.kill(); removeTestDirectory(directory); }
});
