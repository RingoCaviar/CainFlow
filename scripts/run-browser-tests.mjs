/** One native Node test pool: process isolation, bounded concurrency and per-file checkpoints. */
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const options = { concurrency: 2 };
for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--concurrency', '--progress-report', '--timings'].includes(key) || !value) throw new Error(`Invalid browser runner argument: ${key}`);
    options[{ '--concurrency': 'concurrency', '--progress-report': 'reportPath', '--timings': 'timingsPath' }[key]] = value;
}
if (!/^[1-9]\d*$/.test(String(options.concurrency))) throw new Error('Browser concurrency must be a positive integer');
const files = JSON.parse(readFileSync(0, 'utf8'));
if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !existsSync(file))
    || new Set(files.map(file => resolve(file))).size !== files.length) throw new Error('Browser file list must contain unique existing paths');
const byAbsolute = new Map(files.map(file => [resolve(file), file]));
const readJSON = path => {
    if (!path || !existsSync(path)) return {};
    try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
};
const cached = readJSON(options.timingsPath);
const durations = cached.version === 1 && cached.durations && typeof cached.durations === 'object' && !Array.isArray(cached.durations)
    ? { ...cached.durations } : {};
const durationFor = file => Number.isFinite(durations[file]) && durations[file] > 0 ? durations[file] : 0;
const ordered = [...files].sort((a, b) => durationFor(b) - durationFor(a));
const started = new Set(), finished = new Set(), active = new Set(), results = [];
const initialReport = readJSON(options.reportPath);
let cacheWarningShown = false;
const saveJSON = (path, value) => {
    if (!path) return;
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
};
function checkpoint(complete = false) {
    saveJSON(options.reportPath, { ...initialReport, complete: false, fileProgress: {
        ...initialReport.fileProgress,
        browser: { complete, concurrency: Number(options.concurrency), activeFiles: [...active],
            results: [...results], notRun: ordered.filter(file => !started.has(file)) }
    } });
}
function fileFor(data) {
    // Inner test events also have a file field; only the native file-wrapper name identifies a completed process.
    return typeof data.name === 'string' ? byAbsolute.get(resolve(data.name)) : null;
}
checkpoint();
const stream = run({ files: ordered, concurrency: Number(options.concurrency) });
stream.on('test:dequeue', data => {
    const file = fileFor(data);
    if (!file || started.has(file)) return;
    started.add(file); active.add(file); checkpoint();
});
stream.on('test:complete', data => {
    const file = fileFor(data);
    if (!file || finished.has(file)) return;
    started.add(file); finished.add(file); active.delete(file);
    const passed = data.details.passed === true;
    const durationMs = data.details.duration_ms;
    results.push({ file, passed, durationMs, exitCode: data.details.error?.exitCode ?? (passed ? 0 : 1),
        signal: data.details.error?.signal ?? null });
    if (!passed) process.exitCode = 1;
    // Failed/aborted early runs cannot replace the cost of a successful complete file.
    if (passed && Number.isFinite(durationMs)) durations[file] = durationMs;
    try { saveJSON(options.timingsPath, { version: 1, durations }); }
    catch (error) {
        if (!cacheWarningShown) console.error(`Browser timing cache unavailable: ${error.message}`);
        cacheWarningShown = true;
    }
    checkpoint();
    console.log(`[browser ${results.length}/${files.length}] ${passed ? 'PASS' : 'FAIL'} ${file} (${(durationMs / 1000).toFixed(1)}s)`);
});
stream.on('error', error => { process.exitCode = 1; console.error(error); checkpoint(); });
stream.on('end', () => {
    const complete = results.length === files.length;
    if (!complete) process.exitCode = 1;
    checkpoint(complete);
});
stream.pipe(new spec()).pipe(process.stdout);
