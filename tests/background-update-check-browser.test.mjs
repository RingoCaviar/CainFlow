import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';
import { withAppBrowser } from './helpers/app-browser.mjs';
import { composite, contrastRatio, parseColor } from './helpers/browser-theme-fixture.mjs';

test('automatic update checks stay quiet while manual checks, failures and available updates retain feedback', async () => {
    const result = await runUiFixture('tests/fixtures/background-update-check.html');
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.pending, { requests: 0, toasts: 0, directToasts: 0 });
    assert.deepEqual(result.automatic, { requests: 1, status: 'latest', toasts: 0, notices: 0 });
    assert.deepEqual(result.manual, { messages: [
        { message: '正在检查更新...', type: 'info', duration: 0 },
        { message: '当前已是最新版本 (v1.0.0)', type: 'success', duration: 3000 }
    ], dismissals: 1, status: 'latest' });
    assert.deepEqual(result.available, { status: 'new_version', toast: { message: '发现新版本 v2.0.0', type: 'success', duration: 6000 },
        notice: [{ id: 'update-canvas', actions: ['更新通知', '下载更新'] }] });
    assert.equal(result.failed.status, 'error');
    assert.deepEqual(result.failed.types, ['error']);
    assert.ok(result.failed.error);
    assert.deepEqual(result.timeout, { retriedProxyDetection: true, status: 'error', types: ['warning', 'error'] });
    assert.deepEqual(result.disabled, { notScheduled: false, requests: 0, toasts: 0 });
});

test('release notes fill the available height and stay readable across all seven themes', { timeout: 30000 }, async () => {
    const themes = ['dark', 'light', 'paper', 'pro', 'pink', 'glass-dark', 'glass-light'];
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [], connections: [] }, async app => {
        const result = await app.evaluate(`(async () => {
            const { createUpdateManager } = await import('/js/features/update/update-manager.js');
            const body = '<h2>更新内容</h2><ul><li>优化大型画布</li></ul><p>查看 <a href="https://github.com/example/project">完整变更</a> 与 <code>workflows</code>。</p><blockquote>升级说明</blockquote><pre><code>CainFlow</code></pre>'
                + '<p>版本改进与问题修复。</p>'.repeat(30);
            const feed = '<feed>' + ['v2.0.0', 'v1.9.9'].map(tag =>
                '<entry><title>' + tag + '</title><updated>2026-11-11T00:00:00Z</updated><content><![CDATA[' + body + ']]></content></entry>'
            ).join('') + '</feed>';
            const manager = createUpdateManager({ appVersion: 'v1.0.0', githubRepo: 'example/project',
                getProxyHeaders: () => ({}), showToast() {}, renderGeneralSettings() {},
                fetchImpl: async () => new Response(feed) });
            await manager.checkUpdate(true, { showCanvasNotification: false });
            const modal = document.getElementById('modal-update');
            const region = modal.querySelector('.update-changelog-container');
            const releases = [...region.querySelectorAll('details')];
            const selectors = ['.update-tag-badge', '.update-date-text', '.update-release-title', '.update-release-date',
                '.update-release-body h2', '.update-release-body li', '.update-release-body a',
                '.update-release-body p code', '.update-release-body blockquote', '.update-release-body pre code'];
            return {
                active: modal.classList.contains('active'),
                expanded: releases.map(release => release.open),
                themes: ${JSON.stringify(themes)}.map(theme => {
                    document.documentElement.dataset.appTheme = theme;
                    return {
                        theme,
                        surface: getComputedStyle(region).backgroundColor,
                        expectedSurface: getComputedStyle(region).getPropertyValue('--panel-bg-soft').trim(),
                        text: selectors.map(selector => {
                            const element = modal.querySelector(selector);
                            const layers = [];
                            for (let layer = element; layer; layer = layer.parentElement) {
                                layers.unshift(getComputedStyle(layer).backgroundColor);
                            }
                            return { selector, foreground: getComputedStyle(element).color, layers };
                        })
                    };
                })
            };
        })()`);
        assert.equal(result.active, true);
        assert.deepEqual(result.expanded, [true, false]);
        for (const { theme, surface, expectedSurface, text } of result.themes) {
            assert.deepEqual(parseColor(surface), parseColor(expectedSurface), `${theme} release notes must use the theme surface`);
            for (const { selector, foreground, layers } of text) {
                for (const backdrop of [[0, 0, 0, 1], [255, 255, 255, 1]]) {
                    const background = layers.reduce((color, layer) => composite(parseColor(layer), color), backdrop);
                    const ratio = contrastRatio(composite(parseColor(foreground), background), background);
                    assert.ok(ratio >= 4.5, `${theme} ${selector} contrast ${ratio.toFixed(2)} must be at least 4.5:1`);
                }
            }
        }

        const measureLayout = async (width, height) => {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            return app.evaluate(`(() => {
                const panel = document.querySelector('.update-modal-panel');
                const notes = panel.querySelector('.update-changelog-container');
                notes.scrollTop = notes.scrollHeight;
                const { top, bottom } = panel.getBoundingClientRect();
                const buttons = [...panel.querySelectorAll('.modal-footer button:not(.hidden)')];
                return {
                    top, bottom,
                    notesHeight: notes.clientHeight,
                    notesScrolled: notes.scrollTop > 0,
                    buttonsInView: buttons.every(button => {
                        const rect = button.getBoundingClientRect();
                        return rect.width > 0 && rect.top >= top && rect.bottom <= bottom
                            && rect.left >= 0 && rect.right <= innerWidth;
                    })
                };
            })()`);
        };
        const tall = await measureLayout(1100, 880);
        const short = await measureLayout(1100, 440);
        const narrow = await measureLayout(360, 440);
        assert.ok(tall.top <= 44 && tall.bottom >= 836, 'the dialog uses the available canvas height');
        assert.ok(tall.notesHeight - short.notesHeight >= 300, 'the release notes grow with the viewport');
        for (const layout of [tall, short, narrow]) {
            assert.ok(layout.notesHeight > 0 && layout.notesScrolled, 'long release notes scroll inside a visible region');
            assert.equal(layout.buttonsInView, true, 'backup and download actions stay inside the viewport');
        }
    });
});
