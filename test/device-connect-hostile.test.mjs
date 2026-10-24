import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { DeviceConnector, HostLink, buildDeviceMessage, fdHostChannel, portHostChannel, HOST_LINE_MAX_BYTES } from '../src/device-connect.mjs';

// Ported from the independent B3 hostile probes for findings 2–4.
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
  messages=[]; receivers=[]; closers=[]; closeCalls=0;
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
  close(){this.closeCalls++;for(const fn of this.closers)fn();}
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
function setup({hello=true,runtime={},handshakeTimeoutMs=100}={}) {
  Socket.all=[];
  const channel=new Channel();
  const host=new HostLink({channel,signTimeoutMs:100});
  if(hello)channel.deliver({version:1,type:'host.hello',deviceId:DEVICE,keyFingerprint:fingerprint,mac:['notify']});
  const connector=new DeviceConnector({runtime,host,WebSocketImpl:Socket,appVersion:'0.4.1-jack.2',handshakeTimeoutMs,idleTimeoutMs:1000});
  return {channel,host,connector};
}

test('B3 startup: abort before host.hello stops run promptly',async()=>{
  const {host,connector}=setup({hello:false});
  const controller=new AbortController();
  const running=connector.run({relay:RELAY,signal:controller.signal});
  let settled=false;
  running.then(()=>{settled=true;},()=>{settled=true;});
  controller.abort();
  try {await delay(150);assert.equal(settled,true);}
  finally {host.close();await running.catch(()=>{});}
});

async function within(promise, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic operation hung")), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const mode of ["timeout", "abort", "already-aborted", "invalid-hello", "invalid-relay", "eof", "terminal"]) {
  test(`owned host channel closes on ${mode}`, async () => {
    const { channel, host, connector } = setup({ hello: mode === "terminal", handshakeTimeoutMs: mode === "timeout" ? 30 : 5_000 });
    const controller = new AbortController();
    if (mode === "already-aborted") controller.abort();
    const running = connector.run({ relay: mode === "invalid-relay" ? "https://relay.example.test" : RELAY, signal: controller.signal });
    // Observe rejection before another turn of the event loop.
    const outcome = running.then(result => ({ result }), error => ({ error }));
    try {
      if (mode === "abort") controller.abort();
      if (mode === "invalid-hello") channel.deliver({ version: 1, type: "host.hello", deviceId: "invalid" });
      if (mode === "eof") for (const close of channel.closers) close();
      if (mode === "terminal") {
        await until(() => Socket.all.length > 0);
        Socket.all[0].emit("close", { code: 4401 });
      }
      const { result, error } = await within(outcome);
      if (mode === "timeout") assert.match(error?.message ?? "", /host\.hello timed out/);
      else if (mode === "invalid-hello") assert.match(error?.message ?? "", /deviceId/);
      else if (mode === "invalid-relay") assert.match(error?.message ?? "", /must use wss/);
      else assert.equal(result?.status, mode === "terminal" ? "closed" : "stopped");
      assert.equal(channel.closeCalls, 1);
      assert.equal(host.isClosed, true);
      if (mode !== "terminal") assert.equal(Socket.all.length, 0);
    } finally {
      controller.abort();
      host.close();
      await outcome;
    }
  });
}

test("every connector error code and runtime publicMessage uses static relay text", async () => {
  const marker = "SYNTHETIC_CREDENTIAL_MARKER";
  const { channel, host, connector } = setup({ runtime: { seats: async () => { throw Object.assign(new Error(marker), { code: "lab_error", publicMessage: marker }); } } });
  const controller = new AbortController();
  const running = connector.connectOnce({ endpoint: new URL(RELAY), hello: await host.ready(), signal: controller.signal });
  const socket = Socket.all[0];
  try {
    socket.message({ version: 1, type: "device.hello", audience: RELAY, nonce: NONCE, issuedAt: TIME });
    await until(() => socket.sent.some(message => message.type === "device.auth"));
    socket.message({ version: 1, type: "device.bound", connectionId: "synthetic-bound" });
    const publicMessages = {
      "computer.unavailable": "Computer unavailable", "computer.warming": "Computer is warming up",
      method_unsupported: "Method unsupported", lab_error: "Lab error", unknown: "Computer unavailable",
    };
    for (const [code, message] of Object.entries(publicMessages)) {
      const rpcId = `synthetic-${code}`;
      const previous = channel.messages.filter(request => request.type === "host.rpc").length;
      socket.message({ type: "rpc.request", rpcId, channel: "mac", method: "notify", params: {} });
      await until(() => channel.messages.filter(request => request.type === "host.rpc").length === previous + 1);
      const forwarded = channel.messages.filter(request => request.type === "host.rpc").at(-1);
      channel.deliver({ version: 1, type: "host.rpc.error", id: forwarded.id, code, message: `authorization: Bearer ${marker}` });
      await until(() => socket.sent.some(reply => reply.rpcId === rpcId));
      const reply = socket.sent.find(reply => reply.rpcId === rpcId);
      assert.equal(reply.message, message);
      assert.equal(reply.code, code === "unknown" ? "computer.unavailable" : code);
    }
    socket.message({ type: "rpc.request", rpcId: "synthetic-runtime", channel: "turns", method: "seats", params: {} });
    await until(() => socket.sent.some(reply => reply.rpcId === "synthetic-runtime"));
    assert.equal(socket.sent.find(reply => reply.rpcId === "synthetic-runtime").message, "Lab error");
    assert.equal(JSON.stringify(socket.sent).includes(marker), false);
  } finally {
    controller.abort();
    host.close();
    await running;
  }
});

