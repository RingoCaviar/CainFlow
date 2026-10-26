/* THROWAWAY. Local illustrative interaction model, not a replacement for CainFlow execution. */
const assetRoot = 'artifacts/prototype-image-assistant/';
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = value => JSON.parse(JSON.stringify(value));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const state = {
 variant: ['A','B','C'].includes(new URLSearchParams(location.search).get('variant')) ? new URLSearchParams(location.search).get('variant') : 'A',
 prompt: $('#node-prompt').value, model:'示例图像模型 A',provider:'我的示例供应商',aspect:'4:3',resolution:'2K',count:1,quality:'默认',width:2048,height:1536,
 systemPrompt:'',moderation:'默认',background:'默认',thinking:'接口默认',thinkingBudget:4096,taskId:'',chatModel:'示例对话模型',agentModel:'示例图像模型 A',
 agentThinking:'接口默认',agentSearch:false,agentSize:'跟随方案',agentWidth:2048,agentHeight:1536,agentBudget:4096,compactionModel:'跟随对话模型',autoCompact:24000,nodeEnabled:true,nodeCollapsed:false,nodeName:'客厅生图',target:'客厅生图',nodeRefs:['architecture','palette'],agentRefs:[],
 assets:[{id:'architecture',name:'空间结构',src:assetRoot+'scene.svg',source:'场景',purpose:'保持空间结构与构图'},{id:'palette',name:'材质与色彩',src:assetRoot+'palette.svg',source:'场景',purpose:'参考材质与配色'},{id:'history-warm',name:'暖光探索 · 历史',src:assetRoot+'scene.svg',source:'历史',purpose:'参考光影',filter:'sepia(.22) saturate(1.1)'},{id:'history-cool',name:'清晨氛围 · 历史',src:assetRoot+'scene.svg',source:'历史',purpose:'参考氛围',filter:'saturate(.65) hue-rotate(20deg)'}],
 results:[{id:'sample-0',src:assetRoot+'scene.svg',filter:'',model:'示例图像模型 A',size:'2048 × 1536',sample:true}],resultIndex:0,messages:[],archived:[],plans:[],undo:[],redo:[],revision:0,running:false,progress:0,runError:'',failNext:false,runEpoch:0,zoom:100,inspectorTab:'parameters',extraNodes:[],lastAction:'初始示例状态',activeRunPlan:null,assistantBusy:false,assistantEpoch:0
};
let toastTimer, pickerDestination='node',pickerSelected=[],pickerTab='场景',pickerQuery='',draggedRef=null;
const modal = $('#modal');
function notify(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4200)}
function record(action){state.lastAction=action;$('#save-state').textContent='演示中 · 有修改'}
function asset(id){return state.assets.find(a=>a.id===id)}
function imageMarkup(a, extra=''){return `<img src="${escapeHtml(a.src)}" alt="${escapeHtml(a.name||'示例结果')}" style="filter:${escapeHtml(a.filter||'')}" ${extra}>`}
function dimensions(){if(state.resolution==='自定义')return `${state.width} × ${state.height}`;if(state.resolution==='自动'||state.aspect==='由模型决定')return '自动（由模型决定）';const base={'1K':1024,'2K':2048,'4K':4096}[state.resolution]||2048;const [w,h]=state.aspect.split(':').map(Number);return w>=h?`${base} × ${Math.round(base*h/w/8)*8}`:`${Math.round(base*w/h/8)*8} × ${base}`}
function nodeSnapshot(){return {prompt:state.prompt,model:state.model,provider:state.provider,aspect:state.aspect,resolution:state.resolution,count:state.count,quality:state.quality,width:state.width,height:state.height,nodeRefs:[...state.nodeRefs],nodeName:state.nodeName,nodeEnabled:state.nodeEnabled,nodeCollapsed:state.nodeCollapsed,extraNodes:clone(state.extraNodes)}}
function pushUndo(){state.undo.push(nodeSnapshot());state.redo=[]}
function setVariant(key){
 state.variant=key;document.body.className=`v-${key}${state.inspectorTab==='assistant'?' assistant-tab':''}`;
 const stage=$('#stage-content'),editor=$('#editor-panel'),result=$('#result-panel');
 if(key==='A'){stage.insertBefore(editor,result);stage.append(result)}else{$('#inspector-content').append(editor);stage.append(result)}
 $$('.variant-option').forEach(b=>b.classList.toggle('active',b.dataset.variant===key));
 const url=new URL(location.href);url.searchParams.set('variant',key);history.replaceState(null,'',url);
 $('#layout-hint').textContent={A:'内容优先，完整节点留在画布中',B:'画布看关系，侧栏编辑选中节点',C:'大图居中，左右协作'}[key];
 record(`切换布局 ${key}，编辑、结果、方案和运行状态保留`);
 updateUI();
}
function updateUI(){
 $$('[data-bind]').forEach(el=>{if(document.activeElement!==el)el.value=state[el.dataset.bind]??''});
 $$('[data-summary]').forEach(el=>el.textContent=`${state.aspect} · ${state.resolution} · ${state.count} 张`);
 $('#custom-dimensions').hidden=state.resolution!=='自定义';
 $('#request-summary').textContent=`实际请求 · ${dimensions()}`;
 $('#search-state').textContent=state.agentSearch?'联网开':'联网关';
 const sendButton=$('.send-button');sendButton.dataset.action=state.assistantBusy?'cancel-agent':'send';sendButton.setAttribute('aria-label',state.assistantBusy?'停止助手回复':'发送消息');sendButton.innerHTML=state.assistantBusy?'■':icon('arrow');
 $('#advanced-summary').textContent=state.systemPrompt||state.thinking!=='接口默认'?'已设自定义参数':'供应商、系统提示词、思考等';
 $('#node-ref-count').textContent=state.nodeRefs.length;
 const referenceItem=(id,index)=>{const a=asset(id);if(!a)return '';return `<div class="reference-item" draggable="true" data-ref-id="${escapeHtml(id)}">${imageMarkup(a)}<button class="ref-remove" data-action="remove-node-ref" data-id="${escapeHtml(id)}" aria-label="移除参考图${index+1}">×</button><div class="ref-caption"><span class="ref-number">${index+1}</span>${escapeHtml(a.name)}<span class="ref-move"><button data-action="ref-left" data-id="${escapeHtml(id)}" aria-label="参考图${index+1}前移" ${index===0?'disabled':''}>←</button><button data-action="ref-right" data-id="${escapeHtml(id)}" aria-label="参考图${index+1}后移" ${index===state.nodeRefs.length-1?'disabled':''}>→</button></span></div></div>`};
 $('#node-references').innerHTML=state.nodeRefs.length?state.nodeRefs.map(referenceItem).join(''):'<button class="source-add full" data-action="references" data-destination="node">＋ 添加参考图，也可以直接拖入图片</button>';
 $('#agent-references').innerHTML=state.agentRefs.map((id,index)=>{const a=asset(id);return a?`<div class="agent-ref">${imageMarkup(a)}<span>${index+1} ${escapeHtml(a.name)}</span><button data-action="remove-agent-ref" data-id="${escapeHtml(id)}" aria-label="移除助手参考图${index+1}">×</button></div>`:''}).join('');
 $('#generate-button').disabled=state.running||!state.nodeEnabled;
 $('#generate-button').hidden=state.running;$('#cancel-button').hidden=!state.running;
 $$('[data-action="generate"]').forEach(b=>b.disabled=state.running||!state.nodeEnabled);
 $$('[data-bind]', $('#editor-panel')).forEach(el=>el.disabled=state.running);
 $('#editor-content').hidden=state.nodeCollapsed;
 $('.node-heading h2').innerHTML=`${escapeHtml(state.nodeName)} <span class="node-id">#03</span>`;
 $('.compact-title strong').textContent=state.nodeName;
 $('.context-target').innerHTML=`${escapeHtml(state.target||'新建节点')} <span>⌄</span>`;
 const feedback=$('#execution-feedback');feedback.classList.toggle('error',Boolean(state.runError));
 feedback.innerHTML=state.running?`正在生成 · ${state.progress}% <span class="small">演示进度</span><div class="progress-track"><div class="progress-fill" style="width:${state.progress}%"></div></div>`:state.runError?`${escapeHtml(state.runError)}<button data-action="retry">重试未完成步骤</button><button data-action="logs">查看日志</button>`:state.progress===100?'✓ 生成完成 · 示例结果已保留':'';
 const result=state.results[state.resultIndex];
 $('#result-count').textContent=`${String(state.resultIndex+1).padStart(2,'0')} / ${String(state.results.length).padStart(2,'0')}`;
 if(result){$('#result-image').src=result.src;$('#result-image').style.filter=result.filter||'';$('#result-metadata').textContent=`${result.model} · ${result.size} · 示例插画`}
 $('#result-thumbnails').innerHTML=state.results.length>1?state.results.map((r,i)=>`<button class="result-thumbnail ${i===state.resultIndex?'active':''}" data-action="select-result" data-index="${i}" aria-label="查看结果${i+1}" aria-pressed="${i===state.resultIndex}">${imageMarkup(r)}</button>`).join(''):'';
 $('#zoom-label').textContent=`${state.zoom}%`;
 $$('.inspector-tabs button').forEach(b=>b.classList.toggle('active',b.dataset.action===`inspector-${state.inspectorTab}`));
 $$('.source-node.extra-source').forEach(el=>el.remove());
 state.assets.filter(a=>a.source==='本地'||a.source==='导入的历史'||a.source==='结果').forEach(a=>{const b=document.createElement('button');b.className='source-node extra-source';b.dataset.action='reference-detail';b.dataset.id=a.id;b.innerHTML=`<span class="source-node-head">${escapeHtml(a.name)}</span>${imageMarkup(a)}<span class="source-node-foot">图片导入<span>image →</span></span>`;$('#source-rail').insertBefore(b,$('.source-add',$('#source-rail')))});
 $('.workbench-meta>span:not(.status-dot)').textContent=`示例工作流 · ${String(3+state.extraNodes.length+state.assets.filter(a=>['本地','导入的历史','结果'].includes(a.source)).length).padStart(2,'0')} 个节点`;
}
function openDialog(title,body,eyebrow='CAINFLOW / DESIGN STUDY'){if(modal.open)modal.close();$('#modal-title').textContent=title;$('#modal-eyebrow').textContent=eyebrow;$('#modal-body').innerHTML=body;modal.showModal()}
function closeDialog(){modal.close()}
function openReferences(destination='node',keep=false){
 if(!keep){pickerDestination=destination;pickerSelected=[...(destination==='agent'?state.agentRefs:state.nodeRefs)];pickerTab='场景';pickerQuery=''}
 let candidates=state.assets.filter(a=>pickerTab==='历史'?a.source==='历史':a.source!=='历史').filter(a=>a.name.includes(pickerQuery));
 openDialog('选择参考图',`<p>选择顺序就是图片编号。${pickerDestination==='agent'?'添加到助手仅作为对话上下文；连接到生图节点会在应用方案时明确展示。':'替换生图节点的有序参考图连接。'}导入历史或本地图片会保留对应的示例图片导入节点。</p><div class="dialog-tabs"><button data-action="picker-tab" data-tab="场景" class="${pickerTab==='场景'?'active':''}">场景</button><button data-action="picker-tab" data-tab="历史" class="${pickerTab==='历史'?'active':''}">历史</button><button data-action="upload">本地上传</button></div><div class="picker-tools"><input type="search" id="reference-search" placeholder="搜索名称或历史提示词" value="${escapeHtml(pickerQuery)}" aria-label="搜索参考图"><button class="text-button" data-action="picker-clear">清空选择</button></div><div class="picker-grid">${candidates.map(a=>`<button class="picker-item ${pickerSelected.includes(a.id)?'selected':''}" data-action="picker-select" data-id="${a.id}">${imageMarkup(a)}<span>${escapeHtml(a.name)}<b>${pickerSelected.includes(a.id)?pickerSelected.indexOf(a.id)+1:'＋'}</b></span></button>`).join('')||'<p>没有匹配的图片。</p>'}</div><div class="dialog-actions"><span class="small muted">已选 ${pickerSelected.length} 张 · 点击图片选择或取消</span><button class="button primary" data-action="picker-done">确认参考图</button></div>`);
}
function ensureImported(id){const a=asset(id);if(a?.source==='历史'){const newId=`import-${id}`;if(!asset(newId))state.assets.push({...a,id:newId,source:'导入的历史'});return newId}return id}
function openAgentSettings(){openDialog('助手设置',`<div class="dialog-fields"><div class="form-grid"><label class="field">对话模型<select data-bind="chatModel"><option>示例对话模型</option><option value="">未选择</option></select></label><label class="field">生图模型<select data-bind="agentModel"><option>示例图像模型 A</option><option>示例图像模型 B</option><option value="">未选择</option></select></label></div><label class="field">对话思考强度<select data-bind="agentThinking"><option>接口默认</option><option>关闭</option><option>低</option><option>中</option><option>高</option><option>自定义预算</option></select></label><label class="field">思考预算<input data-bind="agentBudget" type="number" min="0"></label><label class="inline-check"><input id="agent-search" type="checkbox" ${state.agentSearch?'checked':''}>联网搜索</label><label class="field">助手生图尺寸<select data-bind="agentSize"><option>跟随方案</option><option>1K · 1:1</option><option>2K · 4:3</option><option>4K · 16:9</option><option>自定义</option></select></label><div class="form-grid"><label class="field">自定义宽度<input data-bind="agentWidth" type="number"></label><label class="field">自定义高度<input data-bind="agentHeight" type="number"></label></div><label class="field">自动压缩阈值（Token）<input data-bind="autoCompact" type="number" min="1000" step="1000"></label><label class="field">压缩模型<select data-bind="compactionModel"><option>跟随对话模型</option><option>示例对话模型</option></select></label><p>本页只保存到当前演示会话；联网、压缩和思考均为界面模拟。生图模型由你明确选择。</p><button class="button primary" data-action="close-dialog">完成</button></div>`);updateUI()}
function planMarkup(plan){const stale=plan.revision!==state.revision&&!plan.applied;return `<div class="plan-card"><div class="plan-top"><span>${icon('spark')} 画布操作方案</span><span>${plan.applied?'已应用':stale?'需要刷新':'等待确认'}</span></div><div class="plan-body"><div class="plan-target">${plan.isNew?'新建节点':'修改目标'} · ${escapeHtml(plan.target)} · 方案 ${plan.id}</div><h3>${escapeHtml(plan.title)}</h3><p class="plan-prompt">${escapeHtml(plan.prompt)}</p><div class="plan-step"><span>1</span><div>${plan.isNew?'创建图片生成节点':'更新提示词与生成参数'}<div class="small muted">${escapeHtml(plan.target)} · ${escapeHtml(plan.model)}</div></div></div><div class="plan-step"><span>2</span><div>同步 ${plan.refs.length} 张参考图的连接<div class="small muted">${plan.refs.map(id=>escapeHtml(asset(id)?.name)).join(' → ')||'无参考图连接'}</div></div></div><div class="plan-step"><span>3</span><div>生成结果后保存<div class="small muted">保存节点及连接一起预览；演示中仅创建内存记录</div></div></div><div class="plan-meta"><span>${escapeHtml(plan.aspect)} · ${escapeHtml(plan.resolution)}</span><span>${plan.count} 张</span><span>包含生图 + 保存，共 2 个执行步骤</span></div><details class="message-work"><summary>字段与连接变化</summary><pre>${escapeHtml(JSON.stringify({target:plan.target,model:{from:state.model,to:plan.model},prompt:{from:plan.beforePrompt,to:plan.prompt},referenceConnections:{from:plan.beforeRefs,to:plan.refs},parameters:{aspect:plan.aspect,resolution:plan.resolution,count:plan.count},createSaveNode:true},null,2))}</pre></details></div><div class="plan-actions"><button class="button subtle" data-action="apply-plan" data-id="${plan.id}" ${state.running||stale?'disabled':''}>${plan.applied?'已应用到画布':'应用到画布'}</button><button class="button primary" data-action="apply-generate" data-id="${plan.id}" ${state.running||stale?'disabled':''}>${plan.applied?'生成图片':'应用并生成'}</button>${stale?`<button class="text-button" data-action="refresh-plan" data-id="${plan.id}">刷新方案</button>`:''}</div>${plan.applied?'<div class="plan-applied">✓ 画布变更可一次撤销 · 已有结果会保留</div>':''}</div>`}
function renderMessages(){
 const messages=$('#assistant-messages');if(!state.messages.length){$('.assistant-intro',messages)?.removeAttribute('hidden');$$('.message',messages).forEach(el=>el.remove());return}
 const intro=$('.assistant-intro',messages);if(intro)intro.hidden=true;$$('.message',messages).forEach(el=>el.remove());
 state.messages.forEach(m=>{const el=document.createElement('article');el.className=`message ${m.role==='user'?'user-message':'assistant-message'}`;const plan=state.plans.find(p=>p.id===m.planId);el.innerHTML=m.role==='user'?`${escapeHtml(m.text)}${m.refs?.length?`<div class="attached-text">随消息发送：${m.refs.map(id=>escapeHtml(asset(id)?.name)).join('、')}</div>`:''}`:`<div class="message-author">${icon('spark')} 创作助手 <span>示例回复</span></div><div class="message-body">${escapeHtml(m.text)}</div><details class="message-work"><summary>工作摘要 · ${m.summary?.length||2} 项</summary><ul>${(m.summary||['读取明确引用的节点与参考图','整理可确认的画布操作方案']).map(v=>`<li>${escapeHtml(v)}</li>`).join('')}</ul></details>${plan?planMarkup(plan):''}${m.resultId?`<div class="agent-result">${imageMarkup(state.results.find(r=>r.id===m.resultId)||state.results[0])}<div>结果已保留 · 示例插画<button class="button subtle" data-action="edit-result">继续修改</button><button class="button subtle" data-action="preview">查看大图</button></div></div>`:''}`;messages.append(el)});
 messages.scrollTop=messages.scrollHeight;
}
function sendMessage(){
 const input=$('#agent-input'),text=input.value.trim();if(!text){input.focus();return}
 if(text==='/clear'){state.messages=[];state.archived=[];state.plans=[];state.agentRefs=[];state.assistantEpoch++;state.assistantBusy=false;input.value='';record('清空本场景助手上下文');renderMessages();updateUI();notify('助手上下文已清空；画布节点和生成结果保留');return}
 if(text==='/compact'){state.archived.push(...state.messages);state.messages=[{role:'assistant',text:'已模拟压缩上下文：保留空间结构、胡桃木与陶土色方向，完整对话可从助手历史查看。',summary:['演示摘要，不发送模型请求','原消息保留在本次会话的历史中']}];input.value='';renderMessages();record('模拟压缩上下文，完整消息归档');notify('压缩完成（模拟），完整历史仍可查看');return}
 if(state.assistantBusy){notify('正在整理上一条方案，请稍等');return}
 if(!state.chatModel){notify('先选择对话模型，再发送消息');openAgentSettings();return}
 if(!state.agentModel){notify('先手动选择生图模型，再整理可执行方案');openAgentSettings();return}
 const refs=[...state.agentRefs];state.messages.push({role:'user',text,refs});input.value='';state.agentRefs=[];state.assistantBusy=true;const assistantEpoch=++state.assistantEpoch;renderMessages();updateUI();record('发送示例需求；节点尚未改变');notify('正在整理方案（模拟），画布保持当前状态');
 setTimeout(()=>{
  if(assistantEpoch!==state.assistantEpoch)return;
  const isNew=!text.includes(`@${state.nodeName}`)&&!text.includes(state.nodeName);
  const count=/两|2种|2 张/.test(text)?2:state.count;
  const cool=/清晨|冷静|冷色/.test(text),prompt=cool?'清晨的现代客厅，保留拱形窗与空间比例。低饱和木色，清透漫射光，安静克制的建筑摄影。':`${state.prompt}\n调整方向：${text.replace(/@\S+\s*/,'').slice(0,180)} 保留参考图中的主体、构图与空间比例。`;
  const plan={id:`P${String(state.plans.length+1).padStart(2,'0')}`,title:cool?'探索清晨光线':'保留空间，细化光影与材质',target:isNew?`氛围探索 ${state.extraNodes.length+1}`:state.nodeName,isNew,prompt,model:state.agentModel,aspect:state.aspect,resolution:state.resolution,count,refs:refs.length?refs:[...state.nodeRefs],beforePrompt:state.prompt,beforeRefs:[...state.nodeRefs],revision:state.revision,applied:false};
  if(state.agentSize!=='跟随方案'&&state.agentSize!=='自定义'){[plan.resolution,plan.aspect]=state.agentSize.split(' · ')}
  if(state.agentSize==='自定义')Object.assign(plan,{resolution:'自定义',width:state.agentWidth,height:state.agentHeight});
  state.plans.push(plan);state.messages.push({role:'assistant',text:isNew?'这次先创建独立的探索节点，原来的客厅生图保留。请确认下面的方案。':'我会保留现有空间结构，重点调整光影与材质。下面是准备应用到画布的具体变化。',planId:plan.id});state.assistantBusy=false;renderMessages();updateUI();record('方案已准备，等待用户应用');
 },550);
}
function applyPlan(id,generate=false){
 const p=state.plans.find(p=>p.id===id);if(!p)return;
 if(state.running){notify('节点正在运行，完成或取消后再应用方案');return}
 if(!p.applied&&p.revision!==state.revision){notify('节点内容已改变，先刷新方案再应用');renderMessages();return}
 if(!p.model){notify('请明确选择生图模型');return}
 if(!p.applied){pushUndo();if(p.isNew){state.extraNodes.push({name:state.nodeName,prompt:state.prompt,model:state.model,nodeRefs:[...state.nodeRefs]});state.nodeName=p.target;state.target=p.target}Object.assign(state,{prompt:p.prompt,model:p.model,aspect:p.aspect,resolution:p.resolution,count:p.count,width:p.width??state.width,height:p.height??state.height,nodeRefs:[...p.refs]});state.revision++;p.applied=true;p.appliedRevision=state.revision;state.extraNodes.push({name:`${p.target} · 保存`,type:'ImageSave'});record(`方案 ${id} 原子应用，1 个撤销记录`);updateUI();renderMessages();notify('方案已应用，可一次撤销；生成结果与导出文件不随撤销删除')}
 if(generate){if(p.appliedRevision!==state.revision){notify('应用后节点已改变，请刷新方案确认后再生成');return}state.activeRunPlan=id;generateImages()}
}
function generateImages(){
 if(state.running)return;if(!state.model){notify('尚未配置生图模型，先完成模型配置');openSettings();return}if(!state.nodeEnabled){notify('节点已禁用，请先启用');return}if(!state.prompt.trim()){notify('请先填写提示词');$('#node-prompt').focus();return}
 if(state.resolution==='自定义'&&(!Number.isFinite(Number(state.width))||!Number.isFinite(Number(state.height))||state.width<64||state.height<64||state.width>8192||state.height>8192)){notify('请填写 64–8192 范围内的自定义宽高（演示约束）');return}
 state.running=true;state.progress=0;state.runError='';state.runEpoch++;const epoch=state.runEpoch;const run=clone({count:state.count,model:state.model,prompt:state.prompt,size:dimensions(),planId:state.activeRunPlan});record('开始模拟生成，冻结当前参数与参考图');updateUI();renderMessages();
 let tick=0;const timer=setInterval(()=>{if(epoch!==state.runEpoch){clearInterval(timer);return}tick++;state.progress=Math.min(96,tick*16);if(state.failNext&&tick===3){clearInterval(timer);state.running=false;state.failNext=false;state.runError='示例供应商暂时不可用。画布配置与已有结果已保留。';record('模拟节点执行失败，未清除已有结果');updateUI();renderMessages();return}if(tick>=6){clearInterval(timer);state.running=false;state.progress=100;state.runError='';const filters=['','sepia(.15) saturate(1.12)','saturate(.65) hue-rotate(18deg)','sepia(.25) brightness(1.05)'];const generated=Array.from({length:run.count},(_,i)=>({id:`result-${Date.now()}-${i}`,src:assetRoot+'scene.svg',filter:filters[(i+state.results.length)%filters.length],model:run.model,size:run.size,prompt:run.prompt,sample:true}));state.results.push(...generated);state.resultIndex=state.results.length-generated.length;if(run.planId){state.messages.push({role:'assistant',text:`${run.count} 张示例结果已完成，生图与保存步骤均已模拟完成。`,resultId:generated[0].id,summary:['使用应用时确认的参数与参考图','示例结果保留在当前会话，可预览、下载和继续修改']});renderMessages()}state.activeRunPlan=null;record(`模拟生成完成，保留完整 ${run.count} 张批次`);notify(`已完成 ${run.count} 张示例结果；未调用真实模型`)}updateUI()},400);
}
function cancelRun(){if(!state.running)return;state.runEpoch++;state.running=false;state.runError='';state.progress=0;state.activeRunPlan=null;record('取消模拟运行，保留已有结果');updateUI();renderMessages();notify('已取消此节点，已有结果保留')}
function undo(){if(state.running){notify('运行时先取消，再撤销');return}const snapshot=state.undo.pop();if(!snapshot){notify('当前没有可撤销的方案变更');return}state.redo.push(nodeSnapshot());Object.assign(state,snapshot);state.revision++;state.plans.forEach(p=>{p.applied=false});record('一次撤销整个方案，保留生成结果');updateUI();renderMessages();notify('已撤销方案中的提示词、参数、节点与连线；结果保留')}
function redo(){const snapshot=state.redo.pop();if(!snapshot){notify('当前没有可重做的变更');return}state.undo.push(nodeSnapshot());Object.assign(state,snapshot);state.revision++;updateUI();renderMessages();record('重做画布变更，不自动生成');notify('已重做画布变更，不会自动生成')}
function openPreview(compare=false){const r=state.results[state.resultIndex];openDialog(compare?'比较结果':'查看结果',`${compare?`<div class="preview-compare"><div>${imageMarkup(state.results[0])}<span>最初示例</span></div><div>${imageMarkup(r)}<span>当前选择 · 示例插画</span></div></div>`:imageMarkup(r,'class="preview-image"')}<div class="dialog-actions"><span class="small muted">${escapeHtml(r.model)} · ${escapeHtml(r.size)} · 原型示例插画</span><div class="button-row"><button class="button subtle" data-action="compare">对比</button><button class="button subtle" data-action="edit-result">交给助手修改</button><button class="button primary" data-action="download">下载示例</button></div></div>`)}
function resultAsReference(){const r=state.results[state.resultIndex],id=`ref-${r.id}`;if(!asset(id))state.assets.push({...r,id,name:`生成结果 ${state.resultIndex+1}`,source:'结果',purpose:'保持主体，继续修改'});if(!state.agentRefs.includes(id))state.agentRefs.push(id);record('结果作为助手上下文，尚未更改生图连接');updateUI();return id}
function setInspectorTab(value){state.inspectorTab=value;document.body.classList.toggle('assistant-tab',value==='assistant');updateUI();if(innerWidth<720&&value==='assistant')$('#assistant-panel').scrollIntoView({behavior:'smooth',block:'start'})}
function openSettings(){openDialog('模型与供应商',`<p>此处为配置流程示意；不读取正式配置，也不保存真实 API Key。界面中的模型均为虚构示例。</p><div class="dialog-fields"><label class="field">供应商名称<input value="我的示例供应商" readonly></label><label class="field">接口地址<input value="https://example.invalid/v1" readonly></label><label class="field">API Key<input placeholder="原型不接收真实密钥" disabled></label><div class="button-row"><button class="button subtle" data-action="fetch-models">获取模型（模拟）</button><button class="button subtle" data-action="test-model">测试连接（模拟）</button></div><div class="form-grid"><label class="field">节点模型<select data-bind="model"><option>示例图像模型 A</option><option>示例图像模型 B</option><option value="">未配置模型（体验空状态）</option></select></label><label class="field">兼容格式<select id="demo-protocol"><option>OpenAI 兼容 · 示例</option><option>Google / Gemini · 示例</option></select></label></div><div class="review-note">真实能力与参数由模型协议决定。本原型集中展示入口，正式实现应继续按协议展示、验证和保留各模型草稿。</div><button class="button primary" data-action="close-dialog">完成配置</button></div>`);updateUI()}
function showPorts(){openDialog('端口与输入来源',`<p>所有输入仍然保留。连接来源直接显示在这里，避免折叠高级参数后找不到连线。</p>${[['提示词输入','手动输入','text'],['视角提示词','未连接','text'],['参考图',state.nodeRefs.map(id=>asset(id)?.name).join(' → ')||'未连接','image[]'],['遮罩','未连接','image'],['自定义参数','未连接','params'],['图片输出',`${state.results.length} 张结果 · 批次完整保留`,'image[]']].map(([name,source,type])=>`<div class="port-row"><strong>${name}</strong><span>${escapeHtml(source)}</span><span class="tag">${type}</span></div>`).join('')}<div class="dialog-actions"><span class="small muted">参考图多连接顺序与图片编号保持一致</span><button class="button primary" data-action="references" data-destination="node">编辑参考图连接</button></div>`)}
const inventory=[
 ['生图内容','提示词、提示词库、参考图增删与排序；文本与视角输入、遮罩、自定义参数、完整批次图片输出','内容区 / 端口与输入来源','编辑与选择可交互；连线结构示意'],
 ['模型与尺寸','模型、供应商、生成次数、所有比例、自动/1K/2K/4K/自定义宽高、质量、实际请求尺寸','常用参数 / 高级设置','本地示例值；协议适配不实现'],
 ['高级参数','系统提示词、审核、背景、思考强度与预算、请求预览','高级设置','可编辑；请求为脱敏模拟'],
 ['执行与恢复','全流/选中/到此、进度、单节点取消、失败日志、重试、任务ID恢复、媒体恢复','运行菜单 / 节点反馈 / 高级设置','模拟状态；不请求供应商'],
 ['节点操作','折叠、禁用、重命名、复制、删除、撤销/重做、端口查看','节点更多 / 顶部撤销','局部交互示意；不实现完整画布引擎'],
 ['助手上下文','场景/历史/本地参考图、粘贴与拖入、顺序编号、@节点、明确目标与新建节点','助手输入区 / 参考图选择','实际本地图片预览；选择独立于节点连接'],
 ['助手设置','对话模型、生图模型、思考、联网、生图尺寸、压缩阈值与压缩模型','输入框上方设置','配置可编辑；网络与模型均模拟'],
 ['助手方案','多轮消息、工作摘要、字段与连线变化、模型与步骤、应用/应用并生成、过期方案刷新','助手方案卡','可交互；一次撤销，重做不执行'],
 ['助手历史','/clear、/compact、归档消息、结果保留、进度与重试','命令 / 助手更多','会话内模拟，无持久化'],
 ['结果操作','批次切换、放大、对比、下载、参考图、继续修改、复制/裁剪/导入/保存节点入口','节点与助手结果 / 更多','预览与SVG下载可用；裁剪等为入口示意'],
 ['工作台能力','工作流、保存、生成历史、日志、统计、缓存、帮助、设置、画布缩放、面板宽度','顶部工具栏 / 更多 / 画布底部','入口保留；宽度为会话演示偏好'],
 ['保留约束','原图/共享媒体与所有权、后台执行、七主题、协议差异、任务恢复、工作流身份与持久化','正式应用继续使用现有服务','本原型不替换或验证底层实现']
];
function showInventory(){openDialog('功能保留与原型范围',`<p>保留的是完整产品能力与可发现的入口。本原型用于比较布局、信息层级与操作流程，生成、网络、持久化及完整节点引擎由模拟替代。</p><table class="inventory-table"><thead><tr><th>能力</th><th>保留内容与位置</th><th>本次可体验范围</th></tr></thead><tbody>${inventory.map(([name,content,location,boundary])=>`<tr><td>${name}</td><td>${content}<br><span class="muted">${location}</span></td><td>${boundary}</td></tr>`).join('')}</tbody></table><div class="review-note">待评审：A 是否让节点仍然过长；B 的参数/助手切换成本是否可接受；C 的大图优势是否值得减少画布面积。尚未选定或批准正式实现。</div>`)}
function menu(title,items){openDialog(title,`<div class="menu-grid">${items.map(([label,action,description])=>`<button class="list-action" data-action="${action}">${label}<span>${description||'原型演示'}</span></button>`).join('')}</div>`)}
function updateBound(el){const key=el.dataset.bind;if(!key)return;const numeric=['count','width','height','thinkingBudget','agentBudget','agentWidth','agentHeight','autoCompact'];state[key]=numeric.includes(key)?Number(el.value):el.value;if(key==='count')state.count=Math.max(1,Math.min(12,Math.floor(state.count)||1));if(['prompt','model','provider','aspect','resolution','count','quality','width','height','systemPrompt','moderation','background','thinking'].includes(key)){state.revision++;record(`修改节点字段 ${key}`)}updateUI()}
document.addEventListener('input',event=>{if(event.target.dataset.bind)updateBound(event.target);if(event.target.id==='reference-search'){pickerQuery=event.target.value;const input=event.target;$$('.picker-item',modal).forEach(b=>b.hidden=!asset(b.dataset.id)?.name.includes(pickerQuery));input.focus()}if(event.target.id==='agent-search'){state.agentSearch=event.target.checked;record('修改助手联网偏好');updateUI()}});
document.addEventListener('change',event=>{if(event.target.dataset.bind)updateBound(event.target)});
document.addEventListener('keydown',event=>{
 const editable=event.target.closest('input,textarea,select,[contenteditable="true"]');
 if(modal.open)return;
 if(event.target.id==='agent-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendMessage();return}
 if(editable)return;
 if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const i=['A','B','C'].indexOf(state.variant);setVariant(['A','B','C'][(i+(event.key==='ArrowLeft'?2:1))%3])}
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo()}
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();redo()}
 if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();generateImages()}
});
document.addEventListener('dragstart',e=>{const el=e.target.closest('[data-ref-id]');if(el){draggedRef=el.dataset.refId;e.dataTransfer.setData('text/plain',draggedRef)}});
document.addEventListener('dragover',e=>{if(e.target.closest('[data-ref-id],#node-references,#assistant-panel,#editor-panel'))e.preventDefault()});
document.addEventListener('drop',async e=>{const item=e.target.closest('[data-ref-id]');if(item&&draggedRef){e.preventDefault();const from=state.nodeRefs.indexOf(draggedRef),to=state.nodeRefs.indexOf(item.dataset.refId);state.nodeRefs.splice(to,0,...state.nodeRefs.splice(from,1));state.revision++;draggedRef=null;updateUI();record('拖动参考图排序');return}if(e.dataTransfer.files.length&&e.target.closest('#assistant-panel,#editor-panel')){e.preventDefault();await importFiles([...e.dataTransfer.files],e.target.closest('#assistant-panel')?'agent':'node')}});
document.addEventListener('paste',async e=>{const files=[...(e.clipboardData?.files||[])].filter(f=>f.type.startsWith('image/'));if(files.length&&e.target.closest('#assistant-panel,#editor-panel')){e.preventDefault();await importFiles(files,e.target.closest('#assistant-panel')?'agent':'node')}});
async function importFiles(files,destination){for(const file of files.filter(f=>f.type.startsWith('image/'))){const src=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(file)});const id=`local-${Date.now()}-${state.assets.length}`;state.assets.push({id,name:file.name,src,source:'本地',purpose:'本地参考图'});(destination==='agent'?state.agentRefs:state.nodeRefs).push(id)}if(destination==='node')state.revision++;record('本地图片仅在浏览器内存预览，创建示例图片导入节点');closeDialog();updateUI();notify('图片已在本地添加，没有上传到任何服务')}
$('#file-input').addEventListener('change',async e=>{await importFiles([...e.target.files],pickerDestination);e.target.value=''})
document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
 const action=button.dataset.action,id=button.dataset.id;
 switch(action){
 case 'variant':setVariant(button.dataset.variant);break;
 case 'variant-prev':case 'variant-next':{const i=['A','B','C'].indexOf(state.variant);setVariant(['A','B','C'][(i+(action==='variant-prev'?2:1))%3]);break}
 case 'close-dialog':closeDialog();break;
 case 'generate':closeDialog();state.activeRunPlan=null;generateImages();break;
 case 'cancel':cancelRun();break;
 case 'retry':closeDialog();generateImages();break;
 case 'undo':undo();break;
 case 'redo':redo();break;
 case 'count-up':case 'count-down':state.count=Math.max(1,Math.min(12,state.count+(action==='count-up'?1:-1)));state.revision++;record('调整生成数量');updateUI();break;
 case 'references':openReferences(button.dataset.destination||'node');break;
 case 'picker-tab':pickerTab=button.dataset.tab;openReferences(pickerDestination,true);break;
 case 'picker-select':pickerSelected.includes(id)?pickerSelected.splice(pickerSelected.indexOf(id),1):pickerSelected.push(id);openReferences(pickerDestination,true);break;
 case 'picker-clear':pickerSelected=[];openReferences(pickerDestination,true);break;
 case 'picker-done':{const refs=pickerSelected.map(ensureImported);if(pickerDestination==='agent')state.agentRefs=refs;else{state.nodeRefs=refs;state.revision++}closeDialog();updateUI();record(`确认 ${refs.length} 张${pickerDestination==='agent'?'助手附件（未连接生图节点）':'节点参考图连接'}`);notify(pickerDestination==='agent'?'已添加到助手，生图节点连接保持原样':'已更新生图节点参考图与顺序');break}
 case 'remove-node-ref':state.nodeRefs=state.nodeRefs.filter(v=>v!==id);state.revision++;record('移除节点参考图连接，图片导入节点保留');updateUI();break;
 case 'remove-agent-ref':state.agentRefs=state.agentRefs.filter(v=>v!==id);record('移除待发送附件，画布节点保留');updateUI();break;
 case 'ref-left':case 'ref-right':{const i=state.nodeRefs.indexOf(id),j=i+(action==='ref-left'?-1:1);if(j>=0&&j<state.nodeRefs.length)[state.nodeRefs[i],state.nodeRefs[j]]=[state.nodeRefs[j],state.nodeRefs[i]];state.revision++;updateUI();record('调整参考图编号');break}
 case 'upload':$('#file-input').click();break;
 case 'reference-detail':{const a=asset(id);openDialog(a.name,`${imageMarkup(a,'class="preview-image"')}<p class="small">来源：${a.source} · ${a.purpose||'参考图'}</p><div class="button-row"><button class="button primary" data-action="attach-one" data-id="${a.id}">添加到助手</button><button class="button subtle" data-action="references" data-destination="node">编辑节点参考图</button></div>`);break}
 case 'attach-one':if(!state.agentRefs.includes(id))state.agentRefs.push(ensureImported(id));closeDialog();updateUI();setInspectorTab('assistant');notify('图片已加入助手附件，发送前可以移除');break;
 case 'send':sendMessage();break;
 case 'cancel-agent':state.assistantEpoch++;state.assistantBusy=false;state.messages.push({role:'assistant',text:'本次示例回复已停止，画布保持原状。'});renderMessages();updateUI();record('停止助手回复');break;
 case 'suggest':$('#agent-input').value=button.dataset.text;$('#agent-input').focus();break;
 case 'ask-refine':setInspectorTab('assistant');$('#agent-input').value=`@${state.nodeName} 请优化当前提示词，保留主体与参考图构图。`;$('#agent-input').focus();notify('需求已填入助手，发送后先预览方案');break;
 case 'apply-plan':applyPlan(id,false);break;
 case 'apply-generate':applyPlan(id,true);break;
 case 'refresh-plan':{const p=state.plans.find(p=>p.id===id);p.revision=state.revision;p.beforePrompt=state.prompt;p.beforeRefs=[...state.nodeRefs];p.applied=false;renderMessages();notify('已根据当前节点刷新预览，请重新确认');break}
 case 'agent-settings':openAgentSettings();break;
 case 'settings':openSettings();break;
 case 'fetch-models':notify('已模拟获取 2 个示例生图模型；没有发起网络请求');break;
 case 'test-model':notify('示例连接可用（模拟）；没有测试真实 API');break;
 case 'target':menu('选择助手操作目标',[[`修改 ${state.nodeName}`,'target-current','将明确插入 @ 节点引用'],['新建生图节点','target-new','保留当前节点']]);break;
 case 'target-current':state.target=state.nodeName;$('#agent-input').value=`@${state.nodeName} `;closeDialog();updateUI();$('#agent-input').focus();break;
 case 'target-new':state.target='';$('#agent-input').value='创建一个新的生图节点，';closeDialog();updateUI();$('#agent-input').focus();break;
 case 'mention':menu('引用画布节点',[[`@${state.nodeName}`,'target-current','明确修改目标'],['空间结构 / 材质与色彩','mention-references','选择输入图']]);break;
 case 'mention-references':openReferences('agent');break;
 case 'commands':menu('助手命令',[['/compact 压缩上下文','compact','保留完整消息历史'],['/clear 清空上下文','clear','仅清理助手，不删画布']]);break;
 case 'compact':closeDialog();$('#agent-input').value='/compact';sendMessage();break;
 case 'clear':closeDialog();$('#agent-input').value='/clear';sendMessage();break;
 case 'agent-more':menu('助手与会话',[['会话历史','agent-history','查看完整消息及压缩归档'],['压缩上下文','compact','保留历史'],['清空上下文','clear','重新开始'],['调整面板宽度','panel-width','当前会话'],['模型与生成设置','agent-settings','思考、联网、尺寸']]);break;
 case 'agent-history':openDialog('完整会话历史',`<p>会话仅保存在当前页面内存。切换布局不会丢失，刷新页面会重置。</p><pre>${escapeHtml(JSON.stringify({archived:state.archived,messages:state.messages},null,2))}</pre>`);break;
 case 'panel-width':openDialog('调整助手宽度','<p>A 布局支持当前会话宽度演示；正式产品继续保留拖动与键盘调整。</p><label class="field">面板宽度<select id="panel-width"><option value="350">350 px · 紧凑</option><option value="390" selected>390 px · 标准</option><option value="460">460 px · 宽敞</option></select></label><div class="dialog-actions"><button class="button primary" data-action="set-width">应用宽度</button></div>');break;
 case 'set-width':document.documentElement.style.setProperty('--assistant-width',`${$('#panel-width').value}px`);closeDialog();notify('已更新 A 布局的助手宽度');break;
 case 'inspector-parameters':setInspectorTab('parameters');break;
 case 'inspector-assistant':setInspectorTab('assistant');break;
 case 'preview':closeDialog();openPreview();break;
 case 'compare':openPreview(true);break;
 case 'select-result':state.resultIndex=Number(button.dataset.index);updateUI();record('切换查看批次结果，不改变输出批次');break;
 case 'result-reference':resultAsReference();setInspectorTab('assistant');notify('已将当前结果添加到助手参考图；可继续描述修改');break;
 case 'edit-result':closeDialog();resultAsReference();setInspectorTab('assistant');$('#agent-input').value=`@${state.nodeName} 保持这张结果的主体与构图，`;$('#agent-input').focus();break;
 case 'download':{const r=state.results[state.resultIndex];const link=document.createElement('a');link.href=r.src;link.download=`cainflow-prototype-sample-${state.resultIndex+1}.svg`;link.click();notify('下载的是原型示例插画 SVG，不是真实生成图片');break}
 case 'result-more':menu('结果操作',[['查看大图','preview','当前批次结果'],['比较前后','compare','并排查看'],['用作参考','result-reference','加入助手附件'],['交给助手修改','edit-result','保留当前结果'],['复制图片','copy-image','原型入口示意'],['裁剪与绘制','crop-demo','沿用正式版预览编辑器'],['导入画布 / 连接保存节点','save-node-demo','沿用普通节点与媒体资产'],['下载示例','download','SVG 示例插画']]);break;
 case 'copy-image':notify('已保留复制图片入口；原型未覆盖系统图片剪贴板');break;
 case 'crop-demo':openDialog('裁剪与绘制入口',`${imageMarkup(state.results[state.resultIndex],'class="preview-image"')}<p>此处连接正式版已有的预览、裁剪与绘图工具。原型只验证入口位置，不重新实现图片编辑器。</p><button class="button primary" data-action="preview">返回结果预览</button>`);break;
 case 'save-node-demo':openDialog('结果到画布',`<p>图片导入、预览、对比与保存继续使用现有节点及共享媒体。这里模拟创建一个结果输入节点，便于继续连接。</p><button class="button primary" data-action="result-reference">将结果作为后续参考图</button>`);break;
 case 'ports':showPorts();break;
 case 'collapse':closeDialog();state.nodeCollapsed=!state.nodeCollapsed;updateUI();record('折叠/展开节点，参数与结果保留');break;
 case 'node-more':menu('生图节点操作',[[state.nodeEnabled?'禁用节点':'启用节点','toggle-node','保留全部内容'],['折叠 / 展开','collapse','保留参数'],['重命名','rename','只更改标签'],['复制节点','copy-node','生成独立示例记录'],['删除节点','delete-node','确认后隐藏示例节点'],['端口与输入来源','ports','查看全部端口'],['请求预览','request','查看模拟请求']]);break;
 case 'toggle-node':state.nodeEnabled=!state.nodeEnabled;closeDialog();updateUI();notify(state.nodeEnabled?'节点已启用':'节点已禁用，参数与结果保留');break;
 case 'rename':openDialog('重命名节点',`<label class="field">节点名称<input id="rename-value" value="${escapeHtml(state.nodeName)}"></label><div class="dialog-actions"><button class="button primary" data-action="confirm-rename">保存名称</button></div>`);break;
 case 'confirm-rename':state.nodeName=$('#rename-value').value.trim()||state.nodeName;state.target=state.nodeName;closeDialog();state.revision++;updateUI();record('重命名示例节点');break;
 case 'copy-node':state.extraNodes.push({...nodeSnapshot(),name:`${state.nodeName} 副本`});closeDialog();updateUI();notify('已创建内存中的节点副本，可在“状态”中检查');break;
 case 'delete-node':openDialog('删除示例节点？','<p>仅隐藏本次原型中的节点内容，演示结果保留；可以通过撤销恢复。</p><button class="button danger" data-action="confirm-delete">确认删除示例节点</button>');break;
 case 'confirm-delete':pushUndo();state.nodeCollapsed=true;state.nodeEnabled=false;closeDialog();updateUI();record('删除操作示意，折叠禁用示例节点');notify('节点已隐藏，原型中可从节点更多重新启用/展开');break;
 case 'request':openDialog('请求预览 · 模拟',`<p>展示提交前的信息检查位置；没有 API Key，没有发起请求。</p><pre>${escapeHtml(JSON.stringify({model:state.model,provider:state.provider,prompt:state.prompt,size:dimensions(),count:state.count,quality:state.quality,systemPrompt:state.systemPrompt,moderation:state.moderation,background:state.background,thinking:state.thinking,orderedReferences:state.nodeRefs.map((id,index)=>({index:index+1,name:asset(id)?.name})),prototype:true},null,2))}</pre>`);break;
 case 'resume':if(!state.taskId){notify('请先输入任务 ID');break}closeDialog();notify(`已模拟恢复任务 ${state.taskId}；未请求供应商`);generateImages();break;
 case 'recover':openDialog('恢复缺失媒体','<p>正式版只在你确认后下载保留的远程结果。本原型恢复一张本地示例插画，不访问远程地址。</p><button class="button primary" data-action="confirm-recover">恢复示例媒体</button>');break;
 case 'confirm-recover':state.results.push({...state.results[0],id:`recover-${Date.now()}`});state.resultIndex=state.results.length-1;closeDialog();updateUI();notify('示例媒体已恢复');break;
 case 'prompt-library':openDialog('提示词库',`<p>保留提示词库入口与“应用到节点”的操作。这里提供两个示例。</p><button class="list-action" data-action="use-prompt" data-prompt="保持主体与空间比例，柔和的自然光，真实材质，克制的配色，建筑摄影。">建筑摄影<span>自然光 · 真实材质</span></button><button class="list-action" data-action="use-prompt" data-prompt="电影感的室内空间，暖色侧光，细腻的材质，清晰的明暗层次，安静的生活感。">电影氛围<span>暖色侧光 · 明暗层次</span></button>`);break;
 case 'use-prompt':state.prompt=button.dataset.prompt;state.revision++;closeDialog();updateUI();record('应用示例提示词');break;
 case 'run-menu':menu('选择运行范围',[['运行整个工作流','run-whole','输入 → 生图 → 保存'],['仅运行选中节点','run-selected','使用未选上游已有结果'],['运行到客厅生图','run-target','包含所需上游'],['停止全部运行','stop-all','保留已经完成的结果']]);break;
 case 'run-whole':case 'run-selected':case 'run-target':closeDialog();state.activeRunPlan=null;notify(`${{ 'run-whole':'整个工作流','run-selected':'仅选中节点','run-target':'运行到当前节点'}[action]}：本原型只模拟生图执行与保存步骤`);generateImages();break;
 case 'stop-all':closeDialog();cancelRun();break;
 case 'history':openDialog('生成历史',`<p>示例结果仅保存在本页内存。历史原图预览、批次操作与拖回画布继续保留。</p><div class="picker-grid">${state.results.map((r,i)=>`<button class="picker-item" data-action="history-result" data-index="${i}">${imageMarkup(r)}<span>结果 ${i+1} · 示例<span>↗</span></span></button>`).join('')}</div>`);break;
 case 'history-result':state.resultIndex=Number(button.dataset.index);closeDialog();updateUI();openPreview();break;
 case 'workflow':menu('工作流管理',[['室内概念探索','close-dialog','当前示例'],['新建 / 打开 / 导入 / 导出','workflow-demo','沿用正式管理器'],['保存当前草稿','save','本次内存状态']]);break;
 case 'workflow-demo':notify('工作流管理入口保留；原型不读写真实工作流');break;
 case 'save':record('模拟保存，未写入磁盘');$('#save-state').textContent='演示草稿 · 会话内保留';notify('演示状态仍在当前会话内，刷新会重置；未写入正式工作流');break;
 case 'global-more':menu('工具与记录',[['整理节点','arrange-demo','现有能力入口'],['提示词库','prompt-library','常用创作资源'],['缓存管理','cache-demo','共享媒体与回收'],['请求统计','statistics-demo','示例请求'],['执行日志','logs','节点失败详情'],['帮助与快捷键','help','交互说明'],['重做','redo','不自动运行']]);break;
 case 'arrange-demo':notify('节点整理入口保留；当前画布按布局方案固定排列');break;
 case 'cache-demo':openDialog('本地存储与媒体','<p>所有图片都是示例或你主动添加的本地图片。本页只占浏览器会话内存，没有读写正式媒体库。</p><div class="review-note">正式产品保留共享媒体所有权、受保护结果、撤销记录保护、缺失媒体恢复和有确认的清理。这里只验证入口，后台规则不变。</div>');break;
 case 'statistics-demo':openDialog('请求统计',`<p>真实请求：0 · 真实费用：0</p><p>已保留 ${state.results.length} 张示例结果，${state.plans.length} 份示例方案。</p>`);break;
 case 'logs':openDialog('执行日志',`<p>${state.runError||'当前没有执行错误。'}</p><pre>${escapeHtml(JSON.stringify({lastAction:state.lastAction,running:state.running,progress:state.progress,node:state.nodeName,provider:state.provider,outcome:state.runError||'示例状态',networkRequests:0},null,2))}</pre><button class="button primary" data-action="retry">重试当前节点（模拟）</button>`);break;
 case 'help':openDialog('原型体验指南','<p>1. 切换 A/B/C 比较布局，内容会保留。<br>2. 编辑提示词、参考图和参数，展开高级设置。<br>3. 点击“让助手优化”，发送后检查方案，选择应用或应用并生成。<br>4. 查看结果、添加到助手继续修改。<br>5. 用“演示情景”体验失败、取消与模型缺失。</p><p>← / → 切换布局（编辑输入时不拦截）<br>Enter 发送 / Shift+Enter 换行<br>Ctrl/Cmd+Z 撤销方案 / Ctrl/Cmd+Shift+Z 重做<br>Esc 关闭对话框</p><button class="button subtle" data-action="inventory">查看完整功能保留清单</button>');break;
 case 'inventory':showInventory();break;
 case 'state':openDialog('当前原型状态',`<p>A/B/C 共用这份内存状态。没有连接真实工作流、API 或数据库。</p><pre>${escapeHtml(JSON.stringify({...state,assets:state.assets.map(a=>({...a,src:a.src.startsWith('data:')?'[本地图片内容省略]':a.src})),undo:state.undo.length,redo:state.redo.length},null,2))}</pre>`,'PROTOTYPE / LIVE STATE');break;
 case 'scenarios':menu('演示情景',[['正常生成','generate','约 2.4 秒完成'],['下一次生成失败','fail-next','检查保留、日志与重试'],['未配置模型','missing-model','检查配置回路'],['恢复示例模型','restore-model','继续体验'],['体验完整助手流程','guided-flow','填入需求与参考图'],['恢复初始示例','reset','刷新清空当前演示']]);break;
 case 'fail-next':state.failNext=true;closeDialog();notify('下一次生成将在中途模拟失败；已有结果会保留');break;
 case 'missing-model':state.model='';closeDialog();updateUI();notify('已切换为空模型状态，点击生成体验配置入口');break;
 case 'restore-model':state.model='示例图像模型 A';state.agentModel='示例图像模型 A';state.chatModel='示例对话模型';state.nodeEnabled=true;state.nodeCollapsed=false;closeDialog();updateUI();notify('示例模型已恢复');break;
 case 'guided-flow':closeDialog();state.agentRefs=['architecture','palette'];$('#agent-input').value=`@${state.nodeName} 保留空间结构，调整为更温暖的午后光线，探索两种材质方向。`;updateUI();setInspectorTab('assistant');$('#agent-input').focus();notify('需求与附件已准备，点击发送体验“预览 → 应用 → 生成”');break;
 case 'reset':location.reload();break;
 case 'zoom-in':case 'zoom-out':state.zoom=Math.max(50,Math.min(150,state.zoom+(action==='zoom-in'?10:-10)));$('#stage-content').style.zoom=state.zoom/100;updateUI();break;
 case 'fit':state.zoom=100;$('#stage-content').style.zoom=1;$('.canvas-stage')?.scrollTo(0,0);updateUI();notify('已恢复适应当前布局的画布比例');break;
 default:notify('该功能在正式版保留；当前展示入口与布局');
 }
});
modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog()}});
setVariant(state.variant);updateUI();
