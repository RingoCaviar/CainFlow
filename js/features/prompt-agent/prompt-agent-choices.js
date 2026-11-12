const MAX_CHOICE_LENGTH = 40;
const INVALID_CHOICE_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}<>]/u;

export function normalizePromptAgentChoices(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 4) return undefined;

    const choices = [];
    const seen = new Set();
    for (const item of value) {
        if (typeof item !== 'string') return undefined;
        const label = item.trim();
        if (!label || label.length > MAX_CHOICE_LENGTH || INVALID_CHOICE_CHARACTERS.test(label)) return undefined;
        const key = label.normalize('NFKC').toLowerCase();
        if (seen.has(key)) return undefined;
        seen.add(key);
        choices.push(label);
    }
    return choices;
}
