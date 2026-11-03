import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { changedFiles, loadManifest, selectTests } from './test-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function parseOptions(args) {
    const options = { mode: 'daily', groups: [], changed: [], python: process.env.CAINFLOW_PYTHON || 'python', fastConcurrency: 4, browserConcurrency: 2 };
    for (let i = 0; i < args.length; i++) {
        const option = args[i];
        if (option === '--dry-run') { options.dryRun = true; continue; }
        if (option === '--help') { options.help = true; continue; }
        if (!['--mode', '--base', '--group', '--changed', '--python', '--fast-concurrency', '--browser-concurrency'].includes(option)) throw new Error(`Unknown option: ${option}`);
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
        if (option === '--group') options.groups.push(value);
        else if (option === '--changed') options.changed.push(value);
        else options[{ '--mode': 'mode', '--base': 'base', '--python': 'python', '--fast-concurrency': 'fastConcurrency', '--browser-concurrency': 'browserConcurrency' }[option]] = value;
    }
    for (const key of ['fastConcurrency', 'browserConcurrency']) {
        if (!/^[1-9]\d*$/.test(String(options[key]))) throw new Error(`${key} must be a positive integer`);
    }
    if (options.base && options.changed.length) throw new Error('Use --base or explicit --changed paths, not both');
    return options;
}

export function commandsFor(plan, options, repoRoot = root) {
    const commands = [{ label: 'Working tree whitespace', command: 'git', args: ['diff', '--check'] },
        { label: 'Staged whitespace', command: 'git', args: ['diff', '--cached', '--check'] }];
    if (options.base) commands.push({ label: 'Branch whitespace', command: 'git', args: ['diff', '--check', `${options.base}...HEAD`] });
    for (const path of plan.changed.filter(path => /\.(?:js|mjs)$/.test(path) && existsSync(`${repoRoot}/${path}`))) {
        commands.push({ label: `Syntax: ${path}`, command: process.execPath, args: ['--check', path] });
    }
    if (plan.effectiveMode === 'full' || plan.phases.python.length) commands.push({ label: 'Python compile', command: options.python, args: ['-m', 'compileall', '-q', 'server.py', 'backend'] });
    for (const tier of ['fast', 'integration', 'browser']) {
        const files = plan.phases[tier];
        // Bound Windows argument lengths without shell quoting or glob expansion.
        for (let start = 0; start < files.length; start += 100) commands.push({
            label: `${tier} ${start + 1}-${Math.min(start + 100, files.length)}/${files.length}`,
            command: process.execPath,
            args: ['--test', '--test-reporter=spec', `--test-concurrency=${tier === 'fast' ? options.fastConcurrency : options.browserConcurrency}`, ...files.slice(start, start + 100)],
        });
    }
    if (plan.phases.python.length) commands.push({ label: 'Python tests', command: options.python,
        args: ['-m', 'unittest', '-q', ...plan.phases.python.map(path => path.replace(/\.py$/, '').replaceAll('/', '.'))] });
    return commands;
}

export function executeCommands(commands, execute = spawnSync, report = console) {
    const results = [];
    for (const { label, command, args } of commands) {
        report.log(`\n==> ${label}`);
        const start = Date.now();
        const result = execute(command, args, { cwd: root, stdio: 'inherit', env: process.env });
        const passed = !result.error && result.status === 0;
        if (result.error) report.error(result.error.message);
        results.push({ label, passed, seconds: ((Date.now() - start) / 1000).toFixed(1) });
        // Continue failed phases for a complete report; never silently retry.
        if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') break;
    }
    report.log('\nPhase results:');
    for (const result of results) report.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.label} (${result.seconds}s)`);
    return results.every(result => result.passed) ? 0 : 1;
}

function main() {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
        console.log('Usage: node scripts/run-tests.mjs --mode daily|full [--base REF] [--group NAME] [--changed PATH] [--dry-run]\nRepeat --group to add coverage. --changed explicitly replaces Git detection; list every task change.\nDefaults: --fast-concurrency 4 --browser-concurrency 2. --python selects the backend interpreter.\nSee docs/testing.md and scripts/test-groups.json.');
        return;
    }
    const manifest = loadManifest(root);
    const changed = options.changed.length ? options.changed : changedFiles(root, options.base);
    const plan = selectTests(manifest, { ...options, changed });
    const commands = commandsFor(plan, options);
    if (options.dryRun) { console.log(JSON.stringify({ ...plan, scope: options.changed.length ? 'explicit task paths' : 'Git working tree plus optional branch base', commands }, null, 2)); return; }
    console.log(`Requested: ${plan.requestedMode}; running: ${plan.effectiveMode}. Groups: ${plan.groups.join(', ') || '(fast baseline)'}`);
    console.log(`Changed paths (${options.changed.length ? 'explicit scope' : 'Git detected'}):\n${changed.join('\n') || '(none; use --base for committed branch changes)'}`);
    for (const reason of plan.reasons) console.log(`Full regression: ${reason}`);
    process.env.CAINFLOW_PYTHON = options.python;
    process.exitCode = executeCommands(commands);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
