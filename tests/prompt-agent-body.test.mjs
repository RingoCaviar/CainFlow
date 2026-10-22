import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentBodyText, renderAgentBody } from '../js/features/prompt-agent/prompt-agent-body.js';

test('assistant prose repairs escaped paragraph breaks without rewriting code, URLs or paths', () => {
    assert.equal(normalizeAgentBodyText('第一段。\\n\\n第二段。'), '第一段。\n\n第二段。');
    assert.equal(normalizeAgentBodyText('说明。/n- 第一项/n- 第二项'), '说明。\n- 第一项\n- 第二项');
    for (const text of ['`\\n`', '```js\n"\\n"\n```', 'https://example.test/news', 'C:\\new\\notes', '/new/path', '单位/n']) {
        assert.equal(normalizeAgentBodyText(text), text);
    }
});

test('escaped line breaks work at punctuation, formatting, English and segment boundaries', () => {
    for (const [input, expected] of [
        ['Hello\\nWorld', 'Hello\nWorld'],
        ['**标题**\\n内容', '**标题**\n内容'],
        ['第一句）\\n第二句', '第一句）\n第二句'],
        ['\\n第一段\\n\\n第二段\\n', '\n第一段\n\n第二段\n'],
        ['第一段\\\\n第二段', '第一段\n第二段'],
        ['第一段\\r\\n第二段', '第一段\n第二段'],
        ['`\\n`\\n解释', '`\\n`\n解释'],
        ['https://example.test/news\\n下一段', 'https://example.test/news\n下一段'],
    ]) assert.equal(normalizeAgentBodyText(input), expected);
    for (const input of ['.\\notes\\new.txt', '..\\notes\\new.txt', '\\\\server\\notes\\new.txt', 'C:\\notes\\new.txt']) {
        assert.equal(normalizeAgentBodyText(input), input);
    }
});

test('safe renderer creates semantic paragraphs, lists, emphasis and code without HTML interpretation', () => {
    const createElement = tag => ({ tag, children: [], textContent: '', appendChild(child) { this.children.push(child); }, setAttribute() {} });
    const body = createElement('div');
    renderAgentBody({ documentRef: { createElement }, body, text: '**摘要**\n\n- 第一项\n- `代码`\n\n<img onerror=alert(1)>', sources: [] });
    const json = JSON.stringify(body);
    assert.match(json, /"tag":"strong"/); assert.match(json, /"tag":"ul"/); assert.match(json, /"tag":"code"/);
    assert.ok(!json.includes('"tag":"img"'));
});
