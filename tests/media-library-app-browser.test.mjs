import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const image = await readFile(new URL('./fixtures/reference-red.png', import.meta.url));
const session = { autoCheckUpdatesOnLoad:false,
    models:[{id:'chat',name:'受控对话',modelId:'chat',protocol:'openai',taskType:'chat',providerIds:['p']},{id:'image',name:'受控图片',modelId:'gpt-image-1',protocol:'openai',taskType:'image',providerIds:['p']}],
    providers:[{id:'p',name:'受控供应商',endpoint:'https://controlled.test/v1',apikey:'test'}],
    nodes:[{id:'generate',type:'ImageGenerate',x:100,y:80,apiConfigId:'image',providerId:'p',prompt:'archive me',generationCount:2}],connections:[] };
const setup = `window.archiveHeld=false;window.archiveMode='hold';window.archiveReleases=[];window.releaseArchive=()=>{window.archiveMode='normal';archiveReleases.forEach(resolve=>resolve())};window.archiveWrites=0;const originalFetch=fetch;window.fetch=async(url,options={})=>{
    if(String(url)==='/proxy')return new Response(JSON.stringify({data:[{b64_json:${JSON.stringify(image.toString('base64'))}}]}),{headers:{'Content-Type':'application/json'}});
    if(String(url)==='/api/storage/library'&&options.method==='POST'){
        window.archiveWrites++;if(window.archiveMode==='hold'){window.archiveHeld=true;await new Promise(resolve=>archiveReleases.push(resolve))}
        if(window.archiveMode==='fail')return new Response(JSON.stringify({error:'受控磁盘写入失败'}),{status:400,headers:{'Content-Type':'application/json'}});
    }return originalFetch(url,options);
};`;
const metadata = app => app.evaluate("fetch('/api/storage/library').then(r=>r.json())");

test('generation archives the complete batch before publishing; directory history switches and physically deletes', {timeout:60000}, async()=>{
    await withAppBrowser(session,async app=>{
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor('window.archiveHeld');
        assert.equal(await app.evaluate("!!document.querySelector('#generate-image-results .image-node-result-preview img')"),false);
        assert.deepEqual(await readdir(join(app.server.dataDir,'exports')),[]);
        await app.evaluate('window.releaseArchive()');
        await app.waitFor("!!document.querySelector('#generate-image-results .image-node-result-preview img')");
        await app.waitFor("fetch('/api/storage/library').then(r=>r.json()).then(d=>d.count===2)");
        const entries=(await metadata(app)).items;
        assert.equal(await app.evaluate("document.querySelectorAll('.node-save').length"),0);
        for(const entry of entries){assert.equal(entry.prompt,'archive me');assert.deepEqual(await readFile(join(entry.directory,entry.relativePath)),image)}
        const nested=join(app.server.dataDir,'exports','nested');await mkdir(nested);
        await writeFile(join(nested,'manual.png'),image);
        assert.equal((await metadata(app)).count,3);
        await app.evaluate("document.getElementById('btn-history').click()");
        await app.waitFor("document.querySelectorAll('#history-list .history-card').length===3");
        const other=join(app.server.dataDir,'other');
        await app.evaluate(`import('/js/services/storage-disk.js').then(m=>{window.archiveApi=m.createDiskStorageApi(()=>({}));return archiveApi.saveHandle('GLOBAL_SAVE_DIR',${JSON.stringify(other)})})`);
        assert.equal((await metadata(app)).count,0);
        await app.evaluate(`archiveApi.saveHandle('GLOBAL_SAVE_DIR',${JSON.stringify(join(app.server.dataDir,'exports'))})`);
        await app.waitFor("document.querySelectorAll('#history-list .history-card').length===3");
        assert.equal((await metadata(app)).count,3);
        const id=entries[0].id;
        assert.equal(await app.evaluate(`archiveApi.getHistoryEntry(${id}).then(e=>e.image.startsWith('data:image/png;base64,'))`),true);
        await app.evaluate(`archiveApi.deleteHistoryEntry(${id}, ${JSON.stringify(entries[0])})`);
        await assert.rejects(stat(join(entries[0].directory,entries[0].relativePath)),{code:'ENOENT'});
        assert.equal((await metadata(app)).count,2);
        await reloadAppBrowser(app);
        assert.equal((await metadata(app)).count,2,'deleted originals do not resurrect after restart');
        await app.evaluate("window.archiveMode='fail';document.getElementById('btn-run').click()");
        await app.waitFor("document.getElementById('generate')?.classList.contains('node-failed') || document.getElementById('generate')?.classList.contains('error') || document.body.innerText.includes('受控磁盘写入失败')");
        assert.equal((await metadata(app)).count,2,'failed local save must not add history');
        assert.equal(await app.evaluate("!!document.querySelector('#generate-image-results .image-node-result-preview img')"),false);
    },{initScript:setup});
});

