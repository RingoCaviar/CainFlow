import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';

test('full app Mixed-node benchmark runs the existing 200-node 400-connection interaction sample', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id:'chat',modelId:'test',protocol:'openai',taskType:'chat',providerIds:['p'] }],
        providers: [{ id:'p',endpoint:'https://controlled.test',apikey:'test' }]
    }, async ({ evaluate, send, waitFor, server }) => {
        await send('Page.navigate', { url: server.baseUrl + '/?perf=1&stressTest=1&benchmark=1' });
        await waitFor("window.__cainflowAppReady && Boolean(document.getElementById('cainflow-perf-controls'))");
        await evaluate("document.querySelector('#cainflow-perf-controls button').click()");
        await waitFor("document.querySelectorAll('#nodes-layer .node').length===200 && !document.querySelector('#cainflow-perf-controls button').disabled");
        await evaluate("document.querySelectorAll('#cainflow-perf-controls button')[1].click()");
        for (let attempt=0; attempt<60; attempt++) {
            if(await evaluate("Boolean(document.getElementById('cainflow-perf-panel'))")) break;
            await delay(250);
        }
        const report=await evaluate("document.getElementById('cainflow-perf-panel')?.textContent || ''");
        assert.match(report,/200 nodes \| 400 connections/);
        assert.match(report,/\d+\.\d+ FPS \| p95 \d+\.\d+ ms/);
        for(const cost of ['render-projection','connection-full-refresh']) assert.ok(report.includes(cost),report);
        if(process.env.CAINFLOW_QA_BENCHMARK_DIR){
            await mkdir(process.env.CAINFLOW_QA_BENCHMARK_DIR,{recursive:true});
            await writeFile(join(process.env.CAINFLOW_QA_BENCHMARK_DIR,(process.env.CAINFLOW_QA_BENCHMARK_LABEL || 'current')+'.txt'),report+'\n');
        }
    }, { repoDirectory: process.env.CAINFLOW_QA_BASELINE_REPO });
});
