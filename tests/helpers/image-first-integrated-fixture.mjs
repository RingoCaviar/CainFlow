import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reloadAppBrowser, waitForAutosave } from './app-browser.mjs';

export const originals = await Promise.all(['red', 'blue', 'orange'].map(async color =>
    'data:image/png;base64,' + (await readFile(new URL(`../fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));

export const configuration = {
    autoCheckUpdatesOnLoad: false, autoRetry: false,
    models: [
        { id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] },
        { id: 'google', modelId: 'gemini-image', name: '完整参考图片', protocol: 'google', taskType: 'image', providerIds: ['p'] },
        { id: 'video', modelId: 'veo-3', name: '受控视频', protocol: 'veo-unified', taskType: 'video', providerIds: ['p'] }
    ],
    providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'integration-test' }]
};

export const imageTypes = ['ImageImport', 'ImageGenerate', 'ImageResize', 'ColorReset', 'ImageCompare', 'ImageMerge', 'ImagePreview', 'ImageSave', 'CameraControl'];
export const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value)");
export const graphEdge = (id, source, output, target, input, type = 'image', order) => ({ id,
    from: { nodeId: source, port: output, extension: { source: id } },
    to: { nodeId: target, port: input, extension: { target: id } }, type,
    ...(order === undefined ? {} : { order }), extension: { retained: [id, { value: true }] } });

export function integratedWorkflow() {
    const image = (id, type, x, y, extra = {}) => ({ id, type, x, y, width: 270, height: 260, userResized: true, customTitle: `整合 · ${id}`, ...extra });
    return {
        ...configuration,
        nodes: [
            image('source', 'ImageImport', 60, 140),
            image('resize', 'ImageResize', 400, 140, { resizeMode: 'dimensions', targetWidth: '384', targetHeight: '256', keepAspect: false, quality: 85 }),
            image('color', 'ColorReset', 400, 480, { colorResetConfig: { temperature: 15, tint: -5, saturation: 20, brightness: 5 } }),
            image('camera', 'CameraControl', 400, 820, { pitch: 15, yaw: -25, distance: 7, fov: 60, roll: 5 }),
            image('generate', 'ImageGenerate', 760, 140, { apiConfigId: 'image', providerId: 'p', prompt: 'retained local draft', generationCount: 3 }),
            image('compare', 'ImageCompare', 760, 480, { comparePosition: 35 }),
            image('merge', 'ImageMerge', 1120, 140, { inputCount: 11 }),
            image('preview', 'ImagePreview', 1120, 480),
            image('save', 'ImageSave', 1480, 140, { filename: 'integrated-bundle', height: 360 }),
            { id: 'text', type: 'Text', x: 60, y: 500, width: 270, text: 'integrated upstream prompt' },
            { id: 'params', type: 'CustomParams', x: 60, y: 800, width: 270, params: [{ key: 'quality', value: 'high' }] },
            { id: 'video', type: 'VideoGenerate', x: 1480, y: 640, width: 300, apiConfigId: 'video', providerId: 'p', prompt: 'integrated native video' }
        ],
        connections: [
            graphEdge('source-resize', 'source', 'image', 'resize', 'image'),
            graphEdge('source-color', 'source', 'image', 'color', 'image'),
            graphEdge('source-camera', 'source', 'image', 'camera', 'image'),
            graphEdge('text-prompt', 'text', 'text', 'generate', 'prompt', 'text'),
            graphEdge('camera-prompt', 'camera', 'text', 'generate', 'camera_prompt', 'text'),
            graphEdge('custom-params', 'params', 'params', 'generate', 'params', 'params'),
            graphEdge('source-reference', 'source', 'image', 'generate', 'referenceImages', 'image', 2),
            graphEdge('color-reference', 'color', 'image', 'generate', 'referenceImages', 'image', 8),
            graphEdge('compare-A', 'resize', 'image', 'compare', 'imageA'),
            graphEdge('compare-B', 'color', 'image', 'compare', 'imageB'),
            graphEdge('merge-10', 'generate', 'image', 'merge', 'image_10', 'image', 1),
            graphEdge('merge-2', 'compare', 'image', 'merge', 'image_2', 'image', 7),
            graphEdge('merge-7', 'source', 'image', 'merge', 'image_7', 'image', 4),
            graphEdge('merge-preview', 'merge', 'image', 'preview', 'image'),
            graphEdge('preview-save', 'preview', 'image', 'save', 'image'),
            graphEdge('video-save', 'video', 'video', 'save', 'video', 'video')
        ]
    };
}

export async function recordPlayableVideo(app) {
    // Native VP8 encoding provides real playable media at the external-provider
    // boundary. Node output and application media state are never injected.
    const video = await app.evaluate("(async()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const context=canvas.getContext('2d'),stream=canvas.captureStream(12),chunks=[],recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:250000}),stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};recorder.start(80);for(let frame=0;frame<12;frame++){context.fillStyle=frame%2?'#2266dd':'#ed9532';context.fillRect(0,0,96,64);context.fillStyle='#fff';context.fillRect(frame*6,20,16,20);await new Promise(resolve=>setTimeout(resolve,80));}recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());const blob=new Blob(chunks,{type:'video/webm'});if(blob.size<1024)throw new Error('Native video fixture too small');const response=await fetch('/api/storage/media-assets',{method:'PUT',headers:{'Content-Type':'video/webm','X-CainFlow-Media-Owner-Type':'test-fixture','X-CainFlow-Media-Owner-Id':'integrated-native-video'},body:blob});if(!response.ok)throw new Error(await response.text());return {key:(await response.json()).asset.asset_key,bytes:blob.size,head:Array.from(new Uint8Array(await blob.arrayBuffer()).slice(0,4))}})()");
    assert.deepEqual(video.head, [0x1a, 0x45, 0xdf, 0xa3]);
    return video;
}

export async function controlProviders(app, { video = null } = {}) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.integrationRequests=[];window.integrationHold=false;window.integrationPending=false;const integrationFetch=window.fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'){if(!options.body){integrationRequests.push({kind:'poll'});return new Response(JSON.stringify({status:'completed',video_url:location.origin+'/api/storage/assets/'+encodeURIComponent(${JSON.stringify(video?.key || '')})}),{headers:{'Content-Type':'application/json'}});}const form=options.body instanceof FormData,body=form?Object.fromEntries(options.body):JSON.parse(options.body);if(body.contents||typeof body.prompt==='string'){const prompt=body.contents?body.contents[0].parts.filter(part=>part.text).map(part=>part.text).join(' '):body.prompt,kind=body.model==='veo-3'?'video':'image';integrationRequests.push({kind,body:form?{prompt,model:body.model,quality:body.quality,references:options.body.getAll('image[]').length||Number(options.body.has('image'))}:body});if(prompt.includes('FAIL_THEME'))return new Response(JSON.stringify({error:{message:'真实受控失败：LongUnbrokenProviderFailureWordLongUnbrokenProviderFailureWord，请查看完整详情。'}}),{status:500,headers:{'Content-Type':'application/json'}});if(prompt.includes('RUN_HELD')&&integrationHold){integrationPending=true;try{await new Promise((resolve,reject)=>{window.integrationRelease=resolve;options.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})})}finally{integrationPending=false;}}if(kind==='video')return new Response(JSON.stringify({id:'integrated-video-task',task_id:'integrated-video-task',status:'submitted'}),{headers:{'Content-Type':'application/json'}});const images=${JSON.stringify(originals)},index=(integrationRequests.filter(request=>request.kind==='image').length-1)%images.length,b64=images[index].split(',')[1];return new Response(JSON.stringify(body.contents?{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:b64}}]}}]}:{data:[{b64_json:b64}]}),{headers:{'Content-Type':'application/json'}});}}return integrationFetch(url,options)};` });
    await reloadAppBrowser(app);
}

export async function upload(app, id = 'source', index = 0) {
    await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(originals[index])})).blob()],'integrated-original.png',{type:'image/png'}));const input=document.getElementById(${JSON.stringify(id + '-file')});input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id===${JSON.stringify(id)})?.mediaAssetKeys?.length===1)`);
}

export async function openParameters(app, id, group = null) {
    await app.evaluate(`document.querySelectorAll('.notice-close').forEach(button=>button.click());document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden&&document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}`);
    if (group) await app.evaluate(`(()=>{const toggle=document.querySelector('#image-parameter-panel [data-parameter-group-toggle=${group}]');if(toggle?.getAttribute('aria-expanded')!=='true')toggle.click()})()`);
}

export async function runNode(app, id, selected = false) {
    await app.evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(id)});${selected ? "node.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:600,clientY:200}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));" : ''}node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:200}));document.getElementById('${selected ? 'context-menu-run-selected' : 'context-menu-run-to-here'}').click()})()`);
}

export async function nativeClick(app, selector, { count = 1 } = {}) {
    const center = `(()=>{const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`;
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await app.evaluate(center) });
    await app.waitFor(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),rect=element.getBoundingClientRect();return element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))})()`);
    const point = await app.evaluate(center);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: count });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: count });
}

export async function key(app, value, code = value, modifiers = 0) {
    const enter = value === 'Enter' ? { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' } : {};
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code, modifiers, ...enter });
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, modifiers, ...enter });
}

export async function persist(app) {
    await waitForAutosave(app);
    return saved(app);
}
