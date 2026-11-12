import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser } from './helpers/app-browser.mjs';
import { key } from './helpers/image-first-integrated-fixture.mjs';

test('execution logs filter failures, open details and distinguish every status in light and dark themes', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, autoRetry: true }, async app => {
        const { evaluate, waitFor } = app;
        const filter = name => `document.querySelector('#log-drawer [data-log-filter=${name}]')`;
        const counts = `[${filter('all')}, ${filter('failed')}].map(button => Number(button.querySelector('[data-log-count]').textContent))`;
        const rows = "[...document.querySelectorAll('#log-list .log-item:not([hidden]) .log-summary-text')].map(title => title.textContent.trim())";
        const empty = "document.querySelector('#log-list .log-empty')?.textContent.trim()";
        await evaluate(`import('/js/app/bootstrap.js').then(async ({ bootstrapCainFlowApp }) => {
            const { registry } = await bootstrapCainFlowApp();
            window.fixtureLogApi = registry.logPanelApi;
            window.fixtureLogApi.clearLogs();
            window.fixtureLogApi.addLog('success', '套图已生成', '完成');
            window.fixtureLogApi.addLog('warning', '等待重试', '稍后重试');
            window.finishFixtureRequest = window.fixtureLogApi.logRequestToPanel(
                '发送图片请求', 'https://provider.invalid/v1/images', { fixture: 'request-details' }, { requestStatus: 'pending' }
            );
            document.getElementById('btn-logs').click();
        })`);

        assert.equal(await evaluate(`Boolean(${filter('failed')})`), true, 'the execution drawer offers a failure filter');
        assert.deepEqual(await evaluate(counts), [3, 0]);
        assert.equal(await evaluate(`${filter('all')}.getAttribute('aria-pressed')`), 'true');
        await evaluate(`${filter('failed')}.click()`);
        assert.equal(await evaluate(`${filter('failed')}.getAttribute('aria-pressed')`), 'true');
        assert.deepEqual(await evaluate(rows), []);
        assert.match(await evaluate(empty), /暂无失败记录/);

        await evaluate(`
            window.fixtureLogApi.addLog('error', '节点执行失败', 'Fixture node error');
            window.finishFixtureRequest('failed', { error: { message: 'Fixture request error' } });
            window.fixtureLogApi.logRequestToPanel('另一个图片请求', 'https://provider.invalid/v1/images', {});
        `);
        assert.deepEqual(await evaluate(counts), [5, 2], 'completing a request updates its existing row');
        assert.deepEqual((await evaluate(rows)).sort(), ['发送图片请求', '节点执行失败'].sort());
        assert.equal(await evaluate("document.querySelectorAll('#log-list .log-item.error:not([hidden])').length"), 2);

        const failedRow = "[...document.querySelectorAll('#log-list .log-item.error')].find(row => row.textContent.includes('发送图片请求'))";
        assert.match(await evaluate(`${failedRow}.querySelector('.log-type-tag').textContent`), /失败/);

        await waitFor(`${failedRow}.checkVisibility() &&
            document.getElementById('log-drawer').getBoundingClientRect().right <= window.innerWidth + 1`);
        assert.equal(await evaluate(`(() => {
            const row = ${failedRow};
            row.focus({ preventScroll: true });
            return document.activeElement === row;
        })()`), true);
        await key(app, 'Enter');
        await waitFor("document.getElementById('modal-error').classList.contains('active')");
        await evaluate("document.querySelector('#error-technical-details summary').click()");
        assert.equal(await evaluate("document.getElementById('error-technical-details').open"), true);
        const details = await evaluate("document.getElementById('error-modal-detail').textContent");
        assert.match(details, /provider\.invalid\/v1\/images/);
        assert.match(details, /request-details/);
        assert.match(details, /Fixture request error/);
        await evaluate("document.querySelector('#modal-error .modal-close').click()");
        assert.equal(await evaluate(`${filter('failed')}.getAttribute('aria-pressed')`), 'true');

        await evaluate(`${filter('all')}.click()`);
        assert.deepEqual((await evaluate(rows)).sort(), ['另一个图片请求', '节点执行失败', '发送图片请求', '等待重试', '套图已生成'].sort());
        await evaluate(`for (const status of ['pending', 'canceled', 'interrupted']) {
            window.fixtureLogApi.logRequestToPanel(status, 'https://provider.invalid/v1/images', {}, { requestStatus: status });
        }`);
        assert.equal(await evaluate("[...document.querySelectorAll('#log-list .log-type-tag')].every(badge => badge.querySelector('svg[aria-hidden=true]'))"),
            true, 'status icons complement the visible text labels');
        const statusColors = `(() => {
            const context = document.createElement('canvas').getContext('2d');
            return Object.fromEntries(['error', 'warning', 'success', 'info', 'pending', 'canceled', 'interrupted'].map(type => {
                const badge = document.querySelector('#log-list .log-item.' + type + ' .log-type-tag');
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = getComputedStyle(badge).color;
                context.fillRect(0, 0, 1, 1);
                return [type, Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)];
            }));
        })()`;
        for (const theme of ['paper', 'dark']) {
            await evaluate(`document.documentElement.dataset.appTheme = '${theme}'`);
            const colors = await evaluate(statusColors);
            const { error: [red, green, blue], warning, success, info, pending, canceled } = colors;
            assert.equal(new Set(Object.values(colors).map(color => color.join(','))).size, 7, `status colors are distinct in ${theme}`);
            assert.ok(red > green + 10 && red > blue + 10, `failures use red in ${theme}`);
            assert.ok(Math.max(...canceled) - Math.min(...canceled) <= 30, `canceled requests use a neutral foreground in ${theme}`);
            assert.ok(warning[0] > warning[1] + 5 && warning[1] > warning[2] + 5, `warnings use amber in ${theme}`);
            assert.ok(success[1] > success[0] + 5 && success[1] > success[2] + 5, `success uses green in ${theme}`);
            assert.ok(info[2] > info[0] + 5 && info[2] > info[1] + 5, `information uses blue in ${theme}`);
            assert.ok(pending[0] > pending[1] + 5 && pending[2] > pending[1] + 5, `requests in progress use purple in ${theme}`);
        }
        await evaluate("document.getElementById('btn-clear-logs').click()");
        assert.deepEqual(await evaluate(counts), [0, 0]);
        assert.match(await evaluate(empty), /暂无执行记录/);
    });
});
