import assert from 'node:assert/strict';
import test from 'node:test';
import {T3Client} from '../src/t3-client.mjs';
import {translateCommand,threadDetailToV1,archivedShellToV1} from '../src/t3-v2.mjs';
import {applyIntent,threadTurnStart} from '../src/orchestrate.mjs';
const json=(body)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const make=(descriptor)=>new T3Client({orchestrationProtocol:'auto',token:'synthetic-review-only',fetchImpl:async()=>json(descriptor)});
const thread={id:'12345678-1111-4111-8111-111111111111',projectId:'audit-project',title:'Neutral audit',modelSelection:{instanceId:'codex',model:'gpt-6-sol',options:[]},runtimeMode:'full-access'};

test('H01 explicit null protocol must refuse instead of downgrading to V1',async()=>{
 await assert.rejects(make({orchestrationProtocolVersion:null}).protocol());
});
test('H02 a null descriptor is not a legacy object with an absent version',async()=>{
 await assert.rejects(make(null).protocol());
});
test('H03 an array descriptor must refuse instead of downgrading to V1',async()=>{
 await assert.rejects(make([]).protocol());
});
test('H04 an explicit unknown version refuses before any command frame',async()=>{
 let commands=0;
 const c=new T3Client({orchestrationProtocol:'auto',token:'synthetic-review-only',fetchImpl:async(url)=>{if(new URL(url).pathname==='/.well-known/t3/environment')return json({orchestrationProtocolVersion:7}); commands++;return json({sequence:1});}});
 await assert.rejects(c.dispatch({type:'thread.pin',commandId:'audit-command',threadId:thread.id}));
 assert.equal(commands,0);
});
test('H05 unknown run status must refuse stop instead of acknowledging a no-op',async()=>{
 await assert.rejects(translateCommand({type:'thread.session.stop',commandId:'audit-stop',threadId:thread.id},{readProjection:async()=>({runs:[{id:'audit-run',ordinal:1,status:'future-live-state'}]})}));
});
test('H06 an unknown older run status must not be hidden by a completed latest run',()=>{
 assert.throws(()=>threadDetailToV1({projection:{thread,runs:[{id:'audit-old',ordinal:1,status:'future-live-state'},{id:'audit-new',ordinal:2,status:'completed'}]}},thread.id));
});
test('H07 nested model selection unknown fields must refuse before V2 dispatch',async()=>{
 let sent=0;
 const client={protocol:async()=>2,dispatch:async()=>{sent++;return {sequence:1};}};
 await assert.rejects(applyIntent(client,{action:'thread.set-model',commandId:'audit-model',threadId:thread.id,instanceId:'codex',model:'gpt-6-sol',modelSelection:{options:[],unrecognized:true}},{wait:false}));
 assert.equal(sent,0);
});
test('H08 unknown intent fields must carry a rejected receipt with original commandId',async()=>{
 const client={protocol:async()=>2,dispatch:async()=>{throw Error('must never dispatch');}};
 await assert.rejects(applyIntent(client,{action:'thread.pin',commandId:'audit-rejected',threadId:thread.id,unrecognized:true},{wait:false}),e=>e.receipt?.status==='rejected' && e.receipt?.commandId==='audit-rejected');
});
test('H09 stop must reach background work on a terminal failed run',async()=>{
 const steps=await translateCommand({type:'thread.session.stop',commandId:'audit-background-stop',threadId:thread.id},{readProjection:async()=>({thread,runs:[{id:'audit-failed-run',ordinal:1,status:'failed',providerThreadId:'audit-provider'}],turnItems:[{id:'audit-command-item',runId:'audit-failed-run',providerThreadId:'audit-provider',type:'command_execution',status:'running'}]})});
 assert.equal(steps.length,1);
 assert.deepEqual(steps[0].payload,{type:'thread.stop',commandId:'audit-background-stop',threadId:thread.id});
});
test('H10 translation of the exact same turn IDs is deterministic and preserves full-access',async()=>{
 const command=threadTurnStart({commandId:'audit-retry',messageId:'audit-message',threadId:thread.id,text:'Neutral test',runtimeMode:'full-access'});
 const first=await translateCommand(command),second=await translateCommand(structuredClone(command));
 assert.deepEqual(first,second);
 assert.equal(first[0].payload.runtimeMode,'full-access');
 assert.equal(first[1].payload.messageId,'audit-message');
 assert.equal(first[1].payload.commandId,'audit-retry');
});
test('H11 known V2 uses RPC exclusively and known V1 uses V1 dispatch exclusively',async()=>{
 for(const version of [1,2]){
  const paths=[],rpcs=[];
  const c=new T3Client({orchestrationProtocol:'auto',token:'synthetic-review-only',fetchImpl:async(url)=>{const p=new URL(url).pathname;paths.push(p);return json(p==='/.well-known/t3/environment'?{orchestrationProtocolVersion:version}:{sequence:1});}});
  c.rpc=async(method,payload)=>{rpcs.push([method,payload.type]);return{sequence:1};};
  await c.dispatch({type:'thread.pin',commandId:'audit-pin',threadId:thread.id});
  assert.equal(paths.includes('/api/orchestration/dispatch'),version===1);
  assert.equal(rpcs.length,version===2?1:0);
 }
});
test('H12 unknown nested command fields must refuse before even the runtime-mode step',async()=>{
 const command=threadTurnStart({commandId:'audit-deep',messageId:'audit-message',threadId:thread.id,text:'Neutral test',runtimeMode:'full-access',modelSelection:{instanceId:'codex',model:'gpt-6-sol',options:[],unrecognized:true}});
 await assert.rejects(translateCommand(command));
});
test('H13 unknown fields inside attachment records must refuse before dispatch',async()=>{
 const command=threadTurnStart({commandId:'audit-attachment',messageId:'audit-message',threadId:thread.id,text:'Neutral test',runtimeMode:'full-access',attachments:[{type:'file',id:'synthetic-file',unrecognized:true}]});
 await assert.rejects(translateCommand(command));
});
test('H14 retry after accepted mode step and lost message must still guarantee full-access',async()=>{
 let mode='approval-required';const receipts=new Set();let lost=true;
 const c=new T3Client({orchestrationProtocol:2,token:'synthetic-review-only',fetchImpl:async()=>json({projection:{thread:{...thread,runtimeMode:mode}}})});
 c.rpc=async(_method,payload,{beforeSend}={})=>{
  if(beforeSend)await beforeSend();
  if(receipts.has(payload.commandId))return {sequence:receipts.size};
  if(payload.type==='thread.runtime-mode.set'){mode=payload.runtimeMode;receipts.add(payload.commandId);return {sequence:receipts.size};}
  if(lost){lost=false;throw new Error('synthetic transport failed before message delivery');}
  assert.equal(mode,'full-access');receipts.add(payload.commandId);return {sequence:receipts.size};
 };
 const command=threadTurnStart({commandId:'audit-runtime-retry',messageId:'audit-message',threadId:thread.id,text:'Neutral test',runtimeMode:'full-access'});
 await assert.rejects(c.dispatch(command),/synthetic transport/);
 mode='approval-required'; // Another accepted user mode change while the caller reconnects.
 await assert.rejects(c.dispatch(command), /runtime mode prerequisite changed/);
 assert.equal(receipts.has(command.commandId), false);
});

