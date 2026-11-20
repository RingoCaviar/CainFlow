import { createZipBlobFromSources } from './zip-archive.js';

self.addEventListener('message', async ({ data: entries }) => {
    try {
        const archive = await createZipBlobFromSources(entries);
        self.postMessage({ archive });
    } catch (error) {
        self.postMessage({ error: error?.message || '无法生成 ZIP' });
    }
});
