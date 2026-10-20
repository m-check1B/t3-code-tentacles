import assert from 'node:assert/strict';
import test from 'node:test';
import {threadDetailToV1, shellThreadToV1, translateCommand, T3RpcRejectedError, T3V2UnsupportedError} from '../src/t3-v2.mjs';
import {applyIntent} from '../src/orchestrate.mjs';

const thread={id:'neutral-thread',projectId:'neutral-project',title:'Neutral',runtimeMode:'full-access',interactionMode:'default',modelSelection:{instanceId:'codex',model:'gpt-6-sol',options:[{id:'reasoningEffort',value:'high'}]}};
const projection=(extra={})=>({thread,runs:[{id:'done',ordinal:1,status:'completed'}],...extra});

for(const status of ['preparing','queued','starting','running','waiting','completed','interrupted','failed','cancelled','rolled_back']) {
 test(`C01 enumerated run status ${status} is recognized beside a held queue`,()=>{
  const actual=threadDetailToV1({projection:projection({runs:[{id:'held',ordinal:1,status:'queued',queueHeld:true},{id:'tested',ordinal:2,status}]})},thread.id).thread;
  const active=['preparing','queued','starting','running','waiting'].includes(status);
  assert.equal(actual.lifecycleWorkPending,active);
  assert.equal(actual.session.activeTurnId,active?'tested':null);
 });
}
for(const type of ['command_execution','dynamic_tool','subagent']) {
 for(const status of ['idle','pending','running','waiting','completed','failed','cancelled','interrupted']) {
  test(`C02 enumerated ${type} status ${status} is classified before lifecycle proof`,()=>{
   const actual=threadDetailToV1({projection:projection({turnItems:[{id:'work',runId:'done',type,status}]})},thread.id).thread;
   assert.equal(actual.lifecycleWorkPending,['pending','running','waiting'].includes(status));
  });
 }
}
for(const status of ['idle','pending','running','waiting','completed','failed','cancelled','interrupted']) {
 test(`C03 enumerated subagent status ${status}`,()=>{
  const actual=threadDetailToV1({projection:projection({subagents:[{status}]})},thread.id).thread;
  assert.equal(actual.lifecycleWorkPending,['pending','running','waiting'].includes(status));
 });
}
for(const status of ['pending','resolved','expired','cancelled']) {
 test(`C04 enumerated request status ${status}`,()=>{
  const actual=threadDetailToV1({projection:projection({runtimeRequests:[{status,kind:'command'}]})},thread.id).thread;
  assert.equal(actual.lifecycleWorkPending,status==='pending');
 });
}
for(const status of ['not_loaded','idle','active','archived','closed','error']) {
 test(`C05 known provider-thread status ${status} does not hide pending tasks`,()=>{
  const actual=threadDetailToV1({projection:projection({providerThreads:[{status,pendingBackgroundTasks:[{taskId:'neutral-task',kind:'command'}]}]})},thread.id).thread;
  assert.equal(actual.lifecycleWorkPending,true);
 });
}
for(const status of ['constructor',false,{},['running']]) {
 test(`C06 unknown status ${JSON.stringify(status)} refuses before raw Stop`,async()=>{
  await assert.rejects(translateCommand({type:'thread.session.stop',commandId:'raw',threadId:thread.id},{readProjection:async()=>projection({runs:[{id:'active',status:'running'}],turnItems:[{type:'dynamic_tool',status,input:{persistent:true}}]})}),T3V2UnsupportedError);
 });
}
for(const status of ['future-active','__proto__',undefined,null,false,{}]) {
 test(`C07 unknown provider-thread status ${status} must refuse lifecycle proof`,()=>{
  assert.throws(()=>threadDetailToV1({projection:projection({providerThreads:[{status,pendingBackgroundTasks:[]}]})},thread.id),T3V2UnsupportedError);
 });
}
for(const status of ['idle','preparing','queued','starting','running','waiting','completed','interrupted','failed','cancelled','rolled_back']) {
 test(`C08 shell enumerated status ${status} recognized`,()=>{
  assert.ok(shellThreadToV1({...thread,status}).session.status);
 });
}