test('H15 archived shells with an unknown schemaVersion must refuse',()=>{
 assert.throws(()=>archivedShellToV1({schemaVersion:7,snapshotSequence:1,threads:[{...thread,status:'completed'}]}));
});
test('H16 public stop must dispatch an interrupt when a completed run owns background work',async()=>{
 let rpcs=0;
 const detail={projection:{thread,runs:[{id:'audit-done-run',ordinal:1,status:'completed'}],turnItems:[{id:'audit-live-tool',runId:'audit-done-run',type:'command_execution',status:'running'}]}};
 const c=new T3Client({orchestrationProtocol:2,token:'synthetic-review-only',fetchImpl:async()=>json(detail)});
 c.rpc=async(_method,payload)=>{assert.equal(payload.type,'thread.stop');rpcs++;detail.projection.turnItems[0].status='interrupted';return{sequence:1};};
 const result=await applyIntent(c,{action:'thread.stop',threadId:thread.id,commandId:'audit-public-stop'},{timeoutMs:20,intervalMs:0});
 assert.equal(result.accepted,true);assert.ok(rpcs>0,'stop reported accepted/verified without any interrupt RPC');
});
test('H17 stop of a failed idle thread must not time out on the unchanged failed run',async()=>{
 const detail={projection:{thread,runs:[{id:'audit-failed-idle',ordinal:1,status:'failed'}],turnItems:[]}};
 const c=new T3Client({orchestrationProtocol:2,token:'synthetic-review-only',fetchImpl:async()=>json(detail)});
 c.rpc=async()=>({sequence:1});
 const result=await applyIntent(c,{action:'thread.stop',threadId:thread.id,commandId:'audit-stop-failed'},{timeoutMs:20,intervalMs:0});
 assert.equal(result.accepted,true);
});

