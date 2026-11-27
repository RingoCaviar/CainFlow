import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser } from './helpers/app-browser.mjs';
import { composite, contrastRatio, parseColor } from './helpers/browser-theme-fixture.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { key, nativeClick } from './helpers/image-first-integrated-fixture.mjs';

const session = { autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'source', type: 'ImageImport', x: 30, y: 80 }, { id: 'generate', type: 'ImageGenerate', x: 430, y: 80, width: 320 }], connections: [] };

const alignment = selector => `(() => {
    const context = document.createElement('canvas').getContext('2d');
    const pixels = value => parseFloat(value) || 0;
    return [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter(button => button.checkVisibility())
        .map(button => {
            const box = button.getBoundingClientRect();
            const icon = button.querySelector('svg');
            let x, y;
            if (icon) {
                const rect = icon.getBoundingClientRect();
                x = (rect.left + rect.right) / 2;
                y = (rect.top + rect.bottom) / 2;
            } else {
                const range = document.createRange();
                range.selectNodeContents(button);
                const rect = range.getBoundingClientRect();
                const style = getComputedStyle(button);
                context.font = style.font;
                const metrics = context.measureText(button.textContent.trim());
                x = (rect.left + rect.right) / 2;
                if (button.matches('.image-parameter-settings-entry')) {
                    const arrow = getComputedStyle(button, '::after');
                    if (arrow.display !== 'none' && arrow.content !== 'none') {
                        // Measure the center of the label and chevron as one flex group.
                        x += (pixels(style.columnGap) + pixels(arrow.marginLeft) + pixels(arrow.width)) / 2;
                    }
                }
                y = rect.top + metrics.fontBoundingBoxAscent
                    - (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
            }
            return {
                label: button.getAttribute('aria-label') || button.title || button.textContent.trim(),
                x: x - (box.left + box.right) / 2,
                y: y - (box.top + box.bottom) / 2
            };
        });
})()`;
const themes = ['dark', 'light', 'pink', 'pro', 'paper', 'glass-light', 'glass-dark'];
const imageBackgrounds = ['#fff', '#000', '#00ff00', '#ff0080', '#0055ff'];

async function assertPreviewBackdrop(app, theme) {
    const { overlay, stage } = await app.evaluate(`(() => ({
        overlay: getComputedStyle(document.querySelector('.fullscreen-overlay')).backgroundColor,
        stage: getComputedStyle(document.querySelector('.fullscreen-img-wrapper')).backgroundColor
    }))()`);
    const tint = parseColor(overlay);
    assert.ok(tint[3] > 0 && tint[3] < 1, `${theme}: the overlay dims the workspace through a translucent backdrop`);
    assert.equal(parseColor(stage)[3], 0, `${theme}: the surrounding image stage reveals the backdrop`);
    const lightWorkspace = parseColor('#fff');
    const darkWorkspace = parseColor('#171922');
    assert.ok(contrastRatio(lightWorkspace, composite(tint, lightWorkspace)) > 1, `${theme}: the backdrop darkens a light workspace`);
    assert.ok(contrastRatio(parseColor('#000'), composite(tint, darkWorkspace)) > 1.05, `${theme}: a dark workspace remains distinct from pure black`);
}

async function assertPreviewActionContrast(app, state) {
    const controls = await app.evaluate(`(async () => {
        const elements = [...document.querySelectorAll('.fullscreen-action-dock .preview-action-list > *, .fullscreen-action-dock > button')]
            .filter(element => element.checkVisibility());
        const read = element => {
            const { color, backgroundColor, backgroundImage } = getComputedStyle(element);
            return { label: element.title, color, backgroundColor, backgroundImage };
        };
        elements.forEach(read);
        await Promise.allSettled(elements.flatMap(element => element.getAnimations()).map(animation => animation.finished));
        return elements.map(read);
    })()`);
    assert.ok(controls.length >= 4, state);
    for (const { label, color, backgroundColor, backgroundImage } of controls) {
        assert.equal(backgroundImage, 'none', `${state}: ${label} uses a uniform backplate`);
        for (const imageColor of imageBackgrounds) {
            const surface = composite(parseColor(backgroundColor), parseColor(imageColor));
            const ratio = contrastRatio(composite(parseColor(color), surface), surface);
            assert.ok(ratio >= 4.5, `${state}: ${label} on ${imageColor} has ${ratio.toFixed(2)}:1 contrast`);
        }
    }
}

