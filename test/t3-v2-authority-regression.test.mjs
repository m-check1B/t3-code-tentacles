import test from 'node:test';
import assert from 'node:assert/strict';
import {T3Client} from '../src/t3-client.mjs';
import {threadTurnStart,applyIntent} from '../src/orchestrate.mjs';
const json=x=>new Response(JSON.stringify(x));
const thread={id:'neutral-thread',projectId:'neutral-project',modelSelection:{instanceId:'codex',model:'neutral'},runtimeMode:'full-access'};
test('A10 mode change after fresh HTTP snapshot must prevent message acceptance in changed mode',async()=>{
 let mode='approval-required',readCount=0,closed=0;const accepted=[];
 class Socket extends EventTarget {
  constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(raw){const f=JSON.parse(raw);if(f.payload.type==='thread.runtime-mode.set')mode=f.payload.runtimeMode;
   else if(f.payload.type==='message.dispatch'){
    assert.equal(f.tag,'orchestration.dispatchMessageWithMode');
    assert.equal(f.payload.runtimeMode,'full-access');
    mode=f.payload.runtimeMode; // The patched server applies this at acceptance.
    accepted.push({type:f.payload.type,mode});
   }
   queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({_tag:'Exit',requestId:f.id,exit:{_tag:'Success',value:{sequence:1}}})})));
  }
  close(){closed++;}
 }
 const c=new T3Client({token:'synthetic',orchestrationProtocol:2,WebSocketImpl:Socket,fetchImpl:async url=>{
  if(new URL(url).pathname.includes('websocket-ticket'))return json({ticket:'synthetic'});
  readCount++;const snapshot=json({projection:{thread:{...thread,runtimeMode:mode}}});
  // The GET response describes a real full-access state. Another accepted mode
  // command arrives after that read, before the separate message acceptance.
  queueMicrotask(()=>{mode='approval-required';});return snapshot;
 }});
 try {await c.dispatch(threadTurnStart({threadId:thread.id,commandId:'race-command',messageId:'race-message',text:'Neutral',runtimeMode:'full-access'}));}catch(error){assert.match(error.message,/runtime mode prerequisite/);}
 assert.equal(readCount,1);assert.equal(closed,2);assert.equal(accepted.some(x=>x.mode!=='full-access'),false,'message was accepted under approval-required after fresh check');
});
test('A11 rejected prerequisite stop must retain original caller command ID',async()=>{
 const detail={projection:{thread,runs:[{id:'live-run',ordinal:1,status:'running'}]}};
 const c=new T3Client({token:'synthetic',orchestrationProtocol:2,fetchImpl:async()=>json(detail)});
 const {T3RpcRejectedError}=await import('../src/t3-v2.mjs');c.rpc=async()=>{throw new T3RpcRejectedError('orchestration.dispatchCommand','synthetic refusal');};
 let caught;try{await applyIntent(c,{action:'thread.stop',threadId:thread.id,commandId:'caller-stop'},{timeoutMs:5,intervalMs:0});}catch(error){caught=error;}
 assert.equal(caught?.receipt?.status,'rejected');assert.equal(caught?.receipt?.commandId,'caller-stop');
 assert.equal(caught?.receipt?.internalCommandId,'verified-stop:caller-stop');
});
test('A12 unknown background-work status must refuse instead of verified stopped',async()=>{
 const detail={projection:{thread,runs:[{id:'done',ordinal:1,status:'completed'}],turnItems:[{id:'background',runId:'done',type:'command_execution',status:'future-live-state'}]}};
 const c=new T3Client({token:'synthetic',orchestrationProtocol:2,fetchImpl:async()=>json(detail)});c.rpc=async()=>({sequence:1});
 await assert.rejects(applyIntent(c,{action:'thread.stop',threadId:thread.id,commandId:'unknown-background'},{timeoutMs:5,intervalMs:0}));
});
test('A13 held queue does not hide known active background work',async()=>{
 const detail={projection:{thread,runs:[{id:'held',ordinal:1,status:'queued',queueHeld:true}],turnItems:[{id:'background',runId:'held',type:'command_execution',status:'running'}]}};
 const c=new T3Client({token:'synthetic',orchestrationProtocol:2,fetchImpl:async()=>json(detail)});c.rpc=async()=>({sequence:1});
 await assert.rejects(applyIntent(c,{action:'thread.stop',threadId:thread.id,commandId:'held-background'},{timeoutMs:5,intervalMs:0}),/did not verify session termination/);
});

test('A14 every unknown work status refuses before short circuits and exemptions',async()=>{
 const {threadDetailToV1}=await import('../src/t3-v2.mjs');
 for(const status of [null,undefined,'future-live-state','__proto__']) {
  for(const type of ['command_execution','dynamic_tool','subagent']) {
   const projection={thread,runs:[{id:'rolled',ordinal:1,status:'rolled_back'},{id:'active',ordinal:2,status:'running'}],turnItems:[{id:'unknown',runId:'rolled',type,status,input:{persistent:true}}]};
   assert.throws(()=>threadDetailToV1({projection},thread.id),/background-work status/);
  }
  assert.throws(()=>threadDetailToV1({projection:{thread,runs:[],subagents:[{status}]}},thread.id),/subagent status/);
 }
});

test('unpatched V2 server refuses atomic message method without generic fallback',async()=>{
 const sent=[];
 const c=new T3Client({token:'synthetic',orchestrationProtocol:2,fetchImpl:async()=>json({projection:{thread}})});
 const {T3RpcRejectedError}=await import('../src/t3-v2.mjs');
 c.rpc=async(method,payload)=>{
  sent.push([method,payload.type]);
  if(method==='orchestration.dispatchMessageWithMode')throw new T3RpcRejectedError(method,'unsupported method');
  return {sequence:1};
 };
 await assert.rejects(c.dispatch(threadTurnStart({threadId:thread.id,commandId:'old-server',messageId:'old-server-message',text:'Neutral',runtimeMode:'full-access'})),T3RpcRejectedError);
 assert.deepEqual(sent,[['orchestration.dispatchCommand','thread.runtime-mode.set'],['orchestration.dispatchMessageWithMode','message.dispatch']]);
});

test('unknown runtime-request states and malformed work collections carry caller refusals',async()=>{
 for(const extra of [{runtimeRequests:[{status:'future-live-state',kind:'approval'}]}, {turnItems:{}}, {subagents:{}}, {providerThreads:{}}, {runtimeRequests:{}}, {thread:{...thread,pendingBackgroundTasks:{}}}]) {
  const projection={thread,runs:[],...extra};
  const c=new T3Client({token:'synthetic',orchestrationProtocol:2,fetchImpl:async()=>json({projection})});
  let dispatched=0;c.rpc=async()=>{dispatched++;return {sequence:1};};
  await assert.rejects(applyIntent(c,{action:'thread.stop',threadId:thread.id,commandId:'malformed-work'}),error=>error.receipt?.status==='rejected'&&error.receipt.commandId==='malformed-work');
  assert.equal(dispatched,0);
 }
});

test('raw stop translation refuses unknown background status before dispatch',async()=>{
 const {translateCommand}=await import('../src/t3-v2.mjs');
 await assert.rejects(translateCommand({type:'thread.session.stop',threadId:thread.id,commandId:'raw-stop'},
  {readProjection:async()=>({thread,runs:[],turnItems:[{type:'command_execution',status:'future-live-state'}]})}),/background-work status/);
});
