// Shared boundary for importing an original through the real file input.
import { createHash } from 'node:crypto';

export async function uploadImageOriginal(app, id, image) {
    const expectedHash = createHash('sha256').update(Buffer.from(image.split(',')[1], 'base64')).digest('hex');
    await app.step(`Import original for ${id}`, async ({ completedRequest }) => {
        await app.evaluate(`(async()=>{const files=new DataTransfer();files.items.add(new File([await(await fetch(${JSON.stringify(image)})).blob()],'reference.png',{type:'image/png'}));const input=document.getElementById(${JSON.stringify(id + '-file')});input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await app.waitFor(async () => {
            if (!completedRequest('/api/storage/media-assets', 'PUT')) return false;
            return app.evaluate(`(async()=>{
                const response=await fetch('/api/storage/documents/session');
                if(!response.ok)throw new Error('Read imported original: HTTP '+response.status);
                const document=await response.json(),keys=document.value?.nodes.find(node=>node.id===${JSON.stringify(id)})?.mediaAssetKeys;
                if(keys?.length!==1)return false;
                const original=await fetch('/api/storage/assets/'+encodeURIComponent(keys[0]));
                if(!original.ok)throw new Error('Read imported bytes: HTTP '+original.status);
                const digest=await crypto.subtle.digest('SHA-256',await original.arrayBuffer());
                return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')===${JSON.stringify(expectedHash)};
            })()`);
        }, 7500, { interval: 200 });
    }, { failOnRequests: ['/api/storage/media-assets', '/api/storage/documents/session'] });
}