function inspectChunks(chunks) {
  const OriginalSocket = net.Socket;
  let socket;
  class SyntheticSocket extends EventEmitter {
    constructor() { super(); socket = this; this.destroyed = false; }
    setEncoding() {} write() {} end() {} destroy() { this.destroyed = true; } destroySoon() { this.destroy(); }
  }
  const delivered = [];
  let channel;
  try {
    net.Socket = SyntheticSocket;
    channel = fdHostChannel(3);
    channel.onMessage(message => delivered.push(message));
    for (const chunk of chunks) socket.emit("data", chunk);
    return { delivered, destroyed: socket.destroyed };
  } finally {
    channel?.close();
    net.Socket = OriginalSocket;
  }
}

test("signer bound counts UTF-8 bytes per complete line and accepts exactly 64 KiB", () => {
  const prefix = '{"padding":"';
  const suffix = '"}';
  const exact = prefix + "x".repeat(HOST_LINE_MAX_BYTES - prefix.length - suffix.length) + suffix;
  assert.equal(Buffer.byteLength(exact), HOST_LINE_MAX_BYTES);
  const accepted = inspectChunks([`${exact}\n${exact}\n`]);
  assert.equal(accepted.delivered.length, 2);
  assert.equal(accepted.destroyed, false);
  for (const line of [exact + " ", JSON.stringify({ padding: "é".repeat(HOST_LINE_MAX_BYTES / 2) }), " ".repeat(HOST_LINE_MAX_BYTES + 1)]) {
    const refused = inspectChunks([`${line}\n{}\n`]);
    assert.equal(refused.delivered.length, 0);
    assert.equal(refused.destroyed, true);
  }
  const partial = inspectChunks(["x".repeat(HOST_LINE_MAX_BYTES + 1), "\n{}\n"]);
  assert.equal(partial.delivered.length, 0);
  assert.equal(partial.destroyed, true);
});

for (const mode of ["abort", "timeout"]) {
  test(`parentPort listeners are removed before hello on ${mode}`, async () => {
    const port = new EventEmitter();
    port.postMessage = () => {};
    const host = new HostLink({ channel: portHostChannel(port) });
    const connector = new DeviceConnector({ host, runtime: {}, WebSocketImpl: Socket, appVersion: "0.4.1-jack.2", handshakeTimeoutMs: mode === "timeout" ? 30 : 5_000 });
    const controller = new AbortController();
    const running = connector.run({ relay: RELAY, signal: controller.signal });
    const outcome = running.then(result => ({ result }), error => ({ error }));
    try {
      assert.equal(port.listenerCount("message"), 1);
      if (mode === "abort") controller.abort();
      const { result, error } = await within(outcome);
      if (mode === "timeout") assert.match(error?.message ?? "", /host\.hello timed out/);
      else assert.equal(result?.status, "stopped");
      assert.equal(port.listenerCount("message"), 0);
      assert.equal(port.listenerCount("close"), 0);
    } finally {
      controller.abort();
      host.close();
      await outcome;
    }
  });
}

