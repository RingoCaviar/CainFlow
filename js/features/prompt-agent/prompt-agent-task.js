// Explicit creative requirements survive summaries; model suggestions never become defaults.
const keys=['resolution','aspectRatio','customWidth','customHeight','count','quality','moderation','background','negativePrompt'];
const aliases={aspect:'aspectRatio',generationCount:'count'};
const clone=value=>JSON.parse(JSON.stringify(value));
const newTaskConfirmationMessage = '请确认是否开始新的创作任务；当前比例和分辨率仍会保留。';
const confirmsNewTask = text => /^(?:确认|确定|同意|是|好(?:的)?|可以|yes|confirm|ok)[。！.!]*$/i.test(text?.trim());
function requestsContinuation(message, editsCurrentAttachment) {
    const request = message.replace(/^(?:(?:请|帮我|只|仅)\s*)+/, '');
    return /^(?:(?:继续|接着)(?:$|[，。]|改|调|修|优化)|沿用|保留原|continue\b|revise\b|make it\b)/i.test(request)
        || /^(?:继续|接着).{0,20}(?:同样|一样|同款|上一|上次|刚才|原图)/.test(request)
        || /^(?:在|基于|根据)?(?:上一张|上一版|刚才的|当前方案)/.test(request)
        || /^再来(?:一张|一版)?(?:[，,\s]+换(?:个|一)?(?:方向|思路))?[。！!]*$/.test(request)
        || (editsCurrentAttachment ? /^(?:继续|接着)/.test(request)
            : /^(?:(?:把|将).{1,20}(?:改成|换成)|edit\b|(?:在|基于|根据)?(?:这张|原图))/i.test(request));
}

function hasIndependentImagePlan(reply) {
    const attachedEdit = reply.editsCurrentAttachment === true;
    if (reply.intent !== 'generate' && !attachedEdit) return false;
    const { canvasPlan, promptPlan } = reply;
    if (canvasPlan) {
        return !canvasPlan.deletes?.length && !canvasPlan.disconnects?.length
            && canvasPlan.steps.some(step => step.type === 'ImageGenerate')
            && canvasPlan.steps.every(step => !step.nodeId)
            && !canvasPlan.connections?.some(link => link.to.port === 'prompt'
                && !canvasPlan.steps.some(step => step.id === link.from.ref));
    }
    return Boolean(promptPlan && !promptPlan.targetNodeId && !promptPlan.preserveReferenceSnapshot
        && (attachedEdit || !promptPlan.referenceImages?.some(image => image.role === 'edit-target')));
}

export class CreativeTaskConfirmationRequired extends Error {
    static intent = 'confirm-new-creative-task';

    constructor() {
        super(newTaskConfirmationMessage);
    }
}

export function isCreativeTaskConfirmation(message) {
    // Older conversations stored this local error without an intent marker.
    return message?.role === 'agent' && (message.intent === CreativeTaskConfirmationRequired.intent
        || (!message.intent && message.text === newTaskConfirmationMessage));
}

export function findConfirmedCreativeRequest(message, messages, archivedMessages, beforeIndex) {
    if (!confirmsNewTask(message)) return null;
    const history = [...archivedMessages, ...messages];
    for (let index = (beforeIndex ?? history.length) - 1; index > 0; index -= 2) {
        if (!isCreativeTaskConfirmation(history[index])) break;
        const request = history[index - 1];
        if (request.role !== 'user') break;
        if (!confirmsNewTask(request.text)) return request;
    }
    return null;
}

export function taskParameters(value={}) {
 const result={};
 for(const [raw,v] of Object.entries(value||{})) {const key=aliases[raw]||raw;if(keys.includes(key)&&['string','number'].includes(typeof v))result[key]=v;}
 return result;
}
export function restoreCreativeTask(value) {
 if(!value||value.version!==1||typeof value.id!=='string')return null;
 return {version:1,id:value.id,parameters:taskParameters(value.parameters),steps:Object.fromEntries(Object.entries(value.steps||{}).map(([id,v])=>[id,
    {...taskParameters(v), ...Object.fromEntries(Object.entries(v||{}).filter(([key,val])=>keys.includes(key)&&val===null))}])),
    ...(value.sizeIntent ? {sizeIntent:clone(value.sizeIntent)} : {}), ...(value.stepSizeIntents ? {stepSizeIntents:clone(value.stepSizeIntents)} : {})};
}

const chineseDigits = '零一二三四五六七八九';

function countValue(text) {
    const numeral = text.replace(/两/g, '二');
    if (!numeral.includes('十')) {
        return /^\d+$/.test(numeral) ? Number(numeral) : chineseDigits.indexOf(numeral);
    }
    const [tens, units] = numeral.split('十');
    return (tens ? chineseDigits.indexOf(tens) : 1) * 10 + (units ? chineseDigits.indexOf(units) : 0);
}