for(const accept of [false,true])test(`legacy save cleanup ${accept?'reconnects and persists':'cancel preserves scene'}`,{timeout:30000},async()=>{
    const old={...session,nodes:[{id:'a',type:'ImageImport',x:20,y:20},{id:'s',type:'ImageSave',x:300,y:20},{id:'g',type:'ImageGenerate',x:600,y:20}],connections:[
        {id:'a-s',from:{nodeId:'a',port:'image'},to:{nodeId:'s',port:'image'},type:'image',order:0},
        {id:'s-g',from:{nodeId:'s',port:'image'},to:{nodeId:'g',port:'referenceImages'},type:'image',order:0}]};
    await withAppBrowser(old,async app=>{
        await app.waitFor("!!document.querySelector('#app-action-dialog:not(.hidden)')");
        assert.match(await app.evaluate("document.getElementById('app-action-dialog').textContent"), /保存节点.*弃用/s);
        await app.evaluate("document.querySelector('#app-action-dialog [data-dialog-style-1-action=" + (accept ? 'confirm' : 'cancel') + "]').click()");
        if(accept){
            try { await app.waitFor("!document.getElementById('s')"); } catch(error) { error.message += '\nTOASTS: ' + await app.evaluate('JSON.stringify(window.cleanupToasts)'); throw error; }
            try { await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>!d.value.nodes.some(n=>n.type==='ImageSave') && d.value.connections.length===1)"); }
            catch(error) { error.message+='\nSTATE: '+await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>JSON.stringify({nodes:d.value.nodes,connections:d.value.connections,toasts:window.cleanupToasts}))");throw error; }
            const edges=await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.connections)");
            assert.equal(edges[0].from.nodeId,'a');assert.equal(edges[0].to.nodeId,'g');assert.equal(edges[0].to.port,'referenceImages');
            await reloadAppBrowser(app);assert.equal(await app.evaluate("!!document.getElementById('s')"),false);
        }else{assert.equal(await app.evaluate("!!document.getElementById('s')"),true)}
        assert.equal(await app.evaluate("document.querySelectorAll('#context-menu [data-type=ImageSave]').length"),0);
    },{preserveRetiredSaveNodes:false,initScript:`window.cleanupToasts=[];document.addEventListener('DOMContentLoaded',()=>new MutationObserver(rs=>rs.forEach(r=>r.addedNodes.forEach(n=>{if(n.nodeType===1&&n.closest?.('#toast-container'))cleanupToasts.push(n.textContent)}))).observe(document.body,{childList:true,subtree:true}));window.confirm=()=>{throw new Error('Native confirmation is forbidden')}`});
});
test('video generation archives every result without a save node and history reads the local original', {timeout:45000}, async()=>{
    const videoSession={...session,models:[...session.models,{id:'video',name:'受控视频',modelId:'veo-3',protocol:'veo-unified',taskType:'video',providerIds:['p']}],nodes:[{id:'video',type:'VideoGenerate',x:60,y:80,apiConfigId:'video',providerId:'p',prompt:'movie',generationCount:2}],connections:[]};
    await withAppBrowser(videoSession,async app=>{
        const bytes=await app.evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d'),stream=canvas.captureStream(10),chunks=[],recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),done=new Promise(resolve=>recorder.onstop=resolve);recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.start();for(let i=0;i<5;i++){ctx.fillStyle=i%2?'red':'blue';ctx.fillRect(0,0,64,64);await new Promise(resolve=>setTimeout(resolve,100))}recorder.stop();await done;stream.getTracks().forEach(t=>t.stop());return Array.from(new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer()))})()`);
        await app.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.videoCreates=0;const realFetch=fetch;window.fetch=async(url,options={})=>{
            if(String(url).endsWith('/controlled-video.webm'))return new Response(new Uint8Array(${JSON.stringify(bytes)}),{headers:{'Content-Type':'video/webm'}});
            if(String(url)==='/proxy')return new Response(JSON.stringify(options.body?{id:'task-'+(++videoCreates),task_id:'task-'+videoCreates,status:'submitted'}:{status:'completed',video_url:location.origin+'/controlled-video.webm'}),{headers:{'Content-Type':'application/json'}});
            return realFetch(url,options)};`});
        await reloadAppBrowser(app);
        await app.evaluate("document.getElementById('btn-run').click()");
        await app.waitFor("fetch('/api/storage/library').then(r=>r.json()).then(d=>d.count===2)");
        const entries=(await metadata(app)).items;
        for(const entry of entries){assert.equal(entry.mediaType,'video');assert.deepEqual(await readFile(join(entry.directory,entry.relativePath)),Buffer.from(bytes));assert.equal(entry.prompt,'movie')}
        assert.equal(await app.evaluate("document.querySelectorAll('.node-save').length"),0);
        const local=await app.evaluate(`import('/js/services/storage-disk.js').then(async m=>{const api=m.createDiskStorageApi(()=>({})),entry=await api.getHistoryEntry(${entries[0].id});return Array.from(new Uint8Array(await entry.videoBlob.arrayBuffer()))})`);
        assert.deepEqual(local,bytes);
    });
});
