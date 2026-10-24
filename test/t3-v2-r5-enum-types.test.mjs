import assert from 'node:assert/strict';
import test from 'node:test';
import {T3Client} from '../src/t3-client.mjs';
import {applyIntent} from '../src/orchestrate.mjs';
import {shellThreadToV1, threadDetailToV1, translateCommand, T3V2UnsupportedError} from '../src/t3-v2.mjs';

const thread = {id:'12345678-1111-4111-8111-111111111111', title:'Neutral', archivedAt:null, runtimeMode:'full-access', interactionMode:'default',
  modelSelection:{instanceId:'codex', model:'neutral', options:[]}};
const stop = {type:'thread.session.stop', threadId:thread.id, commandId:'neutral-raw-stop'};
const projection = extra => ({thread, runs:[{id:'done', ordinal:2, status:'completed'}], ...extra});
const malformed = literal => [
  ['singleton array', [literal]], ['number', 1], ['object', {}], ['null', null],
  ['boxed string', new String(literal)], ['coercing object', {toString:()=>literal}], ['missing', undefined],
];

function clientFor(value, preserveObjects = false) {
  const sent = [];
  const client = new T3Client({token:'', orchestrationProtocol:2,
    fetchImpl:async()=>new Response(JSON.stringify({projection:value}), {headers:{'content-type':'application/json'}})});
  // JSON normalizes boxed strings to valid primitives. Preserve non-wire
  // objects at the request seam to exercise the public client's in-memory boundary.
  if (preserveObjects) client.request = async()=>({projection:value});
  client.rpc = async(method, payload)=>{sent.push({method, ...payload}); return {sequence:1};};
  return {client, sent};
}

async function rejectedPublicStop(value, preserveObjects = false) {
  const {client, sent} = clientFor(value, preserveObjects);
  let failure;
  try {
    await applyIntent(client, {action:'thread.stop', threadId:thread.id, commandId:'neutral-intent'},
      {commandId:'neutral-external-caller', timeoutMs:5, intervalMs:0});
  } catch (error) { failure = error; }
  assert.equal(sent.length, 0, 'no RPC, including thread.stop, may be dispatched');
  assert.ok(failure, 'public Stop must fail');
  assert.equal(failure.receipt.status, 'rejected');
  assert.equal(failure.receipt.accepted, false);
  assert.equal(failure.receipt.commandId, 'neutral-external-caller');
  assert.equal(failure.receipt.projected, false);
}

// F05/F09: malformed older work must not disappear behind a valid terminal run.
const runCases = [
  ['singleton running array', ['running']], ['singleton waiting array', ['waiting']],
  ...malformed('running').filter(([label])=>label !== 'singleton array'),
  ['shell-only idle', 'idle'],
];
for (const [label, status] of runCases) {
  const value = projection({runs:[{id:'older-work', ordinal:1, status}, {id:'done', ordinal:2, status:'completed'}]});
  test(`F05 ${label}: detail refuses malformed older run`, ()=>{
    assert.throws(()=>threadDetailToV1({projection:value}, thread.id), T3V2UnsupportedError);
  });
  test(`F05 ${label}: raw Stop refuses with zero dispatch`, async()=>{
    await assert.rejects(translateCommand(stop, {readProjection:async()=>value}), T3V2UnsupportedError);
    const {client, sent} = clientFor(value, true);
    await assert.rejects(client.dispatch(stop), T3V2UnsupportedError);
    assert.equal(sent.length, 0);
  });
  test(`F09 ${label}: public Stop rejects external caller with zero dispatch`, async()=>{
    await rejectedPublicStop(value, label === 'boxed string' || label === 'coercing object');
  });
}

const fields = [
  ['turn-item status', 'running', status=>projection({turnItems:[{type:'command_execution', status}]})],
  ['subagent status', 'running', status=>projection({subagents:[{status}]})],
  ['provider-thread status', 'active', status=>projection({providerThreads:[{status, pendingBackgroundTasks:[]}]})],
  ['runtime-request status', 'pending', status=>projection({runtimeRequests:[{kind:'command', status}]})],
  ['turn-item type', 'command_execution', type=>projection({turnItems:[{type, status:'running'}]})],
  ['runtime-request kind', 'command', kind=>projection({runtimeRequests:[{kind, status:'pending'}]})],
  ['pull-request source', 'manual', source=>projection({thread:{...thread, pullRequests:[{source}]}})],
  ['message role', 'assistant', role=>projection({messages:[{role}]})],
  ['runtime mode', 'full-access', runtimeMode=>projection({thread:{...thread, runtimeMode}})],
  ['interaction mode', 'default', interactionMode=>projection({thread:{...thread, interactionMode}})],
];
for (const [field, literal, build] of fields) {
  for (const [label, invalid] of malformed(literal)) {
    // These two summary fields are optional/nullable; null is not stop proof.
    if ((field === 'runtime mode' || field === 'interaction mode') && invalid == null) continue;
    test(`R5 ${field} rejects ${label} at detail/raw/public boundaries`, async()=>{
      const value = build(invalid);
      assert.throws(()=>threadDetailToV1({projection:value}, thread.id), T3V2UnsupportedError);
      // Message roles are consumed by detail conversion, not raw Stop.
      if (field !== 'message role') {
        await assert.rejects(translateCommand(stop, {readProjection:async()=>value}), T3V2UnsupportedError);
        const {client, sent} = clientFor(value, true);
        await assert.rejects(client.dispatch(stop), T3V2UnsupportedError);
        assert.equal(sent.length, 0);
      }
      await rejectedPublicStop(value, label === 'boxed string' || label === 'coercing object');
    });
  }
}

for (const [field, literal, build] of [
  ['shell status', 'running', status=>({...thread, status})],
  ['shell request kind', 'command', kind=>({...thread, status:'idle', pendingRuntimeRequest:{kind}})],
]) {
  for (const [label, invalid] of malformed(literal)) test(`R5 ${field} refuses ${label}`, ()=>{
    assert.throws(()=>shellThreadToV1(build(invalid)), T3V2UnsupportedError);
  });
}

for (const status of ['preparing','queued','starting','running','waiting','completed','interrupted','failed','cancelled','rolled_back']) {
  test(`R5 supported string ${status} survives detail/raw/public Stop`, async()=>{
    const value = projection({runs:[{id:'held', ordinal:0, status:'queued', queueHeld:true}, {id:'tested', ordinal:1, status}]});
    const active = ['preparing','queued','starting','running','waiting'].includes(status);
    assert.equal(threadDetailToV1({projection:value}, thread.id).thread.lifecycleWorkPending, active);
    assert.equal((await translateCommand(stop, {readProjection:async()=>value}))[0].payload.type, 'thread.stop');
    const {client, sent} = clientFor(value);
    client.rpc = async(method, payload)=>{
      sent.push({method, ...payload});
      value.runs[1].status = 'cancelled';
      return {sequence:1};
    };
    const receipt = await applyIntent(client, {action:'thread.stop', threadId:thread.id, commandId:'neutral-valid-stop'},
      {timeoutMs:20, intervalMs:0});
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.executionStatus, 'verified');
    assert.equal(sent.filter(command=>command.type === 'thread.stop').length, active ? 2 : 1);
    assert.equal(sent.at(-1).commandId, 'neutral-valid-stop');
  });
}

test('R5 optional nullable summary modes remain supported', ()=>{
  assert.ok(threadDetailToV1({projection:projection({thread:{...thread, runtimeMode:null, interactionMode:null}})}, thread.id));
});
