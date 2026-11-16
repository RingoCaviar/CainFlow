import test from 'node:test';
import assert from 'node:assert/strict';
import {bindTaskToReply,confirmTaskParameters,updateCreativeTask} from '../js/features/prompt-agent/prompt-agent-task.js';
import {createPromptAgentConversationStore} from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
import {createPromptAgentInput} from '../js/features/prompt-agent/prompt-agent-input.js';
const reply=parameters=>({promptPlan:{prompt:'海报',parameters}});

test('a shared image batch uses one output per input unless the user explicitly requests a per-image count', () => {
    const proposal = () => ({
        intent: 'generate', canvasPlan: { imageBatch: true, steps: ['first', 'second'].map(id => ({
            id, type: 'ImageGenerate', parameters: { prompt: '中性背景', generationCount: 99 }
        })) }
    });
    for (const [message, count] of [
        ['用同一提示词批量生成2张，全部用16:9', 1],
        ['用同一提示词逐张处理，每张生成2张，全部用16:9', 2]
    ]) {
        const draft = proposal();
        bindTaskToReply(draft, null, message);
        assert.deepEqual(draft.canvasPlan.steps.map(step => [step.parameters.generationCount, step.parameters.aspect]),
            [[count, '16:9'], [count, '16:9']]);
    }
});
test('explicit size survives omitted or conflicting model suggestions, compaction and reconstruction',()=>{
 const a=reply({});const task=bindTaskToReply(a,null,'生成2K、16:9海报');
 assert.deepEqual(a.promptPlan.parameters,{resolution:'2K',aspectRatio:'16:9'});
 const b=reply({resolution:'1K',aspectRatio:'1:1'});bindTaskToReply(b,task,'只修改背景');
 assert.deepEqual(b.promptPlan.parameters,a.promptPlan.parameters);
 assert.equal(b.promptPlan.parameterSources.resolution,'沿用任务');
 const store=createPromptAgentConversationStore();store.setCreativeTask(task);store.append({role:'user',text:'2K16:9'});store.compact('保留创作');
 const restored=createPromptAgentConversationStore();restored.restore(JSON.parse(JSON.stringify(store.snapshot())));
 assert.deepEqual(restored.getCreativeTask(),task);
 assert.deepEqual(JSON.parse(createPromptAgentInput({conversation:restored.getCompactionContext()}).messages.at(-1).content).creativeTask,task);
 restored.clear();assert.equal(restored.getCreativeTask(),null);
});
test('new task resets inherited values and does not mutate old plans or infer settings from suggestions',()=>{
 const a=reply({quality:'high'});const task=bindTaskToReply(a,null,'生成2K、16:9海报');
 assert.equal(task.parameters.quality,undefined);
 const saved=JSON.stringify(a);const b=reply({});const next=bindTaskToReply(b,task,'开始全新创作，画小狗');
 assert.notEqual(next.id,task.id);assert.deepEqual(b.promptPlan.parameters,{});assert.equal(JSON.stringify(a),saved);
 assert.throws(()=>updateCreativeTask(task,'继续改背景',{mode:'new'}),/确认/);
 assert.throws(()=>updateCreativeTask(task,'继续改背景',{parameters:{resolution:{value:'4K',evidence:'背景'}}}),/不一致/);
});

test('an independent generation request starts a new creative task without confirmation', () => {
    const cup = reply({});
    const previous = bindTaskToReply(cup, null, '生成2K、16:9的白色杯子');
    const oldPlan = structuredClone(cup.promptPlan);
    const draft = { ...reply({ aspectRatio: '16:9' }), intent: 'generate', taskUpdate: { mode: 'new' } };
    const task = bindTaskToReply(draft, previous, '生成一张4K的黑夜里的足球场照片');

    assert.notEqual(task.id, previous.id);
    assert.deepEqual(draft.promptPlan.parameters, { resolution: '4K', count: 1 });
    assert.deepEqual(cup.promptPlan, oldPlan);
    assert.notEqual(bindTaskToReply(structuredClone(draft), previous, '再来一张，夜间足球场照片').id, previous.id);
});