function outputCountMatches(message) {
    const pattern = /(?:生成|输出|出图|生图|(?:^|[，。；！？,.!?\s]|帮我|给我|请|先|再|直接|只|就)\s*(?:出|画|做)|再来|(?:数量|张数)(?:为|设为|改成|改为|[:：=])?)\s*(\d{1,2}|[二三四五六七八九]?十[一二三四五六七八九]?|[一二两三四五六七八九])\s*张/gd;
    const unquoted = message.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g, quoted => ' '.repeat(quoted.length));
    return [...unquoted.matchAll(pattern)].filter(match => countValue(match[1]) > 0
        && !/(?:不要|不用|别|无需|不是|禁止)\s*$/.test(unquoted.slice(0, match.index)));
}

function countSupportedByEvidence(message, evidence, value) {
    const evidenceOffsets = [];
    for (let offset = message.indexOf(evidence); offset >= 0; offset = message.indexOf(evidence, offset + 1)) {
        evidenceOffsets.push(offset);
    }
    return outputCountMatches(message).some(match => {
        const [start] = match.indices[1];
        const end = match.index + match[0].length;
        return countValue(match[1]) === value
            && evidenceOffsets.some(offset => offset <= start && offset + evidence.length >= end);
    });
}

export function explicitTaskParameters(message) {
 const values={};
 const resolution=message.match(/(?:^|[^a-z0-9])([124])\s*k\b/i);if(resolution)values.resolution=resolution[1]+'K';
 const ratio=message.match(/(?:^|[^\d])([1-9]\d{0,4})\s*[:：]\s*([1-9]\d{0,4})(?!\d)/);if(ratio)values.aspectRatio=ratio[1]+':'+ratio[2];
 const dimensions=message.match(/(?:宽高|尺寸|自定义|分辨率)?\s*(\d{2,5})\s*[xX×*]\s*(\d{2,5})/);
 if(dimensions)Object.assign(values,{resolution:'custom',customWidth:Number(dimensions[1]),customHeight:Number(dimensions[2])});
 const counts = new Set(outputCountMatches(message).map(match => countValue(match[1])));
 if (counts.size === 1) values.count = counts.values().next().value;
 return values;
}
export function updateCreativeTask(previous,message,update={},scopeCount=1,{confirmedNewTask=false,independentGeneration=false,recoverParameterUpdates=false,scopedAspect=false}={}) {
 const newTask=confirmedNewTask||independentGeneration||/(?:开始|做|生成|画).{0,5}(?:全新|新的一|另一个|另一张)|新任务|重新开始|\bnew (?:task|project)\b/i.test(message);
 if(update.mode==='new'&&!newTask)throw new CreativeTaskConfirmationRequired();
 const task=(!newTask&&restoreCreativeTask(previous))||{version:1,id:crypto.randomUUID(),parameters:{},steps:{}};
 const rejected = new Map();
 const stepUpdates = new Map();
 const read = (fields, stepId) => {
    const result = {};
    for (const [key, item] of Object.entries(fields || {})) {
        const canonical = aliases[key] || key;
        try {
            result[canonical] = evidencedParameter(message, canonical, item);
        } catch (error) {
            if (!recoverParameterUpdates) throw error;
            if (!rejected.has(stepId)) rejected.set(stepId, new Set());
            rejected.get(stepId).add(canonical);
        }
    }
    return result;
 };
 const explicit={...read(update.parameters),...(scopeCount<=1?explicitTaskParameters(message):{})};
 if (scopeCount > 1 && explicit.count === scopeCount && !/(?:每|各)(?:个步骤|张|种|组)|分别(?:生成|输出)|each/i.test(update.parameters?.count?.evidence || '')) delete explicit.count;
 if(scopeCount>1&&Object.keys(explicitTaskParameters(message)).some(key=>key!=='count'&&!(key==='aspectRatio'&&scopedAspect))&&!Object.keys(explicit).length&&!Object.keys(update.steps||{}).length)throw new Error('请确认这些尺寸参数适用于所有生图步骤，还是某个具体步骤。');
 task.parameters={...task.parameters,...explicit};
 for(const [id,fields] of Object.entries(update.steps||{}).filter(([id])=>!['__proto__','constructor','prototype'].includes(id))) {
    const values = read(fields, id);
    stepUpdates.set(id, values);
    task.steps[id] = {...task.steps[id],...values};
 }
 if(explicit.resolution&&explicit.resolution!=='custom'){delete task.parameters.customWidth;delete task.parameters.customHeight;}
 return {task,explicit,newTask,rejected,stepUpdates};
}

