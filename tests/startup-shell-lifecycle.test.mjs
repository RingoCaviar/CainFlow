import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('startup shell recovers late success and shows generic failure without repeated initialization', () => {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
        import vm from 'node:vm';
        import assert from 'node:assert/strict';
        import {readFileSync} from 'node:fs';
        const source=readFileSync('index.js','utf8');
        for(const failed of [false,true]) {
            let finish, timer, cleared=0, calls=0;
            const startup=new Promise((resolve,reject)=>{finish=()=>failed?reject(new Error('PRIVATE-KEY')):resolve();});
            const message={textContent:''};
            const recovery={hidden:true,querySelector:()=>message};
            const context=vm.createContext({document:{getElementById:()=>recovery},
                setTimeout(fn){timer=fn;return 1;},clearTimeout(){cleared++;}});
            const dependency=new vm.SyntheticModule(['bootstrapCainFlowApp'],function(){
                this.setExport('bootstrapCainFlowApp',()=>{calls++;return startup;});
            },{context});
            await dependency.link(()=>{});await dependency.evaluate();
            const entry=new vm.SourceTextModule(source,{context,importModuleDynamically:()=>dependency});
            await entry.link(()=>{});await entry.evaluate();
            await new Promise(setImmediate);
            timer();assert.equal(recovery.hidden,false);assert.match(message.textContent,/仍未完成/);
            finish();await new Promise(setImmediate);
            assert.equal(calls,1);assert.equal(cleared,1);assert.equal(recovery.hidden,!failed);
            assert.ok(!message.textContent.includes('PRIVATE-KEY'));
            if(failed) assert.match(message.textContent,/启动失败/);
        }
    `], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});
