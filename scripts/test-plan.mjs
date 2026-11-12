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
            || !entry.groups?.length || entry.groups.some(group => !manifest.groups.includes(group))
            || (entry.full !== undefined && typeof entry.full !== 'boolean')
            || (entry.full === false && (typeof entry.reason !== 'string' || !entry.reason.trim()))
            || (entry.inferSources !== undefined && typeof entry.inferSources !== 'boolean')
            || (entry.sources !== undefined && (!Array.isArray(entry.sources)
                || entry.sources.some(source => typeof source !== 'string' || !source.trim())))) {
            throw new Error(`Invalid test registration: ${path}`);
        }
    }
    for (const rule of manifest.rules) {
        new RegExp(rule.pattern);
        if (rule.full !== undefined) throw new Error(`Impact rules cannot trigger full regression: ${rule.pattern}`);
        if (!rule.ignore && !rule.groups?.length && !rule.tests?.length) throw new Error(`Empty impact rule: ${rule.pattern}`);
        if (rule.groups?.some(group => !manifest.groups.includes(group))) throw new Error(`Unknown group in rule: ${rule.pattern}`);
        if (rule.tests?.some(path => !Object.hasOwn(manifest.tests, path))) throw new Error(`Unregistered test in rule: ${rule.pattern}`);
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
    const changedPaths = [...new Set(changed.map(normalizePath))].sort();
    const tests = Object.entries(manifest.tests);
    const selected = new Set();
    const uncovered = [];
    const suggestedGroups = new Set();
    const rules = manifest.rules.map(rule => ({ ...rule, pattern: new RegExp(rule.pattern) }));

    if (mode === 'daily') {
        for (const path of changedPaths) {
            if (Object.hasOwn(manifest.tests, path)) {
                selected.add(path);
                continue;
            }
            const matchingRules = rules.filter(rule => rule.pattern.test(path));
            const linked = tests.filter(([, entry]) => entry.sources?.includes(path)).map(([file]) => file);
            for (const rule of matchingRules) linked.push(...(rule.tests || []));
            if (!linked.length && !matchingRules.some(rule => rule.ignore)) {
                uncovered.push(path);
                for (const rule of matchingRules) rule.groups?.forEach(group => suggestedGroups.add(group));
            }
            linked.forEach(file => selected.add(file));
        }
    }

    const phases = { fast: [], integration: [], browser: [], python: [] };
    for (const [file, entry] of tests) {
        if ((mode === 'full' && entry.full !== false) || selected.has(file)
            || entry.groups.some(group => groups.includes(group))) phases[entry.tier].push(file);
    }
    for (const paths of Object.values(phases)) paths.sort();
    return { requestedMode: mode, effectiveMode: mode, changed: changedPaths, groups: [...new Set(groups)].sort(),
        uncovered, suggestedGroups: [...suggestedGroups].sort(), phases };
}

const normalizePath = path => path.replaceAll('\\', '/').replace(/^\.\//, '');

export function loadManifest(root) {
    const manifest = JSON.parse(readFileSync(join(root, 'scripts/test-groups.json'), 'utf8'));
    validateManifest(manifest, discoverTests(root));
    const contents = new Map();
    for (const [path, entry] of Object.entries(manifest.tests)) {
        const inferred = entry.inferSources === false ? [] : collectTestSources(root, path, contents);
        entry.sources = [...new Set([...(entry.sources || []).map(normalizePath), ...inferred])];
    }
    return manifest;
}

// Follow literal source references in tests, helpers and fixtures. Dynamic
// dependencies can be registered without expanding bootstrap into the entire app.
function collectTestSources(root, path, contents, seen = new Set()) {
    if (seen.has(path)) return [];
    seen.add(path);
    if (!contents.has(path)) {
        try { contents.set(path, readFileSync(join(root, path), 'utf8')); }
        catch { contents.set(path, ''); }
    }
    const sources = new Set();
    const content = contents.get(path);
    const pattern = /['"`]((?:(?:\.{1,2}|js|css|tests|scripts|backend|\.github)?\/)[\w./-]+\.(?:[cm]?js|css|html|json|py|ps1|ya?ml|bat)|(?:index\.(?:js|css|html)|server\.py))(?:[?#][^'"`]*)?['"`]/g;
    for (const [, reference] of content.matchAll(pattern)) {
        const absolute = reference.startsWith('.') ? resolve(root, dirname(path), reference) : resolve(root, reference.replace(/^\//, ''));
        const source = relative(root, absolute).replaceAll('\\', '/');
        if (source.startsWith('../')) continue;
        sources.add(source);
        if (source.startsWith('tests/')) collectTestSources(root, source, contents, seen).forEach(item => sources.add(item));
    }
    if (path.endsWith('.py')) {
        const imports = /^\s*(?:from\s+(backend(?:\.\w+)*|server|canvas_mcp)\s+import\s*(\([^)]*\)|[^\r\n]+)|import\s+(backend(?:\.\w+)*|server|canvas_mcp)\b)/gm;
        for (const [, module, names, direct] of content.matchAll(imports)) {
            const stem = (module || direct).replaceAll('.', '/');
            sources.add(`${stem}.py`);
            if (names) {
                for (const imported of names.replace(/^\(|\)$/g, '').split(',')) {
                    const name = imported.trim().match(/^\w+/)?.[0];
                    if (name) sources.add(`${stem}/${name}.py`);
                }
            }
        }
    }
    return [...sources];
}
