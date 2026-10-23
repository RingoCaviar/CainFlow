import assert from 'node:assert/strict';
import test from 'node:test';

import { renderComputedFixture } from './helpers/browser-theme-fixture.mjs';

test('fullscreen preview actions and description button do not overlap for saved and imported images', () => {
    const layouts = renderComputedFixture(new URL('./fixtures/fullscreen-preview-actions.html', import.meta.url), 'cainflow-fullscreen-actions-', '800,600');
    for (const [index, layout] of layouts.entries()) {
        const visible = Object.entries(layout).filter(([, rect]) => rect);
        for (let left = 0; left < visible.length; left += 1) {
            for (let right = left + 1; right < visible.length; right += 1) {
                const [leftName, leftRect] = visible[left];
                const [rightName, rightRect] = visible[right];
                const overlaps = leftRect.left < rightRect.right && rightRect.left < leftRect.right
                    && leftRect.top < rightRect.bottom && rightRect.top < leftRect.bottom;
                assert.equal(overlaps, false, `${index === 0 ? 'saved' : 'imported'} image: ${leftName} overlaps ${rightName}`);
            }
        }
    }
});