test('mode is freshly checked after WebSocket handshake, before the message frame', async () => {
 let mode='approval-required', sockets=0, closed=0;
 const sent=[];
 class Socket extends EventTarget {
  constructor() {
   super(); const ordinal=++sockets;
   queueMicrotask(()=>{ if(ordinal===2)mode='approval-required'; this.dispatchEvent(new Event('open')); });
  }
  send(raw) {
   const frame=JSON.parse(raw); sent.push(frame.payload.type);
   if(frame.payload.type==='thread.runtime-mode.set')mode=frame.payload.runtimeMode;
   queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({_tag:'Exit',requestId:frame.id,exit:{_tag:'Success',value:{sequence:1}}})})));
  }
  close() { closed++; }
 }
 const c=new T3Client({orchestrationProtocol:2,token:'synthetic',WebSocketImpl:Socket,fetchImpl:async(url)=>json(new URL(url).pathname.includes('websocket-ticket')?{ticket:'synthetic-ticket'}:{projection:{thread:{...thread,runtimeMode:mode}}})});
 await assert.rejects(c.dispatch(threadTurnStart({commandId:'handshake-command',messageId:'handshake-message',threadId:thread.id,text:'Neutral',runtimeMode:'full-access'})),/runtime mode prerequisite/);
 assert.deepEqual(sent,['thread.runtime-mode.set']); assert.equal(closed,2);
});

test('nested options, scripts and attachment source unknowns refuse before any step', async()=>{
 for(const command of [
  {type:'thread.meta.update',commandId:'nested',threadId:thread.id,modelSelection:{instanceId:'codex',model:'neutral',options:[{id:'arbitrary-provider-option',value:true,extra:true}]}},
  {type:'project.meta.update',commandId:'nested',projectId:'p',scripts:[{id:'s',name:'Neutral',command:'true',icon:'terminal',runOnWorktreeCreate:false,extra:true}]},
  threadTurnStart({commandId:'nested',threadId:thread.id,runtimeMode:'full-access',attachments:[{type:'image',id:'neutral-image',source:{kind:'snap-shot',accessibility:{format:'element-tree',imageSize:{width:1,height:1},root:{role:'button',bounds:null,children:[],state:{visible:true,extra:true}}}}}]}),
 ])await assert.rejects(translateCommand(command));
 const steps=await translateCommand({type:'thread.meta.update',commandId:'data-ids',threadId:thread.id,modelSelection:{instanceId:'codex',model:'neutral',options:[{id:'future-provider-option',value:true}]}});
 assert.equal(steps[0].payload.modelSelection.options[0].id,'future-provider-option');
});

test('pre-dispatch refusal preserves explicit override and prior batch receipts',async()=>{
 const {applyIntents}=await import('../src/orchestrate.mjs');
 const client={protocol:async()=>2,dispatch:async()=>({sequence:1})};
 await assert.rejects(applyIntent(client,{action:'thread.pin',threadId:thread.id,commandId:'old-id',unknown:true},{wait:false,commandId:'caller-override'}),e=>e.receipt?.status==='rejected'&&e.receipt?.commandId==='caller-override');
 await assert.rejects(applyIntents(client,[{action:'thread.pin',threadId:thread.id,commandId:'accepted-first'},{action:'thread.pin',threadId:thread.id,commandId:'rejected-second',unknown:true}],{wait:false}),e=>e.receipt?.commandId==='rejected-second'&&e.results?.length===1&&e.results[0].commandId==='accepted-first');
});