test('a request for one output with three product states keeps a generation count of one', () => {
    const draft = reply({});
    draft.taskUpdate = { parameters: { count: { value: 1, evidence: '生成一张类似的图片' } } };

    const task = bindTaskToReply(draft, null, '根据第一张图，给图2这个产品生成一张类似的图片，同一张图体现产品的三个状态。');

    assert.equal(draft.promptPlan.parameters.count, 1);
    assert.equal(task.parameters.count, 1);
});

test('an output count with short evidence is recovered from the complete request', () => {
    const draft = reply({});
    draft.taskUpdate = { parameters: { count: { value: '2', evidence: '两张' } } };

    bindTaskToReply(draft, null, '参考图1，帮我出两张不同构图的产品图。');

    assert.equal(draft.promptPlan.parameters.count, 2);
});

test('reference and in-frame quantities do not change the output count', () => {
    const draft = reply({});
    const task = bindTaskToReply(draft, null, '参考第一张图，画面中展示出三张卡片和产品的三个状态。');

    assert.equal(task.parameters.count, undefined);
    assert.throws(() => updateCreativeTask(task, '参考第一张图', {
        parameters: { count: { value: 1, evidence: '一张' } }
    }), /不一致/);
});

test('a model cannot reset the creative task through an edit or ambiguous continuation', () => {
    const previous = bindTaskToReply(reply({}), null, '生成2K、16:9的白色杯子');
    const proposal = { ...reply({}), intent: 'generate', taskUpdate: { mode: 'new' } };
    assert.throws(() => bindTaskToReply(proposal, previous, '再来一张，换个方向'), /确认/);
    assert.throws(() => bindTaskToReply(proposal, previous, '继续生成一张同样的杯子'), /确认/);
    assert.throws(() => bindTaskToReply(proposal, previous, '确认'), /确认/);
    assert.throws(() => bindTaskToReply({ ...proposal, intent: 'refine' }, previous, '把背景改成蓝色'), /确认/);
    assert.throws(() => bindTaskToReply({ ...proposal, promptPlan: { ...proposal.promptPlan, targetNodeId: 'cup' } },
        previous, '生成一张夜间足球场的照片'), /确认/);
    const linked = { intent: 'generate', taskUpdate: { mode: 'new' }, canvasPlan: {
        steps: [{ id: 'generate', type: 'ImageGenerate', parameters: { prompt: '夜里的足球场' } }],
        connections: [{ from: { ref: 'cup-prompt', port: 'text' }, to: { ref: 'generate', port: 'prompt' } }]
    } };
    assert.throws(() => bindTaskToReply(linked, previous, '生成一张夜间足球场的照片'), /确认/);
});

test('legacy new-task confirmations recover the request across repeated replies and compaction', () => {
    const prompt = '请确认是否开始新的创作任务；当前比例和分辨率仍会保留。';
    const request = '生成一张黑夜里的足球场照片';
    const store = createPromptAgentConversationStore();
    store.append({ role: 'user', text: request });
    store.append({ role: 'agent', text: prompt });
    store.compact('保留待确认的足球场请求');
    store.append({ role: 'user', text: '确认' });
    store.append({ role: 'agent', text: prompt });
    store.append({ role: 'user', text: '确认' });
    store.append({ role: 'agent', text: prompt });

    assert.equal(store.getConfirmedCreativeRequest('确认。').text, request);
    assert.equal(store.getConfirmedCreativeRequest('不确认'), null);
    assert.equal(createPromptAgentConversationStore().getConfirmedCreativeRequest('确认'), null);
    store.append({ role: 'agent', intent: 'clarify', text: prompt });
    assert.equal(store.getConfirmedCreativeRequest('确认'), null);
    assert.equal(store.getConfirmedCreativeRequest('确认', 4).text, request, 'resending an earlier confirmation uses its original context');
});

