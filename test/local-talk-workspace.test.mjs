import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureLocalTalkWorkspace } from "../src/local-talk-workspace.mjs";
import { LoopbackRuntimeAdapter, RemoteRpcShim } from "../src/outbound-pairer.mjs";

const tenant = "a".repeat(32);
const agent = "b".repeat(32);
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-talk-fixture-")));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".jack-local-scratch");
  return { home, root, workspace: path.join(root, "jack-talk", tenant, agent) };
}

for (const source of ["web", "routine", "bot-dm"]) {
  test(`${source}-originated paired Local turn creates its workspace before dispatch without a desktop`, async t => {
    const { home, root, workspace } = fixture(t);
    assert.equal(fs.existsSync(workspace), false);
    let calls = 0;
    const adapter = new LoopbackRuntimeAdapter({ client: {},
      prepareTalkWorkspaceImpl: value => ensureLocalTalkWorkspace(value, { home }),
      originateImpl: (_, params) => {
        calls++;
        assert.equal(params.workspace, workspace);
        assert.equal(params.runtimeMode, "full-access");
        for (const directory of [root, path.join(root, "jack-talk"), path.dirname(workspace), workspace]) {
          assert.equal(fs.lstatSync(directory).isDirectory(), true);
          assert.equal(fs.lstatSync(directory).mode & 0o777, 0o700);
          assert.equal(fs.lstatSync(directory).uid, process.getuid());
        }
        return { accepted: true };
      },
    });
    const shim = new RemoteRpcShim(adapter);
    const request = { version: 1, type: "rpc.request", id: `${source}-request`, method: "originate",
      params: { workspace, title: "Synthetic Local proof", message: "synthetic", instanceId: "codex",
        model: "test-model", runtimeMode: "full-access", idempotencyKey: "jack-talk:test-run" } };
    const first = await shim.handle(request);
    assert.equal(first.type, "rpc.result");
    assert.deepEqual(first.result, { accepted: true });
    const inode = fs.lstatSync(workspace).ino;
    assert.equal((await shim.handle({ ...request, id: `${source}-second` })).type, "rpc.result");
    assert.equal(fs.lstatSync(workspace).ino, inode);
    assert.equal(calls, 2);
  });
}

test("legacy and hire workspaces are not created or rewritten", t => {
  const { home } = fixture(t);
  const workspace = path.join(home, "legacy-missing");
  assert.equal(ensureLocalTalkWorkspace(workspace, { home }), false);
  assert.equal(fs.existsSync(workspace), false);
});

for (const tail of ["jack-talk/short/"+agent, "jack-talk/"+tenant+"/"+agent.toUpperCase(),
  "jack-talk/"+tenant+"/"+agent+"/extra", "jack-talk/"+tenant+"/../"+agent, "cookies/"+tenant+"/"+agent]) {
  test(`malformed scope ${tail} refuses before creation`, t => {
    const { home, root } = fixture(t);
    assert.throws(() => ensureLocalTalkWorkspace(root+"/"+tail, { home }), /scope refused/);
    assert.equal(fs.existsSync(root), false);
  });
}

test("another computer's root and relative scratch paths are refused", t => {
  const { home, root } = fixture(t);
  for (const workspace of [`/other-home/.jack-local-scratch/jack-talk/${tenant}/${agent}`,
    `.jack-local-scratch/jack-talk/${tenant}/${agent}`]) {
    assert.throws(() => ensureLocalTalkWorkspace(workspace, { home }), /scope refused/);
  }
  assert.equal(fs.existsSync(root), false);
});

for (const level of [0, 1, 2, 3]) {
  test(`symlink at private level ${level} refuses without dispatch`, async t => {
    const { home, root, workspace } = fixture(t);
    const directories = [root, path.join(root, "jack-talk"), path.join(root, "jack-talk", tenant), workspace];
    for (const directory of directories.slice(0, level)) fs.mkdirSync(directory, { mode: 0o700 });
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, directories[level]);
    let dispatched = false;
    const adapter = new LoopbackRuntimeAdapter({ client: {},
      prepareTalkWorkspaceImpl: value => ensureLocalTalkWorkspace(value, { home }),
      originateImpl: () => { dispatched = true; },
    });
    const result = await new RemoteRpcShim(adapter).handle({ version: 1, type: "rpc.request", id: "symlink",
      method: "originate", params: { workspace } });
    assert.equal(result.type, "rpc.error");
    assert.equal(dispatched, false);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
}

test("renderer/remote callers cannot override machine authority", async t => {
  const { home, root, workspace } = fixture(t);
  let prepared = false;
  const adapter = new LoopbackRuntimeAdapter({ client: {}, prepareTalkWorkspaceImpl: () => { prepared = true; } });
  for (const field of ["home", "scratchRoot", "tenantHex", "agentHex", "createWorkspaceRootIfMissing"]) {
    const result = await new RemoteRpcShim(adapter).handle({ version: 1, type: "rpc.request", id: "closed-body",
      method: "originate", params: { workspace, [field]: "not-allowed" } });
    assert.equal(result.type, "rpc.error");
  }
  assert.equal(prepared, false);
  assert.equal(fs.existsSync(root), false);
});

test("existing owned private directories are tightened idempotently", t => {
  const { home, root, workspace } = fixture(t);
  ensureLocalTalkWorkspace(workspace, { home });
  fs.chmodSync(workspace, 0o755);
  assert.equal(ensureLocalTalkWorkspace(workspace, { home }), true);
  assert.equal(fs.lstatSync(workspace).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(root).mode & 0o777, 0o700);
});


test("a writable home refuses before creating private state", t => {
  const { home, root, workspace } = fixture(t);
  fs.chmodSync(home, 0o775);
  assert.throws(() => ensureLocalTalkWorkspace(workspace, { home }), /scope refused/);
  assert.equal(fs.existsSync(root), false);
});

test("a regular file at the scratch root refuses", t => {
  const { home, root, workspace } = fixture(t);
  fs.writeFileSync(root, "synthetic", { mode: 0o600 });
  assert.throws(() => ensureLocalTalkWorkspace(workspace, { home }), /scope refused/);
  assert.equal(fs.readFileSync(root, "utf8"), "synthetic");
});

test("source-checkout home components remain refused", t => {
  const data = fixture(t);
  const home = path.join(data.home, "github");
  fs.mkdirSync(home, { mode: 0o700 });
  const workspace = path.join(home, ".jack-local-scratch", "jack-talk", tenant, agent);
  assert.throws(() => ensureLocalTalkWorkspace(workspace, { home }), /scope refused/);
  assert.equal(fs.existsSync(path.join(home, ".jack-local-scratch")), false);
});

test("a foreign-owned opened directory is refused before dispatch", async t => {
  const { home, workspace } = fixture(t);
  const original = fs.fstatSync;
  fs.fstatSync = fd => {
    const info = original(fd);
    return { isDirectory: () => info.isDirectory(), uid: process.getuid()+1, ino: info.ino, dev: info.dev };
  };
  t.after(() => { fs.fstatSync = original; });
  let dispatched = false;
  const adapter = new LoopbackRuntimeAdapter({ client: {},
    prepareTalkWorkspaceImpl: value => ensureLocalTalkWorkspace(value, { home }),
    originateImpl: () => { dispatched = true; },
  });
  const result = await new RemoteRpcShim(adapter).handle({ version: 1, type: "rpc.request", id: "foreign-owner",
    method: "originate", params: { workspace } });
  assert.equal(result.type, "rpc.error");
  assert.equal(dispatched, false);
});