test('held queued work and failed idle threads can complete the archive lifecycle',async()=>{
 const detail={projection:{thread:{...thread},runs:[{id:'idle-failed',ordinal:1,status:'failed'},{id:'held-queue',ordinal:2,status:'queued',queueHeld:true}],turnItems:[]}};
 const c=new T3Client({orchestrationProtocol:2,token:'synthetic',fetchImpl:async()=>json(detail)});
 c.rpc=async(_method,payload)=>{if(payload.type==='thread.archive')detail.projection.thread.archivedAt='2026-10-20T04:00:00Z';return{sequence:1};};
 const result=await applyIntent(c,{action:'thread.archive',threadId:thread.id,commandId:'archive-failed'},{timeoutMs:50,intervalMs:0});
 assert.equal(result.accepted,true);assert.equal(result.executionStatus,'verified');assert.ok(detail.projection.thread.archivedAt);
});

test('stop refuses to verify while background work remains',async()=>{
 const detail={projection:{thread,runs:[{id:'failed',ordinal:1,status:'failed'}],providerThreads:[{id:'provider',status:'active',pendingBackgroundTasks:[{taskId:'monitor',kind:'monitor'}]}]}};
 const c=new T3Client({orchestrationProtocol:2,token:'synthetic',fetchImpl:async()=>json(detail)});
 c.rpc=async()=>({sequence:1});
 await assert.rejects(applyIntent(c,{action:'thread.stop',threadId:thread.id,commandId:'stop-monitor'},{timeoutMs:5,intervalMs:0}),/did not verify session termination/);
});

test('inherited property names are never valid shell statuses or command types',async()=>{
 const {shellToV1}=await import('../src/t3-v2.mjs');
 for(const status of ['constructor','toString','__proto__'])assert.throws(()=>shellToV1({schemaVersion:2,threads:[{...thread,status}]}));
 await assert.rejects(translateCommand({type:'constructor',commandId:'prototype-command'}),e=>e.code==='t3_v2_unsupported');
});

test('raw turn commands cannot omit the mode acceptance prerequisite',async()=>{
 const command=threadTurnStart({threadId:thread.id,text:'Neutral',runtimeMode:'full-access'});delete command.runtimeMode;
 await assert.rejects(translateCommand(command),/runtime mode/);
});

test('thread-level PR monitors must clear before lifecycle verification',async()=>{
 const detail={projection:{thread:{...thread,pullRequests:[{host:'forge.invalid',repository:'neutral/project',number:1,source:'manual',watch:{}}]},runs:[{id:'done',ordinal:1,status:'completed'}],turnItems:[]}};
 const c=new T3Client({orchestrationProtocol:2,token:'synthetic',fetchImpl:async()=>json(detail)});c.rpc=async()=>({sequence:1});
 await assert.rejects(applyIntent(c,{action:'thread.stop',threadId:thread.id,commandId:'stop-pr-monitor'},{timeoutMs:5,intervalMs:0}),/did not verify session termination/);
});

test('projection validation before a continue or stop dispatch carries caller rejection',async()=>{
 const detail={projection:{thread,runs:[{id:'unknown',ordinal:1,status:'future-status'}]}};
 for(const action of ['thread.continue','thread.stop']){
  let sent=0;
  const c=new T3Client({orchestrationProtocol:2,token:'synthetic',fetchImpl:async()=>json(detail)});c.rpc=async()=>{sent++;return{sequence:1};};
  const intent={action,threadId:thread.id,commandId:'preflight-'+action,...(action==='thread.continue'?{text:'Neutral',runtimeMode:'full-access',instanceId:'codex',model:'gpt-6-sol'}:{})};
  await assert.rejects(applyIntent(c,intent,{wait:false}),e=>e.receipt?.status==='rejected'&&e.receipt?.commandId===intent.commandId);
  assert.equal(sent,0);
 }
});

test('invalid retained selection refuses with a caller receipt before restart work',async()=>{
 let sent=0;
 const detail={projection:{thread:{...thread,modelSelection:{instanceId:'codex',model:'gpt-6-sol',options:[{id:'reasoningEffort',value:17}]}},runs:[{id:'failed',ordinal:1,status:'failed'}]}};
 const c=new T3Client({orchestrationProtocol:2,token:'synthetic',fetchImpl:async()=>json(detail)});c.rpc=async()=>{sent++;return{sequence:1};};
 await assert.rejects(applyIntent(c,{action:'thread.continue',threadId:thread.id,commandId:'invalid-retained',text:'Neutral',runtimeMode:'full-access'},{wait:false}),e=>e.receipt?.status==='rejected'&&e.receipt?.commandId==='invalid-retained');
 assert.equal(sent,0);
});
