import { normalizeZipPath } from '../../core/zip-archive.js';

export { createZipBlob as createConfigArchiveBlob } from '../../core/zip-archive.js';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8');

function encodeJson(value) {
    return TEXT_ENCODER.encode(JSON.stringify(value, null, 2));
}

function readUint16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export async function readConfigArchive(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = new Map();
    let offset = 0;

    while (offset + 30 <= bytes.length) {
        const signature = readUint32(bytes, offset);
        if (signature === 0x02014b50 || signature === 0x06054b50) break;
        if (signature !== 0x04034b50) {
            throw new Error('ZIP 文件格式无效');
        }

        const flags = readUint16(bytes, offset + 6);
        const method = readUint16(bytes, offset + 8);
        const compressedSize = readUint32(bytes, offset + 18);
        const uncompressedSize = readUint32(bytes, offset + 22);
        const nameLength = readUint16(bytes, offset + 26);
        const extraLength = readUint16(bytes, offset + 28);
        const nameStart = offset + 30;
        const dataStart = nameStart + nameLength + extraLength;
        const dataEnd = dataStart + compressedSize;

        if (flags & 0x0008) throw new Error('暂不支持带数据描述符的 ZIP 文件');
        if (method !== 0) throw new Error('暂只支持未压缩的 CainFlow 配置 ZIP');
        if (dataEnd > bytes.length || compressedSize !== uncompressedSize) throw new Error('ZIP 条目长度无效');

        const name = normalizeZipPath(TEXT_DECODER.decode(bytes.slice(nameStart, nameStart + nameLength)));
        if (name && !name.endsWith('/')) {
            entries.set(name, bytes.slice(dataStart, dataEnd));
        }
        offset = dataEnd;
    }

    return entries;
}

export function jsonEntry(path, value) {
    return { path, bytes: encodeJson(value) };
}

export function readJsonEntry(entries, path) {
    const bytes = entries.get(normalizeZipPath(path));
    if (!bytes) return null;
    return JSON.parse(TEXT_DECODER.decode(bytes));
}

export function readWorkflowEntries(entries) {
    const index = readJsonEntry(entries, 'workflows/index.json');
    if (Array.isArray(index)) {
        return index
            .map((item) => {
                const name = String(item?.name || '').trim();
                const file = normalizeZipPath(`workflows/${item?.file || ''}`);
                const bytes = entries.get(file);
                if (!name || !bytes) return null;
                return {
                    name,
                    data: JSON.parse(TEXT_DECODER.decode(bytes))
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    const workflows = [];
    entries.forEach((bytes, path) => {
        const match = /^workflows\/(.+)\.json$/i.exec(path);
        if (!match || path.toLowerCase() === 'workflows/index.json') return;
        const name = match[1].split('/').pop();
        if (!name) return;
        workflows.push({
            name,
            data: JSON.parse(TEXT_DECODER.decode(bytes))
        });
    });
    return workflows.sort((a, b) => a.name.localeCompare(b.name));
}
