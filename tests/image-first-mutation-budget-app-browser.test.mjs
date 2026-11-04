import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('the public image-first view ignores identical classes and positions its editor without rebuilding input presentation', { timeout: 45000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [], connections: [],
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test', apikey: 'test' }] }, async app => {
        // Exercise the exported presentation factory with real DOM observers and
        // caller-owned graph state. Counting graph reads catches work even when
        // input-detail's own DOM cache would conceal an unnecessary refresh.
        await app.evaluate(`(async()=>{
            const frame=document.createElement('iframe');frame.style.cssText='position:fixed;inset:0;width:1000px;height:700px;z-index:1';
            frame.srcdoc='<style>.node{position:absolute;left:40px;top:30px;width:300px;height:200px}.image-parameter-panel{position:absolute}.image-parameter-store{display:none}</style><div id="budget-save" class="node"><div class="node-inputs-section"></div><div class="node-body"><div class="node-field"><input id="budget-save-filename" value="original"></div><div id="budget-save-save-preview" class="save-preview-container"></div></div></div>';
            const loaded=new Promise(resolve=>frame.onload=resolve);document.body.append(frame);await loaded;
            const doc=frame.contentDocument,win=frame.contentWindow;
            const {createImageFirstCanvas}=await import('/js/features/ui/image-first-canvas.js');
            let graphReads=0,settingsChanges=0;
            const node={id:'budget-save',type:'ImageSave',el:doc.getElementById('budget-save'),data:{},enabled:true};
            const state={nodes:new Map([[node.id,node]]),models:[],selectedNodes:new Set([node.id]),runningNodeIds:new Set(),get connections(){graphReads++;return []}};
            const api=createImageFirstCanvas({state,documentRef:doc,windowRef:win,storage:null,selectionApi:{setSelection(ids){state.selectedNodes=new Set(ids)}},runToNode(){},fitNode(){},onSettingsChanged(){settingsChanges++}});
            api.install(node.id);
            const settle=()=>new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve))));
            await settle();
            const model=node.parameterRoot.querySelector('.image-first-summary>span'),field=doc.getElementById('budget-save-filename'),panel=doc.getElementById('image-parameter-panel');
            let summaryWrites=0;new MutationObserver(records=>summaryWrites+=records.length).observe(model,{childList:true,characterData:true,subtree:true});
            window.budgetView={node,state,api,doc,panel,model,field,settle,get graphReads(){return graphReads},get summaryWrites(){return summaryWrites},get settingsChanges(){return settingsChanges},reset(){graphReads=0;summaryWrites=0}};
        })()`);
        await app.evaluate('budgetView.reset();budgetView.node.el.classList.remove("connection-insert-candidate");budgetView.settle()');
        assert.deepEqual(await app.evaluate('({reads:budgetView.graphReads,writes:budgetView.summaryWrites})'), { reads: 0, writes: 0 }, 'a class attribute notification with an identical old value must do no presentation work');

        await app.evaluate('budgetView.reset();budgetView.node.el.classList.add("selected","is-interacting","connection-insert-candidate");budgetView.settle()');
        assert.equal(await app.evaluate('budgetView.graphReads'), 0, 'selection and drag decoration must not rebuild media presentation');
        await app.evaluate('budgetView.node.el.classList.remove("selected","is-interacting","connection-insert-candidate");budgetView.settle()');
        assert.equal(await app.evaluate('budgetView.graphReads'), 0, 'settling a drag must not rebuild media presentation');

        assert.equal(await app.evaluate('budgetView.reset();budgetView.api.selectionChanged();budgetView.api.selectionChanged();budgetView.graphReads'), 0,
            'selection notifications must not synchronously rebuild the parameter layer on pointer down');
        await app.evaluate('budgetView.settle()');

        await app.evaluate('budgetView.reset();budgetView.state.dragging={nodes:[budgetView.node.id]};budgetView.api.selectionChanged();budgetView.settle()');
        assert.equal(await app.evaluate('budgetView.graphReads'), 0, 'dragging keeps expensive selection presentation off the input path');
        await app.evaluate('budgetView.state.dragging=null;budgetView.settle()');
        assert.ok(await app.evaluate('budgetView.graphReads>0'), 'the latest selection is presented after release');

        const before = await app.evaluate('budgetView.panel.style.left');
        await app.evaluate('budgetView.reset();budgetView.node.el.style.left="170px";budgetView.node.el.style.top="75px";budgetView.node.el.style.width="360px";budgetView.settle()');
        assert.notEqual(await app.evaluate('budgetView.panel.style.left'), before, 'the open editor still follows real node geometry');
        assert.deepEqual(await app.evaluate('({reads:budgetView.graphReads,writes:budgetView.summaryWrites,sameField:budgetView.doc.getElementById("budget-save-filename")===budgetView.field})'), { reads: 0, writes: 0, sameField: true });

        await app.evaluate('budgetView.node.runStatus="waiting";budgetView.state.runningNodeIds.add("budget-save");budgetView.node.el.classList.add("running");budgetView.settle()');
        assert.deepEqual(await app.evaluate('(()=>{const button=budgetView.panel.querySelector("[data-parameter-action=generate]");return [button.textContent,button.disabled]})()'), ['更新中', true], 'a real execution class transition still refreshes the footer and locks');
        await app.evaluate('budgetView.node.runStatus="completed";budgetView.state.runningNodeIds.clear();budgetView.node.el.classList.remove("running");budgetView.settle()');
        assert.deepEqual(await app.evaluate('(()=>{const button=budgetView.panel.querySelector("[data-parameter-action=generate]");return [button.textContent,button.disabled]})()'), ['更新媒体', false]);

        await app.evaluate('budgetView.doc.getElementById("budget-save-save-preview").dataset.saveMessage="原图缺失，未更新";budgetView.settle()');
        assert.match(await app.evaluate('budgetView.model.textContent'), /原图缺失，未更新/);
        assert.match(await app.evaluate('budgetView.panel.querySelector(".image-parameter-feedback").textContent'), /原图缺失，未更新/);
        await app.evaluate('budgetView.field.value="edited";budgetView.field.dispatchEvent(new Event("input",{bubbles:true}));budgetView.settle()');
        assert.equal(await app.evaluate('budgetView.settingsChanges'), 1, 'original parameter controls keep their settings callback');
        await app.evaluate('budgetView.reset();budgetView.api.refreshNode("budget-save");budgetView.api.refreshNode("budget-save");budgetView.settle()');
        assert.equal(await app.evaluate('budgetView.summaryWrites'), 0, 'even an explicit unchanged refresh preserves its existing text node');
    });
});
