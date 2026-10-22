import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentChatModelPreference,AGENT_CHAT_MODEL_KEY} from '../js/features/prompt-agent/prompt-agent-model-preference.js';
import {createPromptAgentConversationStore} from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
test('disk preference migrates old browser value once and never replaces a disk choice',()=>{
 const data=new Map();const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 const preference=createAgentChatModelPreference({storage,legacyStorage:{getItem:()=> 'legacy'}});
 assert.equal(preference.get(),'legacy');assert.equal(data.get(AGENT_CHAT_MODEL_KEY),'legacy');
 preference.set('second');assert.equal(preference.get(),'second');
 preference.set('');assert.equal(preference.get(),'');
 const blocked=createAgentChatModelPreference({storage:{getItem:()=>null},legacyStorage:{getItem(){throw Error('denied')}}});
 assert.equal(blocked.get(),'');
});
test('model preference survives disk failure, retry and a fresh storage instance',async()=>{
 const fetch=globalThis.fetch,timer=globalThis.setTimeout;const documents=new Map(),retries=[];let failed=true;
 globalThis.setTimeout=fn=>{retries.push(fn);return retries.length};
 globalThis.fetch=async(url,options={})=>{if(options.method==='PUT'){if(failed)return {ok:false,status:503};documents.set(url,JSON.parse(options.body).value);}return {ok:true,json:async()=>({value:documents.get(url)??null})}};
 try{
 const {diskStorage}=await import('../js/services/storage-documents.js?agent-model-first');
 let notified=false;diskStorage.onError=()=>{notified=true};
 createAgentChatModelPreference({storage:diskStorage}).set('second');await diskStorage.flushPromise;
 assert.ok(notified);failed=false;retries.shift()();await diskStorage.flushPromise;
 const {diskStorage:reopened}=await import('../js/services/storage-documents.js?agent-model-reopened');await reopened.hydrate();
 assert.equal(createAgentChatModelPreference({storage:reopened}).get(),'second');
 }finally{globalThis.fetch=fetch;globalThis.setTimeout=timer;}
});
test('all workflow Agent preferences survive serialization, compaction and clear without crossing workflows',()=>{
 const store=createPromptAgentConversationStore();
 store.setImageModelId('image-two');store.setSearchSettings({mode:'off',modelId:'search-two'});
 for(const purpose of ['chat','image','search'])store.setProvider(purpose,purpose+'-two','provider-two');
 for(const purpose of ['chat','image'])store.setThinking(purpose,purpose+'-two',{mode:'effort',effort:'high'});
 store.setSize('image-two',{resolution:'2K',aspectRatio:'16:9'});
 const expected=JSON.parse(JSON.stringify(store.snapshot()));
 const restored=createPromptAgentConversationStore();restored.restore(expected);
 assert.deepEqual(restored.snapshot(),expected);
 restored.compact('summary');restored.clear();assert.deepEqual(restored.snapshot(),expected);
 restored.restore(null);assert.equal(restored.getImageModelId(),'');assert.equal(restored.getProvider('chat','chat-two'),'');
 restored.restore(expected);assert.deepEqual(restored.snapshot(),expected);
});
