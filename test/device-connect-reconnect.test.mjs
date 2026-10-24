import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { DeviceConnector, HostLink, buildDeviceMessage } from '../src/device-connect.mjs';
import { LoopbackRuntimeAdapter } from '../src/outbound-pairer.mjs';
import { T3HttpError } from '../src/t3-client.mjs';

const DEVICE = '00000000-0000-4000-8000-000000000001';
const NONCE = 'syntheticNonce0123456789';
const TIME = '2026-10-24T12:00:00Z';
const RELAY = 'wss://relay.example.test/api/v1/jack/devices/connect';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const fingerprint = `sha256:${createHash('sha256').update(publicKey.export({format:'der',type:'spki'})).digest('hex')}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i=0;i<200;i++) { if (check()) return; await delay(2); }
  throw new Error('Synthetic test condition timed out');
}
class Channel {
  messages=[]; receivers=[]; closers=[];
  send(message) {
    this.messages.push(message);
    if (message.type==='sign.request') queueMicrotask(() => this.deliver({
      version:1,type:'sign.result',id:message.id,algorithm:'ECDSA-P256-SHA256',keyFingerprint:fingerprint,
      signature:sign('sha256',Buffer.from(buildDeviceMessage({...message,deviceId:DEVICE,keyFingerprint:fingerprint})),privateKey).toString('base64url'),
    }));
  }
  onMessage(fn){this.receivers.push(fn);}
  onClose(fn){this.closers.push(fn);}
  deliver(message){for(const fn of this.receivers)fn(message);}
  close(){for(const fn of this.closers)fn();}
}
class Socket {
  static all=[]; listeners=new Map(); sent=[];
  constructor(){Socket.all.push(this);}
  addEventListener(name,fn){this.listeners.set(name,[...(this.listeners.get(name)||[]),fn]);}
  emit(name,value){for(const fn of this.listeners.get(name)||[])fn(value);}
  message(value){this.emit('message',{data:JSON.stringify(value)});}
  send(raw){this.sent.push(JSON.parse(raw));}
  close(){}
}
function setup({hello=true,runtime={},maxInFlight=16}={}) {
  Socket.all=[];
  const channel=new Channel();
  const host=new HostLink({channel,signTimeoutMs:100});
  if(hello)channel.deliver({version:1,type:'host.hello',deviceId:DEVICE,keyFingerprint:fingerprint,mac:['notify']});
  const connector=new DeviceConnector({runtime,host,WebSocketImpl:Socket,appVersion:'0.4.1-jack.2',maxInFlight,handshakeTimeoutMs:100,idleTimeoutMs:1000});
  return {channel,host,connector};
}

async function bindRunSocket(index) {
  await until(()=>Socket.all.length>index);
  const socket=Socket.all[index];
  socket.message({version:1,type:'device.hello',audience:RELAY,nonce:NONCE,issuedAt:TIME});
  await until(()=>socket.sent.some(m=>m.type==='device.auth'));
  socket.message({version:1,type:'device.bound',connectionId:`synthetic-connection-${index}`});
  await delay(5);
  return socket;
}
function request(socket,id,channel='turns',params={workspace:'/tmp/b3-synthetic-workspace',title:'Synthetic review',message:'Synthetic test only',instanceId:'codex',model:'gpt-6.1-sol'}) {
  socket.message({type:'rpc.request',rpcId:id,channel,method:channel==='mac'?'notify':'originate',params,deadline:new Date(Date.now()+1000).toISOString()});
}
function replayRun(runtime={},options={}) {
  const state=setup({runtime,...options});
  state.connector.sleep=async()=>true;
  state.controller=new AbortController();
  state.running=state.connector.run({relay:RELAY,signal:state.controller.signal});
  return state;
}

test('B3 replay control: same socket suppresses duplicate ID and reconnect permits fresh ID',async()=>{
  let calls=0;
  const run=replayRun({originate:async()=>{calls++;return {threadId:'synthetic-thread'};}});
  try {
    const one=await bindRunSocket(0);
    request(one,'synthetic-first');await until(()=>one.sent.some(m=>m.rpcId==='synthetic-first'));
    request(one,'synthetic-first');await delay(10);assert.equal(calls,1);
    one.emit('close',{code:1013});
    const two=await bindRunSocket(1);
    request(two,'synthetic-new');await until(()=>two.sent.some(m=>m.rpcId==='synthetic-new'));
    assert.equal(calls,2);
  } finally {run.controller.abort();await run.running;}
});

test('B3 run replay: completed mutating RPC cannot execute twice across reconnect',async()=>{
  let calls=0;
  const run=replayRun({originate:async()=>{calls++;return {threadId:'synthetic-thread'};}});
  try {
    const one=await bindRunSocket(0);
    request(one,'synthetic-replayed');await until(()=>one.sent.some(m=>m.rpcId==='synthetic-replayed'));
    one.emit('close',{code:1013});
    const two=await bindRunSocket(1);
    request(two,'synthetic-replayed');await delay(15);
    assert.equal(calls,1,'a remembered RPC ID must not execute a second mutation after reconnect');
  } finally {run.controller.abort();await run.running;}
});

test('B3 run correlation: old connector reply cannot resolve different next-socket request',async()=>{
  const run=replayRun();
  try {
    const one=await bindRunSocket(0);
    request(one,'synthetic-reused','mac',{title:'old-operation'});
    await until(()=>run.channel.messages.filter(m=>m.type==='host.rpc').length===1);
    const original=run.channel.messages.find(m=>m.type==='host.rpc');
    one.emit('close',{code:1013});
    const two=await bindRunSocket(1);
    request(two,'synthetic-reused','mac',{title:'new-operation'});await delay(10);
    assert.equal(run.channel.messages.filter(m=>m.type==='host.rpc').length,1,'replayed pending ID must not reach connector');
    request(two,'synthetic-fresh-mac','mac',{title:'fresh-operation'});
    await until(()=>run.channel.messages.filter(m=>m.type==='host.rpc').length===2);
    const fresh=run.channel.messages.filter(m=>m.type==='host.rpc').at(-1);
    assert.notEqual(fresh.id,original.id);
    run.channel.deliver({version:1,type:'host.rpc.result',id:original.id,result:{operation:'old-operation'}});
    await delay(15);
    assert.equal(two.sent.some(m=>m.type==='rpc.result'&&m.result?.operation==='old-operation'),false,'old operation reply must not satisfy a new socket request');
    assert.equal(two.sent.some(m=>m.rpcId==='synthetic-fresh-mac'),false);
    run.channel.deliver({version:1,type:'host.rpc.result',id:fresh.id,result:{operation:'fresh-operation'}});
    await until(()=>two.sent.some(m=>m.rpcId==='synthetic-fresh-mac'));
    assert.deepEqual(two.sent.find(m=>m.rpcId==='synthetic-fresh-mac').result,{operation:'fresh-operation'});
  } finally {run.controller.abort();await run.running;}
});

test('B3 run capacity: 16 still-running operations consume capacity after reconnect',async()=>{
  const releases=[];
  let calls=0;
  const run=replayRun({originate:()=>{calls++;return new Promise(resolve=>releases.push(resolve));}});
  try {
    const one=await bindRunSocket(0);
    for(let i=0;i<16;i++)request(one,`synthetic-pending-${i}`);
    await until(()=>calls===16);
    one.emit('close',{code:1013});
    const two=await bindRunSocket(1);
    request(two,'synthetic-seventeenth');await delay(15);
    assert.equal(calls,16,'disconnect must not create free capacity for a seventeenth running mutation');
  } finally {for(const resolve of releases)resolve({threadId:'synthetic-thread'});run.controller.abort();await run.running;await delay(10);}
});


test('B3 runtime replay: actual adapter and bridge dispatch only one full-access turn',async()=>{
  const commands=[];
  const threads=new Map();
  const client={
    snapshot:async()=>({projects:[{id:'synthetic-project',workspaceRoot:'/tmp/b3-synthetic-workspace'}],threads:[...threads.values()]}),
    thread:async(id)=>{
      if(!threads.has(id))throw new T3HttpError({method:'GET',pathname:'/synthetic-thread',status:404,body:null});
      return {thread:threads.get(id)};
    },
    dispatch:async(cmd)=>{
      commands.push(cmd);
      if(cmd.type==='thread.create')threads.set(cmd.threadId,{id:cmd.threadId,projectId:cmd.projectId,messages:[]});
      if(cmd.type==='thread.turn.start')threads.get(cmd.threadId).messages.push({id:cmd.message.messageId,text:cmd.message.text});
      return {sequence:commands.length};
    },
    request:async()=>({}),
  };
  const runtime=new LoopbackRuntimeAdapter({client,prepareTalkWorkspaceImpl:()=>{},doctorImpl:async()=>({labs:[]}),selfUpdateSummaryImpl:()=>null,timingsLog:()=>{}});
  const run=replayRun(runtime);
  try {
    const one=await bindRunSocket(0);
    request(one,'synthetic-actual-replay');await until(()=>one.sent.some(m=>m.rpcId==='synthetic-actual-replay'));
    assert.equal(one.sent.find(m=>m.rpcId==='synthetic-actual-replay').type,'rpc.result');
    one.emit('close',{code:1013});
    const two=await bindRunSocket(1);
    request(two,'synthetic-actual-replay');await delay(20);
    const turns=commands.filter(cmd=>cmd.type==='thread.turn.start');
    const summary={turnStarts:turns.length,distinctCommandIds:new Set(turns.map(cmd=>cmd.commandId)).size,distinctThreadIds:new Set(turns.map(cmd=>cmd.threadId)).size,runtimeModes:turns.map(cmd=>cmd.runtimeMode)};
    console.log('SYNTHETIC_RUNTIME_REPLAY '+JSON.stringify(summary));
    assert.equal(turns.length,1,'one relay RPC ID must not create two full-access turns');
  } finally {run.controller.abort();await run.running;}
});


test("reconnect capacity returns only after the original operation settles", async () => {
  const releases = [];
  const calls = [];
  const run = replayRun({ originate: (params) => {
    calls.push(params.title);
    return new Promise((resolve, reject) => releases.push({ resolve, reject }));
  } }, { maxInFlight: 1 });
  try {
    const one = await bindRunSocket(0);
    request(one, "synthetic-held", "turns", { title: "held" });
    await until(() => calls.length === 1);
    one.emit("close", { code: 1013 });
    const two = await bindRunSocket(1);
    request(two, "synthetic-capacity-control", "turns", { title: "fresh" });
    await until(() => two.sent.some(m => m.rpcId === "synthetic-capacity-control"));
    assert.equal(two.sent.find(m => m.rpcId === "synthetic-capacity-control").code, "computer.unavailable");
    assert.deepEqual(calls, ["held"]);
    releases[0].reject(new Error("Synthetic operation finished with failure"));
    await delay(5);
    // Refused IDs were never admitted; this same fresh ID can now be accepted.
    request(two, "synthetic-capacity-control", "turns", { title: "fresh" });
    await until(() => calls.length === 2);
    releases[1].resolve({ operation: "fresh" });
    await until(() => two.sent.some(m => m.type === "rpc.result"));
    assert.equal(one.sent.some(m => m.rpcId === "synthetic-held"), false);
    assert.deepEqual(two.sent.find(m => m.type === "rpc.result").result, { operation: "fresh" });
  } finally {
    for (const release of releases) release.resolve(null);
    run.controller.abort();
    await run.running;
  }
});

test("over-cap refusals across reconnects cannot churn accepted replay history", async () => {
  let release;
  const calls = [];
  const run = replayRun({ originate: async (params) => {
    calls.push(params.title);
    if (params.title === "held") await new Promise(resolve => { release = resolve; });
    return null;
  } }, { maxInFlight: 1 });
  try {
    const one = await bindRunSocket(0);
    request(one, "synthetic-remembered", "turns", { title: "completed" });
    await until(() => one.sent.some(m => m.rpcId === "synthetic-remembered"));
    request(one, "synthetic-held", "turns", { title: "held" });
    await until(() => calls.length === 2);
    one.emit("close", { code: 1013 });
    const two = await bindRunSocket(1);
    for (let i = 0; i < 1_001; i++) request(two, `synthetic-refused-${i}`, "turns", { title: "over-cap" });
    await until(() => two.sent.filter(m => m.rpcId?.startsWith("synthetic-refused-")).length === 1_001);
    assert.deepEqual(calls, ["completed", "held"]);
    assert.equal(two.sent.filter(m => m.code === "computer.unavailable").length, 1_001);
    release();
    await delay(5);
    two.emit("close", { code: 1013 });
    const three = await bindRunSocket(2);
    request(three, "synthetic-remembered", "turns", { title: "replayed" });
    request(three, "synthetic-final-fresh", "turns", { title: "fresh" });
    await until(() => three.sent.some(m => m.rpcId === "synthetic-final-fresh"));
    assert.deepEqual(calls, ["completed", "held", "fresh"]);
  } finally {
    release?.();
    run.controller.abort();
    await run.running;
  }
});

test("a pending ID remains protected after 1,000 other accepted operations and reconnect", async () => {
  let release;
  const calls = [];
  const run = replayRun({ originate: async (params) => {
    calls.push(params.title);
    if (params.title === "held") await new Promise(resolve => { release = resolve; });
    return null;
  } });
  try {
    const one = await bindRunSocket(0);
    request(one, "synthetic-old-pending", "turns", { title: "held" });
    await until(() => calls.length === 1);
    for (let i = 0; i < 1_001; i++) {
      const id = `synthetic-accepted-${i}`;
      request(one, id, "turns", { title: "completed" });
      await until(() => one.sent.some(m => m.rpcId === id));
    }
    assert.equal(calls.length, 1_002);
    one.emit("close", { code: 1013 });
    const two = await bindRunSocket(1);
    request(two, "synthetic-old-pending", "turns", { title: "replayed" });
    request(two, "synthetic-fresh", "turns", { title: "fresh" });
    await until(() => two.sent.some(m => m.rpcId === "synthetic-fresh"));
    assert.equal(calls.includes("replayed"), false);
    assert.equal(calls.at(-1), "fresh");
  } finally {
    release?.();
    run.controller.abort();
    await run.running;
  }
});

test("late connector results after timeout cannot resolve a subsequent operation", async () => {
  const { host, channel } = setup();
  const request = { id: "synthetic-reused", method: "notify", params: {}, timeoutMs: 10 };
  try {
    const first = host.rpc(request);
    const oldWireId = channel.messages.at(-1).id;
    await assert.rejects(first, { code: "computer.unavailable" });
    let settled = false;
    const second = host.rpc({ ...request, timeoutMs: 500 }).then(result => { settled = true; return result; });
    const newWireId = channel.messages.at(-1).id;
    channel.deliver({ version: 1, type: "host.rpc.result", id: oldWireId, result: { operation: "old" } });
    await delay(5);
    assert.equal(settled, false, "a late timed-out result must be dropped");
    assert.notEqual(newWireId, oldWireId);
    channel.deliver({ version: 1, type: "host.rpc.result", id: newWireId, result: { operation: "new" } });
    assert.deepEqual(await second, { operation: "new" });
  } finally { host.close(); }
});