test('preview zoom controls center their visible glyphs and preserve zoom/fit actions', async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate(`(async()=>{const file=new File([await(await fetch('/tests/fixtures/reference-red.png')).blob()],'reference.png',{type:'image/png'}),transfer=new DataTransfer();transfer.items.add(file);const input=document.getElementById('source-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await app.waitFor("!!document.querySelector('#source-drop img')");
        await app.evaluate("document.querySelector('#source-drop img').dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:2}))");
        await app.waitFor("!!document.querySelector('.fullscreen-overlay img')");
        const controls = await app.evaluate(alignment('.fullscreen-overlay .preview-zoom-controls button'));
        assert.equal(controls.length, 3);
        for (const control of controls) assert.ok(Math.abs(control.x) <= 1 && Math.abs(control.y) <= 1, JSON.stringify(control));
        const before = await app.evaluate("document.querySelector('.fullscreen-overlay .fullscreen-img-wrapper img').style.transform");
        await app.evaluate("document.querySelector('.fullscreen-overlay .preview-zoom-in').click()");
        assert.notEqual(await app.evaluate("document.querySelector('.fullscreen-overlay .fullscreen-img-wrapper img').style.transform"), before);
        await app.evaluate("document.querySelector('.fullscreen-overlay .preview-zoom-fit').click()");
        assert.equal(await app.evaluate("new DOMMatrix(getComputedStyle(document.querySelector('.fullscreen-overlay .fullscreen-img-wrapper img')).transform).isIdentity"), true);
        if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
            await app.waitFor("getComputedStyle(document.querySelector('.fullscreen-overlay')).opacity==='1'");
            const clip = await app.evaluate("(()=>{const r=document.querySelector('.fullscreen-overlay .preview-zoom-controls').getBoundingClientRect();return {x:r.x-4,y:r.y-4,width:r.width+8,height:r.height+8,scale:2}})()");
            const shot = await app.send('Page.captureScreenshot', { format: 'png', clip });
            await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
            await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, 'preview-buttons.png'), Buffer.from(shot.data, 'base64'));
        }
        await app.evaluate("document.querySelector('.fullscreen-overlay .preview-action-reveal').click()");
        for (const control of await app.evaluate(alignment('.fullscreen-overlay .preview-action-dock :is(button,.fullscreen-close,.fullscreen-paint-btn)'))) {
            assert.ok(Math.abs(control.x) <= 1 && Math.abs(control.y) <= 1, JSON.stringify(control));
        }
        for (const theme of themes) {
            await app.evaluate(`document.documentElement.dataset.appTheme=${JSON.stringify(theme)}`);
            await assertPreviewBackdrop(app, theme);
            await assertPreviewActionContrast(app, theme);
        }
        await app.evaluate("document.documentElement.dataset.appTheme='dark'");
        await app.evaluate("document.querySelector('.fullscreen-overlay .fullscreen-close').click();document.getElementById('generate').click()");
        await app.evaluate("document.querySelector('#image-parameter-panel .image-parameter-settings-entry').click()");
        const otherControls = await app.evaluate(alignment('#canvas-navigation [data-nav=minus], #canvas-navigation [data-nav=plus], .image-parameter-settings-entry, [data-parameter-action=generate]'));
        assert.ok(otherControls.length >= 4);
        for (const control of otherControls) assert.ok(Math.abs(control.x) <= 1 && Math.abs(control.y) <= 1, JSON.stringify(control));
        await app.evaluate("document.getElementById('history-preview-modal').classList.remove('hidden');document.querySelector('#history-preview-modal .preview-action-dock').classList.add('is-expanded')");
        for (const theme of themes) {
            await app.evaluate(`document.documentElement.dataset.appTheme=${JSON.stringify(theme)}`);
            const historyControls = await app.evaluate(alignment('#history-preview-modal .preview-zoom-controls button, #history-preview-modal .preview-action-dock button'));
            assert.ok(historyControls.length >= 7);
            for (const control of historyControls) assert.ok(Math.abs(control.x) <= 1 && Math.abs(control.y) <= 1, `${theme}: ${JSON.stringify(control)}`);
        }
    });
});

test('crop instructions and drawing controls remain usable in a short, narrow preview', async () => {
    const reference = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
    await withAppBrowser(session, async app => {
        await uploadImageOriginal(app, 'source', reference);
        await app.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 340, deviceScaleFactor: 1, mobile: false });
        await app.waitFor('innerWidth === 390 && innerHeight === 340');
        await app.evaluate("document.querySelector('#source-drop img').dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:2}))");
        await app.waitFor("document.querySelector('.fullscreen-overlay')?.classList.contains('active')");
        await app.evaluate("document.querySelector('.fullscreen-action-dock .preview-action-reveal').focus()");
        await key(app, 'Enter');
        await app.waitFor("document.activeElement.matches('button.fullscreen-close')");
        await nativeClick(app, '.fullscreen-crop-btn');
        const cropLayout = await app.evaluate(`(() => {
            const dock = document.querySelector('.fullscreen-action-dock').getBoundingClientRect();
            const strip = document.querySelector('.fullscreen-crop-actions').getBoundingClientRect();
            const hint = document.querySelector('.fullscreen-crop-hint').getBoundingClientRect();
            return strip.top > dock.bottom && strip.left >= 0 && strip.right <= innerWidth
                && hint.top >= strip.top && hint.bottom <= strip.bottom
                && document.querySelector('.fullscreen-crop-btn').getAttribute('aria-pressed') === 'true';
        })()`);
        assert.equal(cropLayout, true, 'the crop row contains its instructions and leaves every dock action visible');
        await nativeClick(app, '.fullscreen-crop-cancel');
        await app.evaluate("document.querySelector('button.fullscreen-paint-btn').focus()");
        await key(app, 'Enter');
        await app.waitFor("document.querySelector('.painter-overlay')?.classList.contains('active')");
        await app.evaluate("document.querySelector('[data-tool=rect]').focus()");
        await key(app, 'Enter');
        assert.equal(await app.evaluate("document.querySelector('[data-tool=rect]').getAttribute('aria-pressed')"), 'true');
        assert.equal(await app.evaluate("document.querySelector('#painter-undo').disabled"), true);
        assert.equal(await app.evaluate("[...document.querySelectorAll('.painter-tool-btn')].every(button=>button.offsetHeight>=34)"), true);

        await app.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 26, y: 230, deltaX: 0, deltaY: 450 });
        await app.waitFor("document.querySelector('.painter-toolbar-left').scrollTop > 0");
        await app.evaluate("document.querySelector('#painter-custom-color').focus()");
        await key(app, 'Enter');
        await app.waitFor("document.activeElement.id === 'hue-wheel'");
        await key(app, 'ArrowRight');
        assert.equal(await app.evaluate("document.activeElement.getAttribute('aria-valuenow')"), '191');
        assert.equal(await app.evaluate(`(() => {
            const rail = document.querySelector('.painter-toolbar-left').getBoundingClientRect();
            const panel = document.querySelector('.painter-color-panel').getBoundingClientRect();
            return panel.left >= rail.right && panel.top >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight;
        })()`), true);
        for (const theme of ['light', 'pink']) {
            const { color, background } = await app.evaluate(`(() => {
                document.documentElement.dataset.appTheme = ${JSON.stringify(theme)};
                return {
                    color: getComputedStyle(document.querySelector('.painter-hsb-controls label')).color,
                    background: getComputedStyle(document.querySelector('.painter-color-panel')).backgroundColor
                };
            })()`);
            assert.ok(contrastRatio(parseColor(color), parseColor(background)) >= 4.5, `${theme}: drawing color controls stay readable`);
        }
        await key(app, 'Escape');
        assert.equal(await app.evaluate("document.activeElement.id === 'painter-custom-color' && !document.querySelector('.painter-color-panel').checkVisibility()"), true);
        await key(app, 'Escape');
        await app.waitFor("!document.querySelector('.painter-overlay')");
    });
});
