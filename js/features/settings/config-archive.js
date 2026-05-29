const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8');
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(output, value) {
    output.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(output, value) {
    output.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function pushBytes(output, bytes) {
    for (let i = 0; i < bytes.length; i += 1) output.push(bytes[i]);
}

function getDosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}

function normalizeZipPath(path) {
    return String(path || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter((part) => part && part !== '.' && part !== '..')
        .join('/');
}

function encodeJson(value) {
    return TEXT_ENCODER.encode(JSON.stringify(value, null, 2));
}

export function createConfigArchiveBlob(entries = []) {
    const output = [];
    const central = [];
    const now = getDosDateTime();
    let offset = 0;

    entries.forEach((entry) => {
        const name = normalizeZipPath(entry.path);
        if (!name) return;
        const nameBytes = TEXT_ENCODER.encode(name);
        const data = entry.bytes instanceof Uint8Array
            ? entry.bytes
            : TEXT_ENCODER.encode(String(entry.text ?? ''));
        const checksum = crc32(data);
        const localOffset = offset;

        writeUint32(output, 0x04034b50);
        writeUint16(output, 20);
        writeUint16(output, 0x0800);
        writeUint16(output, 0);
        writeUint16(output, now.dosTime);
        writeUint16(output, now.dosDate);
        writeUint32(output, checksum);
        writeUint32(output, data.length);
        writeUint32(output, data.length);
        writeUint16(output, nameBytes.length);
        writeUint16(output, 0);
        pushBytes(output, nameBytes);
        pushBytes(output, data);
        offset = output.length;

        central.push({
            nameBytes,
            checksum,
            size: data.length,
            offset: localOffset
        });
    });

    const centralOffset = output.length;
    central.forEach((entry) => {
        writeUint32(output, 0x02014b50);
        writeUint16(output, 20);
        writeUint16(output, 20);
        writeUint16(output, 0x0800);
        writeUint16(output, 0);
        writeUint16(output, now.dosTime);
        writeUint16(output, now.dosDate);
        writeUint32(output, entry.checksum);
        writeUint32(output, entry.size);
        writeUint32(output, entry.size);
        writeUint16(output, entry.nameBytes.length);
        writeUint16(output, 0);
        writeUint16(output, 0);
        writeUint16(output, 0);
        writeUint16(output, 0);
        writeUint32(output, 0);
        writeUint32(output, entry.offset);
        pushBytes(output, entry.nameBytes);
    });

    const centralSize = output.length - centralOffset;
    writeUint32(output, 0x06054b50);
    writeUint16(output, 0);
    writeUint16(output, 0);
    writeUint16(output, central.length);
    writeUint16(output, central.length);
    writeUint32(output, centralSize);
    writeUint32(output, centralOffset);
    writeUint16(output, 0);

    return new Blob([new Uint8Array(output)], { type: 'application/zip' });
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
