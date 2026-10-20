import test from 'node:test';
import assert from 'node:assert/strict';
import {threadDetailToV1,shellThreadToV1,translateCommand,T3V2UnsupportedError} from '../src/t3-v2.mjs';
const thread={id:'neutral-thread',modelSelection:{instanceId:'codex',model:'neutral'},runtimeMode:'full-access',interactionMode:'default'};
for (const [field,extra] of [
 ['turn-item type',{turnItems:[{type:'future-work',status:'running'}]}],
 ['request kind',{runtimeRequests:[{kind:'future-request',status:'pending'}]}],
 ['pull-request source',{thread:{...thread,pullRequests:[{source:'future-link',watch:{}}]}}],
 ['message role',{messages:[{role:'future-role'}]}],
 ['runtime mode',{thread:{...thread,runtimeMode:'future-mode'}}],
 ['interaction mode',{thread:{...thread,interactionMode:'future-mode'}}],
]) test(`all read enums refuse unknown ${field}`,()=>assert.throws(()=>threadDetailToV1({projection:{thread,...extra}},thread.id),T3V2UnsupportedError));
test('shell pending request kind refuses unknown enum',()=>assert.throws(()=>shellThreadToV1({...thread,status:'idle',pendingRuntimeRequest:{kind:'future-request'}}),T3V2UnsupportedError));
test('raw Stop also refuses an unknown discriminant before absence proof',async()=>assert.rejects(translateCommand({type:'thread.session.stop',threadId:thread.id,commandId:'raw-enum'}, {readProjection:async()=>({thread,turnItems:[{type:'future-work',status:'running'}]})}),T3V2UnsupportedError));