test('current explicit changes win and manual size answers persist only for their task',()=>{
 const task=bindTaskToReply(reply({}),null,'生成2K、16:9海报');
 const next=reply({});bindTaskToReply(next,task,'改为4K');assert.equal(next.promptPlan.parameters.resolution,'4K');
 const confirmed=confirmTaskParameters(task,{taskId:task.id},{resolution:'4K'});
 assert.equal(confirmed.parameters.resolution,'4K');assert.equal(confirmed.parameters.aspectRatio,'16:9');
 assert.equal(confirmTaskParameters(task,{taskId:'old'},{resolution:'1K'}),task);
});
test('step-specific settings do not spread and ambiguous multi-step sizes ask for scope',()=>{
 const make=()=>({canvasPlan:{steps:[{id:'a',type:'ImageGenerate',parameters:{prompt:'a'}},{id:'b',type:'ImageGenerate',parameters:{prompt:'b'}}]}});
 const r=make();r.taskUpdate={steps:{a:{resolution:{value:'2K',evidence:'2K'}}}};
 const task=bindTaskToReply(r,null,'第一张用2K');assert.equal(r.canvasPlan.steps[0].parameters.resolution,'2K');assert.equal(r.canvasPlan.steps[1].parameters.resolution,undefined);
 const next=make();bindTaskToReply(next,task,'继续改背景');assert.equal(next.canvasPlan.steps[0].parameters.resolution,'2K');
 assert.throws(()=>bindTaskToReply(make(),task,'改成4K'),/所有生图步骤/);
});

test('a per-step aspect answer stays selected when continuing a task-wide reference ratio', () => {
    const plan = () => ({ canvasPlan: { steps: ['hero', 'detail'].map(id => ({
        id, type: 'ImageGenerate', parameters: { prompt: id }
    })) } });
    const draft = { ...plan(), sizeIntent: { referenceSize: { width: 1200, height: 800 } } };
    const task = bindTaskToReply(draft, null, '生成两张不同的图，画幅统一参考图1');
    const confirmed = confirmTaskParameters(task, draft.canvasPlan, { aspectRatio: '1:1' }, 'hero');
    const continuation = plan();
    bindTaskToReply(continuation, JSON.parse(JSON.stringify(confirmed)), '仅换背景');
    const [hero, detail] = continuation.canvasPlan.steps;
    assert.equal(hero.sizeIntent.aspectRatio, '1:1');
    assert.deepEqual(detail.sizeIntent.referenceSize, { width: 1200, height: 800 });
    assert.ok(continuation.canvasPlan.steps.every(step => step.parameters.generationCount === undefined));
});

test('an evidenced shared ratio and total output count map to the distinct image steps', () => {
    const draft = { sizeIntent: { aspectRatio: '16:9', evidence: '两张都用16:9' },
        taskUpdate: { parameters: { count: { value: 2, evidence: '生成两张' } } },
        canvasPlan: { steps: ['hero', 'detail'].map(id => ({ id, type: 'ImageGenerate', parameters: { prompt: id } })) } };
    bindTaskToReply(draft, null, '生成两张不同的图，两张都用16:9');
    assert.deepEqual(draft.canvasPlan.steps.map(step => [step.sizeIntent.aspectRatio, step.parameters.generationCount]),
        [['16:9', undefined], ['16:9', undefined]]);
});

 test('new creative task discards old model dimension suggestions and unknown step settings are rejected',()=>{
 const task=bindTaskToReply(reply({}),null,'生成2K、16:9海报');
 const next=reply({resolution:'2K',aspectRatio:'16:9'});
 bindTaskToReply(next,task,'开始全新创作');assert.deepEqual(next.promptPlan.parameters,{});
 assert.throws(()=>bindTaskToReply({...reply({}),taskUpdate:{steps:{missing:{resolution:{value:'2K',evidence:'2K'}}}}},task,'2K'),/修改对象/);
 });
