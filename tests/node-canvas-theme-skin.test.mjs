import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the application loads the node and canvas skin after theme styles', async () => {
    const entry = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    assert.ok(entry.indexOf('href="css/features/node-canvas-theme-skin.css"') > entry.indexOf('href="css/themes.css"'));
});

test('the node and canvas skin owns semantic shell, state, and port drawing roles', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    for (const role of ['--node-surface', '--node-border', '--node-border-selected', '--node-border-running', '--node-port-surface']) {
        assert.match(skin, new RegExp(`${role}:\\s*var\\(--`));
    }
    assert.match(skin, /[.]node-glass-bg\s*\{[\s\S]*?border:\s*1px solid var\(--node-border\)/);
    assert.match(skin, /[.]node[.]selected [.]node-glass-bg\s*\{[\s\S]*?var\(--node-border-selected\)/);
    assert.match(skin, /[.]node[.]running [.]node-glass-bg\s*\{[\s\S]*?var\(--node-border-running\)/);
    assert.match(skin, /[.]port-dot[.]connected\s*\{[\s\S]*?var\(--node-port-ring\)/);
});

test('node error popovers consume the semantic danger surface roles', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    const nodes = await readFile(new URL('../css/components/nodes.css', import.meta.url), 'utf8');
    for (const role of ['--node-danger-surface', '--node-danger-border', '--node-danger-text', '--node-danger-shadow']) {
        assert.match(skin, new RegExp(`${role}:\\s*`));
    }
    assert.match(nodes, /[.]node-concurrent-status-error-popover\s*\{[\s\S]*?background:\s*var\(--node-danger-surface\)/);
    assert.match(nodes, /[.]node-concurrent-status-error-popover\s*\{[\s\S]*?border:\s*1px solid var\(--node-danger-border\)/);
});

test('node action surfaces consume semantic danger and accent roles', async () => {
    const nodes = await readFile(new URL('../css/components/nodes.css', import.meta.url), 'utf8');
    assert.match(nodes, /--node-run-cancel-bg:\s*var\(--node-cancel-bg/);
    assert.match(nodes, /--node-run-cancel-shadow:\s*var\(--node-danger-shadow/);
    assert.match(nodes, /[.]node-clone-badge\s*\{[\s\S]*?background:\s*var\(--node-clone-bg/);
    assert.match(nodes, /[.]node-clone-badge\s*\{[\s\S]*?border:\s*1px solid var\(--node-clone-border/);
});

test('node status badges map running, success, and failure to semantic roles', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
    for (const role of ['--node-status-running-surface', '--node-status-success-surface', '--node-status-error-surface']) {
        assert.match(skin, new RegExp(`${role}:\\s*color-mix`));
    }
    assert.match(core, /[.]node[.]running [.]node-time-badge\s*\{[\s\S]*?var\(--node-status-running-surface\)/);
    assert.match(core, /[.]node[.]completed [.]node-time-badge\s*\{[\s\S]*?var\(--node-status-success-surface\)/);
    assert.match(core, /[.]node[.]error [.]node-time-badge\s*\{[\s\S]*?var\(--node-status-error-surface\)/);
});

test('the idle node badge consumes semantic status roles', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
    for (const role of ['--node-status-idle-text', '--node-status-idle-surface', '--node-status-idle-border']) {
        assert.match(skin, new RegExp(`${role}:\\s*`));
    }
    assert.match(core, /[.]node-time-badge\s*\{[\s\S]*?color:\s*var\(--node-status-idle-text\)/);
    assert.match(core, /[.]node-time-badge\s*\{[\s\S]*?background:\s*var\(--node-status-idle-surface\)/);
});

test('node section dividers consume the semantic border role', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
    assert.match(skin, /--node-section-divider:\s*color-mix/);
    assert.equal((core.match(/border-bottom:\s*1px solid var\(--node-section-divider\)/g) || []).length, 2);
});

test('canvas connection state drawing consumes semantic roles', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    const canvas = await readFile(new URL('../css/modules/03-canvas.css', import.meta.url), 'utf8');
    for (const role of ['--canvas-connection-selected', '--canvas-connection-insert-target', '--canvas-connection-preview']) {
        assert.match(skin, new RegExp(`${role}:\\s*`));
        assert.match(canvas, new RegExp(`var\\(${role.replaceAll('-', '\\-')}\\)`));
    }
});

test('canvas origin indicators consume semantic spatial roles', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    const canvas = await readFile(new URL('../css/modules/03-canvas.css', import.meta.url), 'utf8');
    for (const role of ['--canvas-origin-axis', '--canvas-origin-dot', '--canvas-origin-glow']) {
        assert.match(skin, new RegExp(`${role}:\\s*`));
        assert.match(canvas, new RegExp(`var\\(${role.replaceAll('-', '\\-')}\\)`));
    }
});

test('temporary connections consume the semantic pending-connection role', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    const canvas = await readFile(new URL('../css/modules/03-canvas.css', import.meta.url), 'utf8');
    assert.match(skin, /--canvas-connection-pending:\s*color-mix/);
    assert.match(canvas, /[.]temp-connection\s*\{[\s\S]*?stroke:\s*var\(--canvas-connection-pending\)/);
});

test('connection pulse animation consumes the semantic pending-connection role', async () => {
    const canvas = await readFile(new URL('../css/modules/03-canvas.css', import.meta.url), 'utf8');
    const pulse = canvas.slice(canvas.indexOf('@keyframes connection-pulse'), canvas.indexOf('.connection-path'));
    assert.match(pulse, /var\(--canvas-connection-pending\)/);
    assert.doesNotMatch(pulse, /var\(--accent-purple\)/);
});

test('connection flow arrows consume semantic flow roles', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    const canvas = await readFile(new URL('../css/modules/03-canvas.css', import.meta.url), 'utf8');
    assert.match(skin, /--canvas-connection-flow:\s*var\(--connection-flow-color/);
    assert.match(canvas, /[.]connection-flow-arrow\s*\{[\s\S]*?stroke:\s*var\(--canvas-connection-flow\)/);
    assert.match(canvas, /[.]connection-flow-arrow\s*\{[\s\S]*?var\(--canvas-connection-flow-glow\)/);
});

test('running node feedback consumes semantic border and glow roles', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
    assert.match(skin, /--node-running-glow-strong:\s*color-mix/);
    const running = core.slice(core.indexOf('@keyframes node-running-super-glow'), core.indexOf('.node.workflow-running-locked'));
    assert.match(running, /var\(--node-running-glow-strong\)/);
    assert.match(skin, /[.]node[.]running [.]node-glass-bg\s*\{[\s\S]*?border-color:\s*var\(--node-border-running\)/);
    assert.doesNotMatch(running, /#22d3ee|rgba\(34, 211, 238/);
});

test('completed node feedback consumes the semantic success glow role', async () => {
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    assert.match(skin, /--node-status-success-glow:\s*color-mix/);
    assert.match(skin, /[.]node[.]completed [.]node-glass-bg\s*\{[\s\S]*?box-shadow:\s*0 0 12px var\(--node-status-success-glow\)/);
});

test('the workbench does not override node drawing after the skin seam', async () => {
    const workbench = await readFile(new URL('../css/layout/workbench.css', import.meta.url), 'utf8');
    assert.doesNotMatch(workbench, /[.]node-glass-bg|[.]node-header|[.]port-dot/);
});

test('node core leaves shared shell paint and selected shell state to the skin', async () => {
    const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
    const sharedShellStart = core.indexOf('.node-glass-bg {', core.indexOf('.node.selected'));
    const sharedShell = core.slice(sharedShellStart, core.indexOf('.node-header,', sharedShellStart));
    assert.doesNotMatch(sharedShell, /(?:background|border|box-shadow|backdrop-filter)\s*:/);
    assert.doesNotMatch(core, /[.]node:hover [.]node-glass-bg\s*\{/);
    assert.doesNotMatch(core, /[.]node[.]selected [.]node-glass-bg\s*\{/);
});

test('node core leaves migrated shell-state paint to the skin', async () => {
    const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    for (const state of ['running', 'workflow-running-locked', 'completed', 'error']) {
        assert.doesNotMatch(core, new RegExp(`[.]node[.]${state} [.]node-glass-bg\\s*\\{`));
        assert.match(skin, new RegExp(`[.]node[.]${state} [.]node-glass-bg\\s*\\{`));
    }
    assert.doesNotMatch(core, /#canvas-container[.]is-zooming [.]node-glass-bg/);
    assert.match(skin, /--node-border-success:\s*var\(--accent-green\)/);
    assert.match(skin, /[.]node[.]completed [.]node-glass-bg\s*\{[\s\S]*?border-color:\s*var\(--node-border-success\)[\s\S]*?box-shadow:\s*0 0 12px var\(--node-status-success-glow\)/);
});

test('the skin owns the selected node outer ring', async () => {
    const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    const selectedRules = [...core.matchAll(/[.]node[.]selected\s*\{([^}]*)\}/g)].map((match) => match[1]);
    assert.ok(selectedRules.length > 0, 'node core must retain selected-state behavior');
    assert.ok(selectedRules.every((rule) => !/box-shadow\s*:/.test(rule)), 'node core must not paint the selected outer ring');
    assert.match(skin, /--node-selected-ring:\s*var\(--accent-primary\)/);
    assert.match(skin, /[.]node[.]selected\s*\{[\s\S]*?box-shadow:\s*0 0 0 calc\(2px \/ var\(--canvas-zoom, 1\)\) var\(--node-selected-ring\) !important/);
});

test('the skin owns batch-connection shell paint', async () => {
    const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    assert.doesNotMatch(core, /[.]node[.]batch-connection-source [.]node-glass-bg/);
    assert.doesNotMatch(core, /[.]node[.]batch-connection-source::before/);
    assert.doesNotMatch(core, /[.]node[.]batch-connection-source::after/);
    assert.doesNotMatch(core, /[.]node[.]batch-connection-dimmed\s*\{/);
    assert.match(skin, /--node-batch-source-border:\s*var\(--accent-green\)/);
    assert.match(skin, /--node-batch-dimmed-opacity:\s*0[.]38/);
    assert.match(skin, /[.]node[.]batch-connection-dimmed\s*\{/);
    assert.match(skin, /[.]node[.]batch-connection-source [.]node-glass-bg/);
    assert.match(skin, /[.]node[.]batch-connection-source::before/);
    assert.match(skin, /[.]node[.]batch-connection-source::after/);
});

test('the skin owns connection-gesture shell paint', async () => {
    const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
    const skin = await readFile(new URL('../css/features/node-canvas-theme-skin.css', import.meta.url), 'utf8');
    for (const state of ['connection-insert-candidate', 'connection-shake-armed', 'connection-shake-detached']) {
        assert.doesNotMatch(core, new RegExp(`[.]node[.]${state} [.]node-glass-bg\\s*\\{`));
        assert.match(skin, new RegExp(`[.]node[.]${state} [.]node-glass-bg\\s*\\{`));
    }
    for (const role of ['--node-connection-insert-border', '--node-connection-shake-border', '--node-connection-detached-border']) {
        assert.match(skin, new RegExp(`${role}:\\s*`));
    }
});

test('theme files leave migrated node and canvas DOM to the skin', async () => {
    const migratedSelectors = /[.](?:node\b|node-|port-dot\b|port-label\b|connection-path\b|temp-connection\b|origin-axis\b|origin-dot\b|connection-flow-arrow\b|connection-insert-preview-path\b|connection-insert-target\b)|#(?:canvas-container|connections-group)/;
    for (const themeId of ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink']) {
        const stylesheet = await readFile(new URL(`../css/themes/${themeId}.css`, import.meta.url), 'utf8');
        const rules = [...stylesheet.matchAll(/([^{}]+)\{[^{}]*\}/g)]
            .map((match) => match[1])
            .filter((selector) => /html\[data-app-theme/.test(selector))
            .filter((selector) => migratedSelectors.test(selector));
        assert.deepEqual(rules, [], `${themeId} must leave migrated node and canvas DOM to node-canvas-theme-skin.css`);
    }
});

test('the theme entry leaves node shell drawing to the skin', async () => {
    const themes = await readFile(new URL('../css/themes.css', import.meta.url), 'utf8');
    assert.doesNotMatch(themes, /[.]node-glass-bg/);
});
