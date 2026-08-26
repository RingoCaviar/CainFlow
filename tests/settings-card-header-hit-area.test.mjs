import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const settingsCss = fs.readFileSync(
    new URL('../css/modules/12-settings-config.css', import.meta.url),
    'utf8'
);

test('card title editing does not consume the remaining collapsible header area', () => {
    const cardNameRule = settingsCss.match(/\.api-config-card \.card-header \.card-name\s*\{([^}]*)\}/)?.[1] || '';

    assert.doesNotMatch(cardNameRule, /\bflex\s*:\s*1\b/);
});

test('collapsed card header hit area reaches the inside edge of the card', () => {
    const collapsedCardRule = settingsCss.match(/\.api-config-card\.is-collapsed\s*\{([^}]*)\}/)?.[1] || '';
    const collapsedHeaderRule = settingsCss.match(/\.api-config-card\.is-collapsed \.card-header\s*\{([^}]*)\}/)?.[1] || '';

    assert.match(collapsedCardRule, /\bpadding\s*:\s*0\b/);
    assert.match(collapsedHeaderRule, /\bpadding\s*:\s*14px\b/);
});

test('expanded card header hit area includes the card top inset', () => {
    const expandedHeaderRule = settingsCss.match(/\.api-config-card:not\(\.is-collapsed\) \.card-header\s*\{([^}]*)\}/)?.[1] || '';

    assert.match(expandedHeaderRule, /\bmargin\s*:\s*-14px\s+-14px\s+0\b/);
    assert.match(expandedHeaderRule, /\bpadding\s*:\s*14px\s+14px\s+0\b/);
});
