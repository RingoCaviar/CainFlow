import test from 'node:test';
import { verifyScreenshotMatrix } from './helpers/browser-theme-fixture.mjs';

const fixturePath = new URL('./fixtures/menu-dialog-theme-surface.html', import.meta.url);
const themeIds = ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink'];

test('seven-theme menu and dialog matrix matches approved screenshots', () => {
    verifyScreenshotMatrix({
        fixtureUrl: fixturePath,
        baselineDirectoryUrl: new URL('./visual-baselines/menu-dialog-theme-surface/', import.meta.url),
        profilePrefix: 'cainflow-menu-dialog-screenshots-',
        themeIds,
    });
});
