import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {PluginInventoryCache,codexPluginContext} from '../src/plugin-inventory.mjs';

// Ported unchanged from the B3 two-directory repro, apart from its import root.
test('R8: an unresolved relative executable must not be published as the exact T3 binary',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tentacles-b3-relative-binary-'));
  const originalCwd=process.cwd();
  t.after(()=>{process.chdir(originalCwd);fs.rmSync(root,{recursive:true,force:true});});
  const listing=id=>JSON.stringify({installed:[{pluginId:id+'@synthetic',name:id,marketplaceName:'synthetic',version:'1.0.0',enabled:true,installed:true}]});
  for(const seat of ['t3','pairer']){
    const dir=path.join(root,seat,'tools');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'codex'),`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(listing(seat))});\n`,{mode:0o700});
  }
  // A reference invocation under the T3 cwd uses only our synthetic executable.
  const reference=JSON.parse(execFileSync('./tools/codex',['plugin','list','--json'],{cwd:path.join(root,'t3'),env:{PATH:'/usr/bin:/bin'},encoding:'utf8'}));
  const settings={providerInstances:{codex:{driver:'codex',enabled:true,config:{binaryPath:'./tools/codex',homePath:path.join(root,'profile'),launchArgs:''}}}};
  process.chdir(path.join(root,'t3'));
  const t3Context=codexPluginContext(settings,{});
  process.chdir(path.join(root,'pairer'));
  const context=codexPluginContext(settings,{});
  const cache=new PluginInventoryCache({env:{}});
  cache.read(settings);await Promise.all(cache.inflight.values());
  const row=cache.read(settings,{refresh:false});
  console.log(JSON.stringify({case:'R8-relative-binary',contextAdmitted:!context.error,binaryPassedVerbatim:context.binary==='./tools/codex',unchangedKeyAcrossCwd:context.key===t3Context.key,state:row.state,expectedSyntheticPlugin:reference.installed[0].pluginId,actualSyntheticPlugin:row.plugins[0]?.pluginId}));
  assert.equal(row.state,'unavailable');
});

test('supported absolute binary remains selected independently of caller cwd',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tentacles-b3-absolute-binary-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binary=path.join(root,'codex');
  fs.writeFileSync(binary,`#!${process.execPath}\nprocess.stdout.write('{"installed":[]}');\n`,{mode:0o700});
  const settings={providerInstances:{codex:{driver:'codex',enabled:true,config:{binaryPath:binary,homePath:path.join(root,'profile')}}}};
  const context=codexPluginContext(settings,{});
  assert.equal(context.binary,binary);
  const cache=new PluginInventoryCache({env:{}});cache.read(settings);await Promise.all(cache.inflight.values());
  assert.equal(cache.read(settings,{refresh:false}).state,'observed');
});

test('R8: unresolved relative and PATH binaries never spawn or reuse a warmed observation', async () => {
  const absolute = path.join(path.parse(process.cwd()).root, 'synthetic', 'codex');
  const settingsFor = binaryPath => ({ providerInstances: { codex: {
    driver: 'codex', config: { binaryPath, homePath: path.join(path.parse(absolute).root, 'synthetic', 'profile') },
  } } });
  let children = 0;
  const cache = new PluginInventoryCache({ env: {}, execFileImpl: (binary, _args, _options, done) => {
    assert.equal(binary, absolute);
    children++;
    done(null, '{"installed":[]}');
  } });
  cache.read(settingsFor(absolute));
  await Promise.all(cache.inflight.values());
  assert.equal(cache.read(settingsFor(absolute), { refresh: false }).state, 'observed');
  assert.equal(children, 1);
  for (const binary of ['./tools/codex', '../tools/codex', 'tools/codex', 'tools\\codex',
    'codex', undefined, '', '  ', '~/tools/codex', 'C:tools\\codex',
    ...(process.platform === 'win32' ? ['\\tools\\codex', '/tools/codex'] : [])]) {
    for (const settings of [settingsFor(binary), { providers: { codex: settingsFor(binary).providerInstances.codex.config } }]) {
      const context = codexPluginContext(settings, {});
      assert.equal(context.error, 'binary_unverified');
      assert.equal(Object.hasOwn(context, 'binary'), false);
      assert.equal(Object.hasOwn(context, 'key'), false);
      const row = cache.read(settings);
      assert.equal(row.state, 'unavailable');
      assert.equal(row.code, 'binary_unverified');
      assert.equal(row.count, null);
      assert.equal(children, 1);
      assert.equal(cache.inflight.size, 0);
    }
  }
});

test('R8: absolute executable identity separates cached inventories across caller cwd', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tentacles-binary-cache-'));
  const originalCwd = process.cwd();
  t.after(() => { process.chdir(originalCwd); fs.rmSync(root, { recursive: true, force: true }); });
  const settingsFor = binaryPath => ({ providers: { codex: { binaryPath, homePath: root } } });
  const first = settingsFor(path.join(root, 't3', 'codex'));
  const second = settingsFor(path.join(root, 'pairer', 'codex'));
  const context = codexPluginContext(first, {});
  process.chdir(root);
  assert.equal(codexPluginContext(first, {}).key, context.key);
  assert.notEqual(codexPluginContext(second, {}).key, context.key);
  const calls = [];
  const cache = new PluginInventoryCache({ env: {}, execFileImpl: (binary, _args, _options, done) => {
    calls.push(binary);
    const id = binary === context.binary ? 't3' : 'pairer';
    done(null, JSON.stringify({ installed: [{ pluginId: id, name: id, marketplaceName: 'synthetic', version: '1.0.0', enabled: true, installed: true }] }));
  } });
  for (const settings of [first, second]) {
    cache.read(settings);
    await Promise.all(cache.inflight.values());
  }
  assert.deepEqual(calls, [context.binary, codexPluginContext(second, {}).binary]);
  assert.equal(cache.read(first, { refresh: false }).plugins[0].pluginId, 't3');
  assert.equal(cache.read(second, { refresh: false }).plugins[0].pluginId, 'pairer');
});
