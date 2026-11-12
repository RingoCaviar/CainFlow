import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('an older backend shows MCP restart guidance and retry reads the updated status', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false }, async ({ evaluate, waitFor }) => {
        await evaluate(`document.getElementById('btn-settings').click();
            document.getElementById('settings-tab-button-general').click();
            document.getElementById('general-settings-category-canvas').click();`);
        await waitFor("document.getElementById('btn-retry-canvas-mcp-status')?.checkVisibility()");
        assert.match(await evaluate("document.getElementById('canvas-mcp-status').textContent"), /重启 CainFlow/);
        assert.equal(await evaluate("document.getElementById('setting-canvas-mcp-enabled').disabled"), true);

        await evaluate(`window.hasMcpSettingsEndpoint = true;
            document.getElementById('btn-retry-canvas-mcp-status').click();`);
        await waitFor("!document.getElementById('setting-canvas-mcp-enabled').disabled");
        assert.match(await evaluate("document.getElementById('canvas-mcp-status').textContent"), /^已(?:开启|关闭)$/);
        assert.equal(await evaluate("document.getElementById('btn-retry-canvas-mcp-status').hidden"), true);
    }, { initScript: `
        const liveFetch = window.fetch.bind(window);
        window.fetch = (url, options) => {
            if (url === '/api/canvas-mcp/settings' && !window.hasMcpSettingsEndpoint) {
                return Promise.resolve(Response.json({ success: false, error: 'Not Found' }, { status: 404 }));
            }
            return liveFetch(url, options);
        };`
    });
});

test('canvas settings enable MCP, copy the local client configuration and turn access off', { timeout: 30000 }, async () => {
    const previousToken = process.env.CAINFLOW_MCP_TOKEN;
    delete process.env.CAINFLOW_MCP_TOKEN;
    try {
        await withAppBrowser({ autoCheckUpdatesOnLoad: false }, async ({ server, evaluate, waitFor }) => {
            await evaluate(`document.getElementById('btn-settings').click();
                document.getElementById('settings-tab-button-general').click();
                document.getElementById('general-settings-category-canvas').click();`);
            await waitFor(`document.getElementById('setting-canvas-mcp-enabled')?.closest('.toggle-switch').checkVisibility()
                && !document.getElementById('setting-canvas-mcp-enabled').disabled`);
            assert.equal(await evaluate("document.getElementById('setting-canvas-mcp-enabled').checked"), false);
            assert.equal(await evaluate("document.getElementById('canvas-mcp-connection-guide').hidden"), true);
            assert.deepEqual(await evaluate('window.copiedMcpConfigs'), []);

            await evaluate("document.getElementById('setting-canvas-mcp-enabled').click()");
            await waitFor(`document.getElementById('setting-canvas-mcp-enabled').checked
                && !document.getElementById('canvas-mcp-connection-guide').hidden
                && !document.getElementById('btn-copy-canvas-mcp-config').disabled`);
            assert.match(await evaluate("document.getElementById('canvas-mcp-connection-guide').textContent"), /mcpServers/);
            assert.deepEqual(await evaluate('window.copiedMcpConfigs'), []);

            await evaluate("document.getElementById('btn-copy-canvas-mcp-config').click()");
            await waitFor('window.copiedMcpConfigs.length === 1');
            const [rawConfig] = await evaluate('window.copiedMcpConfigs');
            const entry = JSON.parse(rawConfig).mcpServers['cainflow-canvas'];
            const token = entry.env.CAINFLOW_MCP_TOKEN;
            assert.ok(token.length >= 32);
            assert.ok(entry.command);
            assert.ok(entry.args.includes(new URL(server.baseUrl).port));
            assert.equal(await evaluate(`document.getElementById('general-settings').innerHTML.includes(${JSON.stringify(token)})`), false);

            await evaluate("document.getElementById('setting-canvas-mcp-enabled').click()");
            await waitFor(`!document.getElementById('setting-canvas-mcp-enabled').checked
                && !document.getElementById('setting-canvas-mcp-enabled').disabled
                && document.getElementById('canvas-mcp-connection-guide').hidden`);
        }, { initScript: `window.copiedMcpConfigs = [];
            Object.defineProperty(navigator.clipboard, 'write', { value: async ([item]) => {
                window.copiedMcpConfigs.push(await (await item.getType('text/plain')).text());
            } });
            Object.defineProperty(navigator.clipboard, 'writeText', { value: async text => window.copiedMcpConfigs.push(text) });` });
    } finally {
        if (previousToken !== undefined) process.env.CAINFLOW_MCP_TOKEN = previousToken;
    }
});
