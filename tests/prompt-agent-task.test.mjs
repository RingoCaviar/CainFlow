import test from 'node:test';
import assert from 'node:assert/strict';
import {bindTaskToReply,confirmTaskParameters,updateCreativeTask} from '../js/features/prompt-agent/prompt-agent-task.js';
import {createPromptAgentConversationStore} from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
import {createPromptAgentInput} from '../js/features/prompt-agent/prompt-agent-input.js';
const reply=parameters=>({promptPlan:{prompt:'海报',parameters}});
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

 test('new creative task discards old model dimension suggestions and unknown step settings are rejected',()=>{
 const task=bindTaskToReply(reply({}),null,'生成2K、16:9海报');
 const next=reply({resolution:'2K',aspectRatio:'16:9'});
 bindTaskToReply(next,task,'开始全新创作');assert.deepEqual(next.promptPlan.parameters,{});
 assert.throws(()=>bindTaskToReply({...reply({}),taskUpdate:{steps:{missing:{resolution:{value:'2K',evidence:'2K'}}}}},task,'2K'),/修改对象/);
 });
