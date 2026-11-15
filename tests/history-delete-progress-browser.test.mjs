import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser } from './helpers/app-browser.mjs';
import { composite, contrastRatio, parseColor } from './helpers/browser-theme-fixture.mjs';

async function assertProgressDialogContrast(app) {
    for (const theme of ['paper', 'light', 'pink', 'glass-light', 'dark', 'pro', 'glass-dark']) {
        const styles = await app.evaluate(`(() => {
            const root = document.documentElement;
            root.dataset.appTheme = ${JSON.stringify(theme)};
            const dialog = document.querySelector('.history-delete-progress[open]');
            return {
                canvas: getComputedStyle(root).getPropertyValue('--bg-canvas').trim(),
                backdrop: getComputedStyle(dialog, '::backdrop').backgroundColor,
                panel: getComputedStyle(dialog).backgroundColor,
                text: Array.from(dialog.querySelectorAll('h3, p, button'), element => {
                    const { color, backgroundColor } = getComputedStyle(element);
                    return { label: element.textContent, color, backgroundColor };
                }),
            };
        })()`);
        const backdrop = composite(parseColor(styles.backdrop), parseColor(styles.canvas));
        const panel = composite(parseColor(styles.panel), backdrop);
        for (const { label, color, backgroundColor } of styles.text) {
            const background = composite(parseColor(backgroundColor), panel);
            const ratio = contrastRatio(composite(parseColor(color), background), background);
            assert.ok(ratio >= 4.5, `${theme}: ${label} has ${ratio.toFixed(2)}:1 contrast`);
        }
    }
}

const session={autoCheckUpdatesOnLoad:false,models:[{id:'chat',name:'test',modelId:'chat',protocol:'openai',taskType:'chat',providerIds:['p']}],providers:[{id:'p',name:'test',endpoint:'https://controlled.test/v1',apikey:'test'}],nodes:[],connections:[]};
test('clear history reports completed and failed file deletions while requests are pending', {timeout:30000}, async()=>{
 await withAppBrowser(session,async app=>{
  const image=await readFile(new URL('./fixtures/reference-red.png',import.meta.url));
  for(let i=0;i<3;i++)await writeFile(join(app.server.dataDir,'exports',`${i}.png`),image);
  await app.evaluate(`window.confirm=()=>true;window.deleteCalls=0;window.releaseDelete=null;const realFetch=fetch;window.fetch=async(url,options={})=>{if(String(url).startsWith('/api/storage/library/')&&options.method==='DELETE'){const call=++window.deleteCalls;await new Promise(r=>window.releaseDelete=r);if(call===2)return new Response(JSON.stringify({error:'controlled failure'}),{status:400})}return realFetch(url,options)};document.getElementById('btn-history').click()`);
  await app.waitFor("document.querySelectorAll('#history-list .history-card').length===3");
  await app.evaluate("document.getElementById('btn-clear-history').click()");
  await app.waitFor('window.deleteCalls===1');
  assert.equal(await app.evaluate("!!document.querySelector('.history-delete-progress[open]')"),true);
  assert.equal(await app.evaluate("document.querySelector('.history-delete-progress progress').value"),0);
  assert.equal(await app.evaluate("import('/js/features/history/history-delete-progress.js').then(async m=>{try{await m.deleteHistoryWithProgress([{id:1}],()=>{throw new Error('unexpected delete')});return false}catch(e){return e.message.includes('正在删除')}})"),true);
  await app.evaluate('window.releaseDelete()');await app.waitFor('window.deleteCalls===2');
  assert.equal(await app.evaluate("document.querySelector('.history-delete-progress progress').value"),1);
  await app.evaluate('window.releaseDelete()');await app.waitFor('window.deleteCalls===3');
  await app.evaluate('window.releaseDelete()');
  await app.waitFor("document.querySelector('.history-delete-progress button')?.disabled===false");
  assert.equal(await app.evaluate("document.querySelector('.history-delete-progress progress').value"),3);
  assert.match(await app.evaluate("document.querySelector('.history-delete-progress').innerText"),/已删除 2.*失败 1/s);
  await assertProgressDialogContrast(app);
  for (const [width, height] of [[1100, 820], [390, 580]]) {
      await app.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const offset = await app.evaluate(`(() => {
          const { x, y, width, height } = document.querySelector('.history-delete-progress[open]').getBoundingClientRect();
          return { x: x + width / 2 - innerWidth / 2, y: y + height / 2 - innerHeight / 2 };
      })()`);
      assert.ok(Math.abs(offset.x) <= 1 && Math.abs(offset.y) <= 1, `${width}×${height}: dialog is centered`);
  }
  assert.equal((await readdir(join(app.server.dataDir,'exports'))).length,1);
 },{initScript:'window.confirm=()=>true;'});
});
