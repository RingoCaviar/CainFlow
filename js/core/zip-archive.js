const TEXT_ENCODER = new TextEncoder();
const MAX_ZIP32_SIZE = 0xfffffffe;
const MAX_ZIP32_ENTRIES = 0xfffe;
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

function getDosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}

export function normalizeZipPath(path) {
    return String(path || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter((part) => part && part !== '.' && part !== '..')
        .join('/');
}

export function createZipBlob(entries = []) {
    const localParts = [];
    const centralParts = [];
    const { dosTime, dosDate } = getDosDateTime();
    let centralOffset = 0;
    let centralSize = 0;
    let entryCount = 0;

    entries.forEach((entry) => {
        const name = normalizeZipPath(entry.path);
        if (!name) return;
        const nameBytes = TEXT_ENCODER.encode(name);
        const data = entry.bytes instanceof Uint8Array
            ? entry.bytes
            : TEXT_ENCODER.encode(String(entry.text ?? ''));
        const nextOffset = centralOffset + 30 + nameBytes.length + data.length;
        const nextCentralSize = centralSize + 46 + nameBytes.length;
        if (nameBytes.length > 0xffff || entryCount >= MAX_ZIP32_ENTRIES ||
            nextOffset + nextCentralSize + 22 > MAX_ZIP32_SIZE) {
            throw new RangeError('ZIP 文件超过名称长度、大小或文件数量限制');
        }
        const checksum = crc32(data);

        const localHeader = [];
        writeUint32(localHeader, 0x04034b50);
        writeUint16(localHeader, 20);
        writeUint16(localHeader, 0x0800);
        writeUint16(localHeader, 0);
        writeUint16(localHeader, dosTime);
        writeUint16(localHeader, dosDate);
        writeUint32(localHeader, checksum);
        writeUint32(localHeader, data.length);
        writeUint32(localHeader, data.length);
        writeUint16(localHeader, nameBytes.length);
        writeUint16(localHeader, 0);
        localParts.push(new Uint8Array(localHeader), nameBytes, data);

        const centralHeader = [];
        writeUint32(centralHeader, 0x02014b50);
        writeUint16(centralHeader, 20);
        writeUint16(centralHeader, 20);
        writeUint16(centralHeader, 0x0800);
        writeUint16(centralHeader, 0);
        writeUint16(centralHeader, dosTime);
        writeUint16(centralHeader, dosDate);
        writeUint32(centralHeader, checksum);
        writeUint32(centralHeader, data.length);
        writeUint32(centralHeader, data.length);
        writeUint16(centralHeader, nameBytes.length);
        writeUint16(centralHeader, 0);
        writeUint16(centralHeader, 0);
        writeUint16(centralHeader, 0);
        writeUint16(centralHeader, 0);
        writeUint32(centralHeader, 0);
        writeUint32(centralHeader, centralOffset);
        centralParts.push(new Uint8Array(centralHeader), nameBytes);

        centralOffset = nextOffset;
        centralSize = nextCentralSize;
        entryCount += 1;
    });

    const endRecord = [];
    writeUint32(endRecord, 0x06054b50);
    writeUint16(endRecord, 0);
    writeUint16(endRecord, 0);
    writeUint16(endRecord, entryCount);
    writeUint16(endRecord, entryCount);
    writeUint32(endRecord, centralSize);
    writeUint32(endRecord, centralOffset);
    writeUint16(endRecord, 0);

    return new Blob([...localParts, ...centralParts, new Uint8Array(endRecord)], { type: 'application/zip' });
}