function mockClient({archived=false,baselineError=false,refuseType,shapeAfterDispatch=false,shapeAfterRejection=false}={}) {
 let unarchived=!archived, dispatched=0, refused=false;
 return {
  seen:[],
  protocol:async()=>2,
  async thread() {
   if(shapeAfterDispatch && dispatched) throw new T3V2UnsupportedError('future work status after acceptance');
   if(shapeAfterRejection && refused) throw new T3V2UnsupportedError('future work status during restoration');
   if(!unarchived)return {thread:null};
   return {thread:{...thread,orchestrationProtocol:2,archivedAt:null,lifecycleWorkPending:true,session:{status:baselineError?'error':'running',activeTurnId:'active'}}};
  },
  archivedShell:async()=>({threads:[{...thread,archivedAt:'2026-10-01T00:00:00Z',orchestrationProtocol:2,lifecycleWorkPending:true,session:{status:'running',activeTurnId:'active'}}]}),
  async dispatch(command) {
   this.seen.push(command.type);
   dispatched++;
   if(command.type===refuseType){refused=true;throw new T3RpcRejectedError('orchestration.dispatchCommand','Synthetic refusal');}
   if(command.type==='thread.unarchive')unarchived=true;
   if(command.type==='thread.archive')unarchived=false;
   return {sequence:dispatched};
  },
 };
}
for(const [label,action,config] of [
 ['archived-unarchive','thread.stop',{archived:true,refuseType:'thread.unarchive'}],
 ['archived-stop','thread.stop',{archived:true,refuseType:'thread.session.stop'}],
 ['archive-prerequisite','thread.archive',{refuseType:'thread.session.stop'}],
 ['restart-prerequisite','thread.restart',{baselineError:true,refuseType:'thread.session.stop'}],
 ['message-dispatch','thread.continue',{refuseType:'thread.turn.start'}],
 ['ordinary-meta','thread.rename',{refuseType:'thread.meta.update'}],
]) {
 test(`C09 caller override survives rejection at ${label}`,async()=>{
  const caller='override:'+label;
  const client=mockClient(config);
  const extras=action==='thread.rename'?{title:'Neutral'}:action==='thread.restart'||action==='thread.continue'?{text:'Neutral',runtimeMode:'full-access'}:{};
  await assert.rejects(applyIntent(client,{action,commandId:'supplied-intent-id',threadId:thread.id,...extras},
   {commandId:caller,wait:false,timeoutMs:1,intervalMs:0}),error=>{
    assert.equal(error.receipt?.status,'rejected');assert.equal(error.receipt?.commandId,caller);return true;
   });
  assert.ok(client.seen.includes(config.refuseType),'targeted dispatch refusal must actually execute');
 });
}
test('C10 post-acceptance unknown lifecycle state must carry the external caller receipt',async()=>{
 await assert.rejects(applyIntent(mockClient({shapeAfterDispatch:true}),{action:'thread.stop',commandId:'caller-postaccept',threadId:thread.id},{timeoutMs:1,intervalMs:0}),error=>{
  assert.equal(error.receipt?.commandId,'caller-postaccept');assert.equal(error.receipt?.status,'unconfirmed');assert.equal(error.receipt?.executionStatus,'unverified');return true;
 });
});
test('C11 archive restoration read must not erase an actual rejected-stop caller receipt',async()=>{
 const client=mockClient({archived:true,refuseType:'thread.session.stop',shapeAfterRejection:true});
 await assert.rejects(applyIntent(client,{action:'thread.stop',commandId:'caller-archived-reject',threadId:thread.id},{timeoutMs:1,intervalMs:0}),error=>{
  assert.ok(client.seen.includes('thread.session.stop'));
  assert.equal(error.receipt?.status,'rejected');
  assert.equal(error.receipt?.commandId,'caller-archived-reject');assert.equal(error.restorationFailures?.length,1);return true;
 });
});

