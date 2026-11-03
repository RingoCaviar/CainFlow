import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, relative } from 'node:path';

export function discoverTests(root) {
    const walk = directory => readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
        const path = `${directory}/${entry.name}`;
        return entry.isDirectory() ? walk(path) : /(?:\.test\.mjs$|\/test_[^/]+\.py$)/.test(path) ? [path] : [];
    });
    return walk('tests').sort();
}

export function validateManifest(manifest, discovered) {
    const registered = Object.keys(manifest.tests);
    const missing = discovered.filter(path => !registered.includes(path));
    const stale = registered.filter(path => !discovered.includes(path));
    if (missing.length || stale.length) throw new Error(`Test inventory mismatch. Register new tests and remove stale entries in scripts/test-groups.json.\nUnregistered: ${missing.join(', ')}\nMissing files: ${stale.join(', ')}`);
    for (const [path, entry] of Object.entries(manifest.tests)) {
        if (!['fast', 'integration', 'browser', 'python'].includes(entry.tier)
            || (path.endsWith('.py') !== (entry.tier === 'python'))
            || !entry.groups?.length || entry.groups.some(group => !manifest.groups.includes(group))) {
            throw new Error(`Invalid test registration: ${path}`);
        }
    }
    for (const rule of manifest.rules) {
        new RegExp(rule.pattern);
        if (!rule.full && !rule.ignore && !rule.groups?.length) throw new Error(`Empty impact rule: ${rule.pattern}`);
        if (rule.groups?.some(group => !manifest.groups.includes(group))) throw new Error(`Unknown group in rule: ${rule.pattern}`);
    }
}

// Include both sides of renames: removing an old module also has an impact.
export function changedFiles(root, base) {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean);
    const files = [
        ...git(['diff', '--name-only', '--no-renames', '-z', '--']),
        ...git(['diff', '--cached', '--name-only', '--no-renames', '-z', '--']),
        ...git(['ls-files', '--others', '--exclude-standard', '-z']),
    ];
    if (base) files.push(...git(['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`, '--']));
    return [...new Set(files)].sort();
}

export function selectTests(manifest, { mode = 'daily', changed = [], groups = [] } = {}) {
    if (!['daily', 'full'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
    for (const group of groups) if (!manifest.groups.includes(group)) throw new Error(`Unknown group: ${group}`);
    const selectedGroups = new Set(groups), reasons = [], directlyChanged = new Set();
    for (const raw of changed) {
        const path = raw.replaceAll('\\', '/').replace(/^\.\//, '');
        if (manifest.tests[path]) {
            directlyChanged.add(path);
            manifest.tests[path].groups.forEach(group => selectedGroups.add(group));
            continue;
        }
        const rules = manifest.rules.filter(rule => new RegExp(rule.pattern).test(path));
        if (!rules.length) reasons.push(`Unmapped change: ${path}`);
        for (const rule of rules) {
            if (rule.full) reasons.push(`${rule.reason}: ${path}`);
            rule.groups?.forEach(group => selectedGroups.add(group));
        }
    }
    const effectiveMode = mode === 'full' || reasons.length ? 'full' : 'daily';
    const normalizedChanges = new Set(changed.map(path => path.replaceAll('\\', '/').replace(/^\.\//, '')));
    const phases = { fast: [], integration: [], browser: [], python: [] };
    for (const [path, entry] of Object.entries(manifest.tests)) {
        if (effectiveMode === 'full' || entry.tier === 'fast' || directlyChanged.has(path)
            || entry.groups.some(group => selectedGroups.has(group))
            || entry.sources?.some(source => normalizedChanges.has(source))) phases[entry.tier].push(path);
    }
    for (const paths of Object.values(phases)) paths.sort();
    return { requestedMode: mode, effectiveMode, changed, groups: [...selectedGroups].sort(), reasons, phases };
}

export function loadManifest(root) {
    const manifest = JSON.parse(readFileSync(join(root, 'scripts/test-groups.json'), 'utf8'));
    validateManifest(manifest, discoverTests(root));
    const contents = new Map();
    for (const [path, entry] of Object.entries(manifest.tests)) {
        entry.sources = collectTestSources(root, path, contents);
    }
    return manifest;
}

// Supplement domain groups with literal source references in tests/fixtures.
// This is a safety net, not a complete dynamic dependency graph. Follow test
// helpers and HTML fixtures, but do not expand bootstrap into the entire app.
function collectTestSources(root, path, contents, seen = new Set()) {
    if (seen.has(path)) return [];
    seen.add(path);
    if (!contents.has(path)) {
        try { contents.set(path, readFileSync(join(root, path), 'utf8')); }
        catch { contents.set(path, ''); }
    }
    const sources = new Set();
    const pattern = /['"`]((?:\.{1,2}\/|\/)[\w./-]+\.(?:js|mjs|html)|(?:js|tests)\/[\w./-]+\.(?:js|mjs|html))(?:[?#][^'"`]*)?['"`]/g;
    for (const [, reference] of contents.get(path).matchAll(pattern)) {
        const absolute = reference.startsWith('.') ? resolve(root, dirname(path), reference) : resolve(root, reference.replace(/^\//, ''));
        const source = relative(root, absolute).replaceAll('\\', '/');
        if (source.startsWith('../')) continue;
        sources.add(source);
        if (source.startsWith('tests/')) collectTestSources(root, source, contents, seen).forEach(item => sources.add(item));
    }
    return [...sources];
}