for (const mode of ["abort", "timeout", "oversized-single-write"]) {
  test(`real inherited descriptor closes without peer EOF on ${mode}`, async () => {
    const moduleUrl = new URL("../src/device-connect.mjs", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { HostLink, fdHostChannel, DeviceConnector } from ${JSON.stringify(moduleUrl)};
      const channel = fdHostChannel(3);
      channel.onMessage(() => process.stdout.write("DELIVERED\\n"));
      const host = new HostLink({ channel });
      const controller = new AbortController();
      process.once("SIGTERM", () => controller.abort());
      const connector = new DeviceConnector({ host, runtime: {}, WebSocketImpl: class {}, appVersion: "0.4.1-jack.2", handshakeTimeoutMs: ${mode === "timeout" ? 50 : 5_000} });
      const running = connector.run({ relay: ${JSON.stringify(RELAY)}, signal: controller.signal });
      process.stdout.write("WAITING\\n");
      try { await running; } catch (error) { process.stdout.write(error.message + "\\n"); }
      // Deliberately no caller-side close: run() owns the channel on every exit.
    `], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    const ended = new Promise((resolve, reject) => { child.once("exit", code => resolve(code)); child.once("error", reject); });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stdio[3].on("error", () => {});
    try {
      await until(() => output.includes("WAITING"));
      if (mode === "abort") child.kill("SIGTERM");
      if (mode === "oversized-single-write") child.stdio[3].write(JSON.stringify({ padding: "x".repeat(HOST_LINE_MAX_BYTES) }) + "\n");
      assert.equal(await within(ended, 1_000), 0);
      assert.equal(output.includes("DELIVERED"), false);
      if (mode === "timeout") assert.match(output, /host\.hello timed out/);
    } finally {
      child.kill("SIGKILL");
      child.stdio[3].destroy();
      await ended;
    }
  });
}

test('B3 privacy: host.rpc.error diagnostics never escape into relay rpc.error',async()=>{
  const {channel,host,connector}=setup();
  const controller=new AbortController();
  const running=connector.connectOnce({endpoint:new URL(RELAY),hello:await host.ready(),signal:controller.signal});
  const socket=Socket.all[0];
  socket.message({version:1,type:'device.hello',audience:RELAY,nonce:NONCE,issuedAt:TIME});
  try {
    await until(()=>socket.sent.some(m=>m.type==='device.auth'));
    socket.message({version:1,type:'device.bound',connectionId:'b3-connection'});
    socket.message({type:'rpc.request',rpcId:'b3-diagnostic',channel:'mac',method:'notify',params:{},deadline:new Date(Date.now()+1000).toISOString()});
    await until(()=>channel.messages.some(m=>m.type==='host.rpc'));
    const forwarded=channel.messages.find(m=>m.type==='host.rpc');
    channel.deliver({version:1,type:'host.rpc.error',id:forwarded.id,code:'computer.unavailable',message:'Synthetic failure authorization: Bearer SYNTHETIC_B3_DIAGNOSTIC_MARKER'});
    await until(()=>socket.sent.some(m=>m.type==='rpc.error'));
    assert.equal(JSON.stringify(socket.sent).includes('SYNTHETIC_B3_DIAGNOSTIC_MARKER'),false);
  } finally {controller.abort();host.close();await running;}
});

test('B3 frame bound: complete oversized signer line is refused before delivery',()=>{
  const OriginalSocket=net.Socket;
  let socket;
  class SyntheticSocket extends EventEmitter {
    constructor(){super();socket=this;this.destroyed=false;}
    setEncoding(){} write(){} end(){} destroy(){this.destroyed=true;} destroySoon(){this.destroy();}
  }
  let delivered=0;
  try {
    net.Socket=SyntheticSocket;
    const channel=fdHostChannel(3);
    channel.onMessage(()=>{delivered++;});
    socket.emit('data',JSON.stringify({version:1,type:'host.hello',padding:'x'.repeat(HOST_LINE_MAX_BYTES)})+'\n');
    assert.equal(delivered,0);
    assert.equal(socket.destroyed,true);
    channel.close();
  } finally {net.Socket=OriginalSocket;}
});

test('B3 frame bound integration: oversized JSON line across real fd chunks is refused',async()=>{
  const moduleUrl=new URL('../src/device-connect.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {fdHostChannel} from ${JSON.stringify(moduleUrl)};
    const channel=fdHostChannel(3);
    channel.onMessage(()=>process.stdout.write('DELIVERED\\n'));
  `],{stdio:['ignore','pipe','pipe','pipe']});
  let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;});
  const ended=new Promise(resolve=>child.once('exit',code=>resolve(code)));
  const line=JSON.stringify({version:1,type:'host.hello',padding:'x'.repeat(HOST_LINE_MAX_BYTES)})+'\n';
  try {
    child.stdio[3].on('error',()=>{});
    child.stdio[3].write(line.slice(0,40000));await delay(20);
    child.stdio[3].end(line.slice(40000));
    const code=await Promise.race([ended,delay(1000).then(()=> 'hung')]);
    assert.equal(code,0);assert.equal(output.includes('DELIVERED'),false);
  } finally {child.kill();await ended;}
});

test('B3 startup integration: SIGTERM before host.hello exits without connector EOF',async()=>{
  const moduleUrl=new URL('../src/device-connect.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {HostLink,fdHostChannel,DeviceConnector} from ${JSON.stringify(moduleUrl)};
    const host=new HostLink({channel:fdHostChannel(3)});
    const controller=new AbortController();
    process.once('SIGTERM',()=>controller.abort());
    const connector=new DeviceConnector({host,runtime:{},WebSocketImpl:class {},appVersion:'0.4.1-jack.2',handshakeTimeoutMs:50});
    const running=connector.run({relay:${JSON.stringify(RELAY)},signal:controller.signal});
    process.stdout.write('WAITING\\n');
    await running.catch(()=>{});
    host.close();
  `],{stdio:['ignore','pipe','pipe','pipe']});
  let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;});
  const ended=new Promise(resolve=>child.once('exit',code=>resolve(code)));
  try {
    await until(()=>output.includes('WAITING'));child.kill('SIGTERM');
    const exited=await Promise.race([ended.then(()=>true),delay(150).then(()=>false)]);
    child.stdio[3].end();await ended;
    assert.equal(exited,true);
  } finally {child.kill('SIGKILL');await ended;}
});