for (const stage of ['read','dispatch','verify']) {
 for (const primaryRejected of [false,true]) {
  test(`restoration ${stage} failure ${primaryRejected?'preserves Stop rejection':'reports uncertain outcome'} with caller override`,async()=>{
   let archived=true, stopped=false, stopAttempted=false, restoreAttempted=false;
   const client={
    protocol:async()=>2,
    async thread(){
     if (stopAttempted && stage==='read') throw new T3V2UnsupportedError('Synthetic restoration read failure');
     return {thread:{...thread,orchestrationProtocol:2,archivedAt:archived?'2026-10-01T00:00:00Z':null,lifecycleWorkPending:!stopped,session:{status:stopped?'stopped':'running',activeTurnId:stopped?null:'live'}}};
    },
    async dispatch(command){
     if(command.type==='thread.unarchive') archived=false;
     if(command.type==='thread.session.stop'){
      stopAttempted=true;
      if(primaryRejected) throw new T3RpcRejectedError('orchestration.dispatchCommand','Synthetic Stop rejection');
      stopped=true;
     }
     if(command.type==='thread.archive'){
      restoreAttempted=true;
      if(stage==='dispatch') throw new T3RpcRejectedError('orchestration.dispatchCommand','Synthetic restoration rejection');
      // Keep it unarchived to prove the restoration wait failure.
     }
     return {sequence:1};
    },
   };
   await assert.rejects(applyIntent(client,{action:'thread.stop',threadId:thread.id,commandId:'intent-cleanup'},
    {commandId:'caller-cleanup',timeoutMs:1,intervalMs:0}),error=>{
     assert.equal(error.receipt?.commandId,'caller-cleanup');
     assert.equal(error.receipt?.status,primaryRejected?'rejected':'unconfirmed');
     assert.equal(error.restorationFailures?.length,1);
     assert.equal(restoreAttempted,stage!=='read');
     return true;
    });
  });
 }
}

test('verification failure after the caller command was accepted retains accepted evidence',async()=>{
 let dispatched=false;
 const client={protocol:async()=>2,thread:async()=>{if(dispatched)throw new T3V2UnsupportedError('Synthetic projection failure');return{thread:{...thread,session:{status:'stopped'}}};},dispatch:async()=>{dispatched=true;return{sequence:1};}};
 await assert.rejects(applyIntent(client,{action:'thread.continue',threadId:thread.id,commandId:'intent-postaccept',text:'Neutral',runtimeMode:'full-access'},
 {commandId:'caller-postaccept',timeoutMs:1,intervalMs:0}),error=>{
  assert.equal(error.receipt?.commandId,'caller-postaccept');assert.equal(error.receipt?.status,'unconfirmed');
  assert.equal(error.receipt?.accepted,true);assert.equal(error.receipt?.executionStatus,'unverified');return true;
 });
});

for(const status of [undefined,'future-active']) test(`C07 raw Stop refuses provider status ${String(status)}`,async()=>{
 await assert.rejects(translateCommand({type:'thread.session.stop',threadId:thread.id,commandId:'raw-provider'},
  {readProjection:async()=>projection({providerThreads:[{status,pendingBackgroundTasks:[]}]})}),T3V2UnsupportedError);
});

test('accepted caller Stop plus later recovery refusal is uncertain, never caller rejected',async()=>{
 let accepted=false,readsAfterAcceptance=0;
 const client={protocol:async()=>2,
  async thread(){
   if(accepted && ++readsAfterAcceptance>1)throw new T3V2UnsupportedError('Synthetic recovery validation failure');
   return {thread:{...thread,orchestrationProtocol:2,lifecycleWorkPending:accepted,session:{status:accepted?'running':'stopped',activeTurnId:accepted?'live':null}}};
  },
  async dispatch(){accepted=true;return{sequence:1};},
 };
 await assert.rejects(applyIntent(client,{action:'thread.stop',threadId:thread.id,commandId:'caller-recovery'},{timeoutMs:1,intervalMs:0}),error=>{
  assert.equal(error.receipt?.commandId,'caller-recovery');assert.equal(error.receipt?.status,'unconfirmed');
  assert.equal(error.receipt?.accepted,true);assert.equal(error.receipt?.executionStatus,'unverified');return true;
 });
});
