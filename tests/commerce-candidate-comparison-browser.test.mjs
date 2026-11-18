import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser } from './helpers/app-browser.mjs';

async function capture(app, name) {
    if (!process.env.CAINFLOW_CANDIDATE_QA_DIR) return;
    await mkdir(process.env.CAINFLOW_CANDIDATE_QA_DIR, { recursive: true });
    const { data } = await app.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(process.env.CAINFLOW_CANDIDATE_QA_DIR, `${name}.png`), Buffer.from(data, 'base64'));
}

test('candidate comparison shows complete image bounds and uses the shared quantity control at desktop and narrow widths', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [], connections: [] }, async app => {
        await app.evaluate(`(async () => { window.candidateUiModule = await import('/js/features/ecommerce-image-set/commerce-shot-candidates-dialog.js');
            window.openCandidateUi = () => {
                const image = (width, height, fill, title) => 'data:image/svg+xml,' + encodeURIComponent(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'">'
                    + '<rect width="100%" height="100%" fill="'+fill+'"/><rect x="8" y="8" width="'+(width-16)+'" height="'+(height-16)+'" fill="none" stroke="white" stroke-width="12"/>'
                    + '<text x="50%" y="10%" text-anchor="middle" font-size="36" fill="white">TOP</text>'
                    + '<text x="50%" y="52%" text-anchor="middle" font-size="36" fill="white">'+title+'</text>'
                    + '<text x="50%" y="95%" text-anchor="middle" font-size="36" fill="white">BOTTOM</text></svg>');
                const images = { portrait: image(600, 1800, '#305a76', 'DETAIL 1:3'),
                    square: image(800, 800, '#4e7669', 'SQUARE'), landscape: image(1600, 900, '#99523c', 'LANDSCAPE'),
                    vertical: image(576, 1024, '#76538c', 'VERTICAL 9:16') };
                const draft = { prompt: '保留画面四周和完整商品', headline: '参考构图', body: '完整查看图片后选择候选' };
                const current = { key: 'current', assetKey: 'portrait', draft };
                const candidates = ['landscape', 'square', 'vertical', 'portrait'].map(key => ({ key, assetKey: key, draft }));
                let opener = document.getElementById('candidate-ui-opener');
                if (!opener) { opener = document.createElement('button'); opener.id = 'candidate-ui-opener'; opener.textContent = '查看候选'; document.body.append(opener); }
                return candidateUiModule.openCommerceShotCandidates({ documentRef: document, opener,
                    shot: { label: '详情图' }, current, candidates, getAssetUrl: key => images[key], candidateCount: 3,
                    openPreview: async (_images, _index, restore) => restore(),
                    onApply: async key => { window.appliedCandidate = key; },
                    onGenerate: async count => { window.requestedCandidateCount = count; return { current, candidates }; } });
            }; })()`);

        for (const width of [1100, 390]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 640 : 820, deviceScaleFactor: 1, mobile: false });
            for (const theme of ['light', 'dark']) {
                await app.evaluate(`document.documentElement.dataset.appTheme = '${theme}'; window.closeCandidateUi = openCandidateUi();`);
                await app.waitFor("[...document.querySelectorAll('.commerce-candidate-comparison img')].every(image => image.complete && image.naturalWidth > 0)");
                for (const candidate of ['landscape', 'square', 'vertical', 'portrait']) {
                    await app.evaluate(`document.querySelector('[data-commerce-candidate="${candidate}"]').click()`);
                    await app.waitFor("document.querySelector('[data-commerce-candidate-preview] img').complete");
                    const geometry = await app.evaluate(`(() => {
                        const dialog = document.getElementById('commerce-candidates-dialog');
                        const panel = dialog.querySelector('.dialog-style-1-panel').getBoundingClientRect();
                        const body = dialog.querySelector('.dialog-style-1-body');
                        return { viewportWidth: innerWidth, dialogWidth: dialog.getBoundingClientRect().width,
                            viewportHeight: innerHeight, panelTop: panel.top, panelBottom: panel.bottom,
                            bodyWidth: body.clientWidth, bodyContentWidth: body.scrollWidth,
                            images: [...dialog.querySelectorAll('.commerce-candidate-comparison img')].map(image => {
                                const bounds = image.getBoundingClientRect(), frame = image.parentElement.getBoundingClientRect();
                                return { fit: getComputedStyle(image).objectFit, left: bounds.left - frame.left,
                                    top: bounds.top - frame.top, right: frame.right - bounds.right, bottom: frame.bottom - bounds.bottom };
                            }) };
                    })()`);
                    await capture(app, `${theme}-${width}-${candidate}`);
                    assert.ok(geometry.dialogWidth <= geometry.viewportWidth, JSON.stringify(geometry));
                    assert.ok(geometry.panelTop >= 0 && geometry.panelBottom <= geometry.viewportHeight + 1, JSON.stringify(geometry));
                    assert.ok(geometry.bodyContentWidth <= geometry.bodyWidth + 1, JSON.stringify(geometry));
                    for (const bounds of geometry.images) {
                        assert.equal(bounds.fit, 'contain');
                        assert.ok([bounds.left, bounds.top, bounds.right, bounds.bottom].every(value => value >= -1),
                            `${theme} ${width} ${candidate}: image is clipped: ${JSON.stringify(bounds)}`);
                    }
                }
                const quantity = await app.evaluate(`(() => {
                    const field = document.querySelector('[data-commerce-candidate-quantity]');
                    field.focus();
                    return { shared: field.classList.contains('ui-select'), value: field.value,
                        options: [...field.options].map(option => option.value), label: field.labels[0]?.textContent,
                        focused: document.activeElement === field };
                })()`);
                assert.equal(quantity.shared, true);
                assert.equal(quantity.value, '3');
                assert.equal(quantity.options.length, 8);
                assert.match(quantity.label, /生成/);
                assert.equal(quantity.focused, true);
                const point = await app.evaluate(`(() => {
                    const bounds = document.querySelector('[data-commerce-candidate-quantity]').getBoundingClientRect();
                    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
                })()`);
                await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
                await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
                await app.waitFor("document.querySelector('[data-commerce-candidate-quantity]').matches(':open')");
                await capture(app, `${theme}-${width}-quantity-picker`);
                for (const [key, code, keyCode] of [['ArrowDown', 'ArrowDown', 40], ['Enter', 'Enter', 13]]) {
                    for (const type of ['keyDown', 'keyUp']) {
                        await app.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
                    }
                }
                assert.equal(await app.evaluate("document.querySelector('[data-commerce-candidate-quantity]').value"), '4');
                await app.evaluate("document.querySelector('[data-commerce-candidate-generate]').click()");
                await app.waitFor("!document.querySelector('[data-commerce-candidate-generate]').disabled");
                assert.equal(await app.evaluate('requestedCandidateCount'), 4);
                await app.evaluate('window.closeCandidateUi()');
                assert.equal(await app.evaluate("document.activeElement.id"), 'candidate-ui-opener');
            }
        }
    });
});
