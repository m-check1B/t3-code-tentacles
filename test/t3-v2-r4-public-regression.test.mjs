import assert from 'node:assert/strict';
import test from 'node:test';
import {T3Client} from '../src/t3-client.mjs';
import {applyIntent} from '../src/orchestrate.mjs';
import {T3RpcRejectedError} from '../src/t3-v2.mjs';

const thread={id:'neutral-thread',title:'Neutral',archivedAt:null,modelSelection:{instanceId:'codex',model:'gpt-6-sol',options:[]},runtimeMode:'full-access'};
const clientFor=detail=>new T3Client({token:'',orchestrationProtocol:2,fetchImpl:async()=>new Response(JSON.stringify(detail),{headers:{'content-type':'application/json'}})});

test('E01 public lifecycle must refuse unknown provider-thread status before dispatch',async()=>{
 const detail={projection:{thread,runs:[{id:'done',ordinal:1,status:'completed'}],providerThreads:[{id:'provider',status:'future-active',pendingBackgroundTasks:[]}]}};
 const client=clientFor(detail);const sent=[];
 client.rpc=async(method,payload)=>{sent.push({method,type:payload.type});return{sequence:1};};
 let error;
 try{await applyIntent(client,{action:'thread.stop',threadId:thread.id,commandId:'caller-unknown-provider'},{timeoutMs:5,intervalMs:0});}catch(e){error=e;}
 assert.equal(error?.receipt?.status,'rejected');assert.equal(sent.length,0);
});

test('E02 real client restoration validation must preserve a rejected Stop receipt',async()=>{
 const detail={projection:{thread:{...thread,archivedAt:'2026-10-01T00:00:00Z'},runs:[{id:'running',ordinal:1,status:'running'}]}};
 const client=clientFor(detail);const sent=[];
 client.rpc=async(method,payload)=>{
  sent.push({method,type:payload.type,commandId:payload.commandId});
  if(payload.type==='thread.unarchive'){detail.projection.thread.archivedAt=null;return{sequence:1};}
  if(payload.type==='thread.stop'){
   detail.projection.turnItems=[{type:'command_execution',status:'future-work'}];
   throw new T3RpcRejectedError(method,'Synthetic rejection');
  }
  return{sequence:2};
 };
 let error;
 try{await applyIntent(client,{action:'thread.stop',threadId:thread.id,commandId:'caller-actual-reject'},{timeoutMs:5,intervalMs:0});}catch(e){error=e;}
 assert.ok(sent.some(s=>s.type==='thread.stop'));
 assert.equal(error?.receipt?.status,'rejected');assert.equal(error?.receipt?.commandId,'caller-actual-reject');assert.equal(error?.restorationFailures?.length,1);
});
