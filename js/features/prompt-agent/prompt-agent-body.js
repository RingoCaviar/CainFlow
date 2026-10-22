// Only presentation prose is repaired. Persisted prompts and user messages are untouched.
export function normalizeAgentBodyText(value) {
    return String(value || '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/[^\s\\]+|(?:[A-Za-z]:\\|(?<!\S)\.{1,2}\\|(?<!\S)\\\\[^\s\\]+\\(?!\\))[^\s]*)/g)
        .map((part, index) => index % 2 ? part : part
            .replace(/\\+r\\+n|\\+n/g, '\n')
            .replace(/\/n(?=\s*(?:[-*] |\d+[.)] ))/g, '\n'))
        .join('');
}

export function renderAgentBody({ documentRef, body, text, sources = [] }) {
    body.textContent = '';
    const normalized = normalizeAgentBodyText(text);
    if (!/[\n`]|\*\*|\[\[source:/.test(normalized)) { body.textContent = normalized; return; }
    const add = (tag, owner, value) => {
        const node = documentRef.createElement(tag);
        if (value !== undefined) node.textContent = value;
        owner.appendChild(node); return node;
    };
    const inline = (owner, value) => {
        for (const part of value.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[\[source:[^\]]+\]\])/g)) {
            const citation = /^\[\[source:([^\]]+)\]\]$/.exec(part);
            if (citation) {
                const index = sources.findIndex(source => source.id === citation[1]);
                if (index >= 0 && /^https?:\/\//i.test(sources[index].url)) {
                    const link = add('a', owner, `[${index + 1}]`);
                    link.href = sources[index].url; link.target = '_blank'; link.rel = 'noopener noreferrer';
                }
            } else if (part.startsWith('`') && part.endsWith('`')) add('code', owner, part.slice(1, -1));
            else if (part.startsWith('**') && part.endsWith('**')) add('strong', owner, part.slice(2, -2));
            else add('span', owner, part);
        }
    };
    let paragraph = null, list = null, code = null;
    for (const line of normalized.split('\n')) {
        if (/^\s*```/.test(line)) {
            if (code) code = null;
            else code = add('code', add('pre', body), '');
            paragraph = list = null; continue;
        }
        if (code) { code.textContent += `${line}\n`; continue; }
        if (!line.trim()) { paragraph = list = null; continue; }
        const item = /^\s*(?:([-*]) |(\d+)[.)] )(.+)$/.exec(line);
        if (item) {
            const tag = item[1] ? 'ul' : 'ol';
            if (!list || list.kind !== tag) list = { node: add(tag, body), kind: tag };
            inline(add('li', list.node), item[3]); paragraph = null;
        } else {
            list = null;
            if (!paragraph) paragraph = add('p', body); else add('br', paragraph);
            inline(paragraph, line);
        }
    }
}