function evidencedParameter(message, key, item) {
    if (!keys.includes(key) || typeof item?.evidence !== 'string' || !item.evidence.trim() || !message.includes(item.evidence)) {
        throw new Error('参数变更缺少本轮明确依据，请确认需要修改的参数。');
    }
    const { evidence } = item;
    const numeric = ['count', 'customWidth', 'customHeight'].includes(key);
    const value = numeric && typeof item.value === 'string' && /^\d+$/.test(item.value.trim()) ? Number(item.value) : item.value;
    if (key === 'count' || ['resolution','aspectRatio','customWidth','customHeight'].includes(key)) {
        const matches = key === 'count' ? countSupportedByEvidence(message, evidence, value) : explicitTaskParameters(evidence)[key] === value;
        if (value === undefined || !matches) throw new Error('参数值与本轮原文不一致，请确认具体参数。');
    } else {
        const localized = {high:/高(?:画质|质量)/,low:/低(?:画质|质量|限制)/,medium:/中(?:画质|质量)/,transparent:/透明/,opaque:/不透明/,auto:/自动/};
        if (typeof value !== 'string' || !value || (key === 'background' && value === 'transparent' && /不透明/.test(evidence))
            || (!evidence.includes(value) && !localized[value]?.test?.(evidence))) throw new Error('参数变更依据不明确，请确认具体设置。');
    }
    return value;
}

function updateSizeIntent(owner, key, parameters, explicit, intent) {
    if (intent?.referenceSize || intent?.referenceUnavailable || intent?.aspectRatio && !explicit.aspectRatio) {
        owner[key] = clone(intent);
        if (!explicit.aspectRatio) delete parameters.aspectRatio;
        if (parameters.resolution === 'custom' && explicit.resolution !== 'custom') {
            delete parameters.resolution;
            delete parameters.customWidth;
            delete parameters.customHeight;
        }
    } else if (explicit.aspectRatio || explicit.resolution === 'custom') {
        delete owner[key];
    }
}

