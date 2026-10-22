// Explicit creative requirements survive summaries; model suggestions never become defaults.
const keys=['resolution','aspectRatio','customWidth','customHeight','count','quality','moderation','background','negativePrompt'];
const aliases={aspect:'aspectRatio',generationCount:'count'};
const clone=value=>JSON.parse(JSON.stringify(value));
export function taskParameters(value={}) {
 const result={};
 for(const [raw,v] of Object.entries(value||{})) {const key=aliases[raw]||raw;if(keys.includes(key)&&['string','number'].includes(typeof v))result[key]=v;}
 return result;
}
export function restoreCreativeTask(value) {
 if(!value||value.version!==1||typeof value.id!=='string')return null;
 return {version:1,id:value.id,parameters:taskParameters(value.parameters),steps:Object.fromEntries(Object.entries(value.steps||{}).map(([id,v])=>[id,taskParameters(v)]))};
}
export function explicitTaskParameters(message) {
 const values={};
 const resolution=message.match(/(?:^|[^a-z0-9])([124])\s*k\b/i);if(resolution)values.resolution=resolution[1]+'K';
 const ratio=message.match(/(?:^|[^\d])(\d{1,2})\s*[:：]\s*(\d{1,2})(?!\d)/);if(ratio)values.aspectRatio=ratio[1]+':'+ratio[2];
 const dimensions=message.match(/(?:宽高|尺寸|自定义|分辨率)?\s*(\d{2,5})\s*[xX×*]\s*(\d{2,5})/);
 if(dimensions)Object.assign(values,{resolution:'custom',customWidth:Number(dimensions[1]),customHeight:Number(dimensions[2])});
 const count=message.match(/(?:生成|输出|数量(?:为|设为)?)\s*(\d{1,2})\s*张/);if(count)values.count=Number(count[1]);
 return values;
}
export function updateCreativeTask(previous,message,update={},scopeCount=1) {
 let task=restoreCreativeTask(previous)||{version:1,id:crypto.randomUUID(),parameters:{},steps:{}};
 const newTask=/(?:开始|做|生成|画).{0,5}(?:全新|新的一|另一个|另一张)|新任务|重新开始|\bnew (?:task|project)\b/i.test(message);
 if(update.mode==='new'&&!newTask)throw new Error('请确认是否开始新的创作任务；当前比例和分辨率仍会保留。');
 if(newTask)task={version:1,id:crypto.randomUUID(),parameters:{},steps:{}};
 const read=fields=>{const result={};for(const [key,item] of Object.entries(fields||{})){
  if(!keys.includes(aliases[key]||key)||!item||typeof item.evidence!=='string'||!item.evidence.trim()||!message.includes(item.evidence))throw new Error('参数变更缺少本轮明确依据，请确认需要修改的参数。');
  const canonical=aliases[key]||key;
  const parsed=explicitTaskParameters(item.evidence);
  if (['resolution','aspectRatio','customWidth','customHeight','count'].includes(canonical) && parsed[canonical]!==item.value) throw new Error('参数值与本轮原文不一致，请确认具体参数。');
  if (!['resolution','aspectRatio','customWidth','customHeight','count'].includes(canonical) && !item.evidence.includes(String(item.value)) && !({high:/高(?:画质|质量)/,low:/低(?:画质|质量)/,medium:/中(?:画质|质量)/,transparent:/透明/,opaque:/不透明/,auto:/自动/}[item.value]?.test(item.evidence))) throw new Error('参数变更依据不明确，请确认具体设置。');
  Object.assign(result,taskParameters({[key]:item.value}));
 }return result;};
 const explicit={...read(update.parameters),...(scopeCount<=1?explicitTaskParameters(message):{})};
 if(scopeCount>1&&Object.keys(explicitTaskParameters(message)).length&&!Object.keys(explicit).length&&!Object.keys(update.steps||{}).length)throw new Error('请确认这些尺寸参数适用于所有生图步骤，还是某个具体步骤。');
 task.parameters={...task.parameters,...explicit};
 for(const [id,fields] of Object.entries(update.steps||{}).filter(([id])=>!['__proto__','constructor','prototype'].includes(id)))task.steps[id]={...task.steps[id],...read(fields)};
 if(explicit.resolution&&explicit.resolution!=='custom'){delete task.parameters.customWidth;delete task.parameters.customHeight;}
 return {task,explicit,newTask};
}
export function bindTaskToReply(reply,previous,message) {
 const count=reply.canvasPlan?.steps.filter(s=>s.type==='ImageGenerate').length||1;
 for(const id of Object.keys(reply.taskUpdate?.steps||{})) if(['__proto__','constructor','prototype'].includes(id)||!reply.canvasPlan?.steps.some(s=>s.id===id&&s.type==='ImageGenerate')) throw new Error('步骤参数无法对应当前方案，请确认修改对象。');
 const {task,explicit,newTask}=updateCreativeTask(previous,message,reply.taskUpdate,count);
 const apply=(parameters,stepId)=>{
  const inherited={...task.parameters,...(task.steps[stepId]||{})};
  const merged={...(newTask?{}:taskParameters(parameters)),...inherited};
  const sources=Object.fromEntries(Object.keys(merged).map(key=>[key,Object.hasOwn(explicit,key)||reply.taskUpdate?.steps?.[stepId]?.[key]?'本轮设置':Object.hasOwn(inherited,key)?'沿用任务':'方案建议']));
  return {merged,sources};
 };
 if(reply.promptPlan){const {merged,sources}=apply(reply.promptPlan.parameters,'generate');
  reply.promptPlan.parameters={...(newTask?Object.fromEntries(Object.entries(reply.promptPlan.parameters||{}).filter(([key])=>!keys.includes(aliases[key]||key))):reply.promptPlan.parameters),...merged};delete reply.promptPlan.parameters.negativePrompt;
  if(Object.hasOwn(merged,'negativePrompt'))reply.promptPlan.negativePrompt=merged.negativePrompt;
  reply.promptPlan.parameterSources=sources;reply.promptPlan.taskId=task.id;
 }
 if(reply.canvasPlan){reply.canvasPlan.taskId=task.id;reply.canvasPlan.newCreativeTask=newTask;
  for(const step of reply.canvasPlan.steps.filter(s=>s.type==='ImageGenerate')){
   const {merged,sources}=apply({...step.parameters,...step.generationPatch},step.id);
   if(newTask) for(const fields of [step.parameters,step.generationPatch]) if(fields) for(const key of Object.keys(fields)) if(keys.includes(aliases[key]||key)) delete fields[key];
   for(const [key,value] of Object.entries(merged)){
    if(key==='negativePrompt')step.negativePrompt=value;
    else step.parameters[key==='aspectRatio'?'aspect':key==='count'?'generationCount':key]=value;
   }
   if(step.generationPatch){Object.assign(step.generationPatch,merged);delete step.generationPatch.negativePrompt;}
   step.parameterSources=sources;
  }
 }
 return task;
}
export function confirmTaskParameters(task,plan,parameters,stepId='generate') {
 if(!task||task.id!==plan.taskId)return task;
 const next=clone(task),values=taskParameters(parameters);
 if(plan.steps?.filter(s=>s.type==='ImageGenerate').length>1) next.steps[stepId]={...next.steps[stepId],...values};
 else next.parameters={...next.parameters,...values};
 if(values.resolution&&values.resolution!=='custom'){const target=plan.steps?.filter(s=>s.type==='ImageGenerate').length>1?next.steps[stepId]:next.parameters;delete target.customWidth;delete target.customHeight;}
 return next;
}