export function bindTaskToReply(reply,previous,message,{confirmedNewTask=false,canSetImageParameters=false}={}) {
 const count=reply.canvasPlan?.steps.filter(s=>s.type==='ImageGenerate').length||1;
 for(const id of Object.keys(reply.taskUpdate?.steps||{})) if(['__proto__','constructor','prototype'].includes(id)||!reply.canvasPlan?.steps.some(s=>s.id===id&&s.type==='ImageGenerate')) throw new Error('步骤参数无法对应当前方案，请确认修改对象。');
 const request = message.trim();
 const independentGeneration = reply.taskUpdate?.mode === 'new' && Boolean(request) && !confirmsNewTask(request)
     && !requestsContinuation(request, reply.editsCurrentAttachment === true) && hasIndependentImagePlan(reply);
 const taskUpdate = reply.editsCurrentAttachment === true && reply.taskUpdate?.mode === 'new' && !independentGeneration
     ? { ...reply.taskUpdate, mode: 'continue' } : reply.taskUpdate;
 const generation = Boolean(reply.promptPlan || reply.canvasPlan?.steps.some(step => step.type === 'ImageGenerate'));
 if (!generation) return restoreCreativeTask(previous);
 const sizeIntent = reply.sizeIntent;
 const {task,explicit,newTask,rejected,stepUpdates}=updateCreativeTask(previous,message,taskUpdate,count,{
    confirmedNewTask,independentGeneration,recoverParameterUpdates:true,scopedAspect:Boolean(sizeIntent?.aspectRatio || sizeIntent?.steps)
 });
 updateSizeIntent(task, 'sizeIntent', task.parameters, explicit, sizeIntent?.steps ? null : sizeIntent);
 if (sizeIntent?.steps || task.stepSizeIntents || stepUpdates.size) {
    const intents = task.stepSizeIntents ||= {};
    const imageSteps = reply.canvasPlan?.steps.filter(step => step.type === 'ImageGenerate') || [];
    for (const {id} of imageSteps) {
        const changes = stepUpdates.get(id) || {};
        if (explicit.aspectRatio || explicit.resolution === 'custom' || sizeIntent && !sizeIntent.steps) delete intents[id];
        updateSizeIntent(intents, id, task.steps[id] ||= {}, changes, sizeIntent?.steps?.[id]);
        if (changes.aspectRatio || changes.resolution === 'custom') intents[id] = null;
    }
    if (!Object.keys(intents).length) delete task.stepSizeIntents;
 }
 const apply=(parameters,stepId)=>{
  const inherited={...task.parameters,...(task.steps[stepId]||{})};
  const changes = stepUpdates.get(stepId) || {};
  const suggestions = newTask && !canSetImageParameters ? {} : taskParameters(parameters);
  for (const key of [...(rejected.get(undefined) || []), ...(rejected.get(stepId) || [])]) delete suggestions[key];
  const requestedSize = Object.hasOwn(task.stepSizeIntents || {}, stepId) ? task.stepSizeIntents[stepId] : task.sizeIntent;
  if (requestedSize) {
      delete suggestions.aspectRatio;
      if (suggestions.resolution === 'custom') {
          delete suggestions.resolution;
          delete suggestions.customWidth;
          delete suggestions.customHeight;
      }
      delete inherited.aspectRatio;
      if (inherited.resolution === 'custom' && (changes.resolution ?? explicit.resolution) !== 'custom') {
          delete inherited.resolution;
          delete inherited.customWidth;
          delete inherited.customHeight;
      }
  }
  const requested = reply.requestedImageParameters?.steps ? reply.requestedImageParameters.steps[stepId] || {} : reply.requestedImageParameters || {};
  const { search, protocolParams } = requested;
  const currentSettings = { ...changes, ...explicit, ...(search !== undefined ? {search} : {}), ...(protocolParams ? {protocolParams} : {}) };
  const merged={...suggestions,...inherited, ...(search !== undefined ? {search} : {}),
      ...(protocolParams ? {protocolParams:{...parameters?.protocolParams,...protocolParams}} : {})};
  for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
  const sources=Object.fromEntries(Object.keys(merged).map(key=>[key,Object.hasOwn(currentSettings,key)?'本轮设置':Object.hasOwn(inherited,key)?'沿用任务':'方案建议']));
  if (protocolParams) for (const key of Object.keys(protocolParams)) sources[`protocolParams.${key}`] = '本轮设置';
  return {merged,sources,requestedSize:requestedSize || (inherited.aspectRatio && {aspectRatio:inherited.aspectRatio})};
 };
 if(reply.promptPlan){const {merged,sources,requestedSize}=apply(reply.promptPlan.parameters,'generate');
  reply.promptPlan.parameters={...Object.fromEntries(Object.entries(reply.promptPlan.parameters||{}).filter(([key])=>!keys.includes(aliases[key]||key))),...merged};delete reply.promptPlan.parameters.negativePrompt;
  if(Object.hasOwn(merged,'negativePrompt'))reply.promptPlan.negativePrompt=merged.negativePrompt;
  if(requestedSize)reply.promptPlan.sizeIntent=requestedSize;
  else delete reply.promptPlan.sizeIntent;
  reply.promptPlan.parameterSources=sources;reply.promptPlan.taskId=task.id;
 }
 if(reply.canvasPlan){reply.canvasPlan.taskId=task.id;reply.canvasPlan.newCreativeTask=newTask;
  for(const step of reply.canvasPlan.steps.filter(s=>s.type==='ImageGenerate')){
   const {merged,sources,requestedSize}=apply({...step.parameters,...step.generationPatch},step.id);
   for(const fields of [step.parameters,step.generationPatch]) if(fields) for(const key of Object.keys(fields)) if(keys.includes(aliases[key]||key)) delete fields[key];
   for(const [key,value] of Object.entries(merged)){
    if(key==='negativePrompt')step.negativePrompt=value;
    else step.parameters[key==='aspectRatio'?'aspect':key==='count'?'generationCount':key]=value;
   }
   if(step.generationPatch){Object.assign(step.generationPatch,merged);delete step.generationPatch.negativePrompt;}
   if(requestedSize)step.sizeIntent=requestedSize;
   else delete step.sizeIntent;
   step.parameterSources=sources;
  }
 }
 return task;
}
export function confirmTaskParameters(task,plan,parameters,stepId='generate') {
 if(!task||task.id!==plan.taskId)return task;
 const next=clone(task),values=taskParameters(parameters);
 const perStep = plan.steps?.filter(step => step.type === 'ImageGenerate').length > 1;
 const target = perStep ? next.steps[stepId] ||= {} : next.parameters;
 Object.assign(target, values);
 for (const [key, value] of Object.entries(parameters)) {
    if (value !== null || !keys.includes(key)) continue;
    if (perStep) target[key] = null;
    else delete target[key];
 }
 if (Object.hasOwn(values, 'resolution') && values.resolution !== 'custom') {
    delete target.customWidth;
    delete target.customHeight;
 }
 if (values.resolution === 'custom' && values.customWidth && values.customHeight) delete target.aspectRatio;
 if(Object.hasOwn(values,'aspectRatio')||values.resolution==='custom') {
    if(perStep) {
        const intents = next.stepSizeIntents ||= {};
        // An explicit per-step choice takes priority over a task-wide reference.
        intents[stepId] = null;
    } else delete next.sizeIntent;
 }
 return next;
}
