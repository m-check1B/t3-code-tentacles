import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { publishRelease } from "../scripts/publish-forgejo-release.mjs";
const payload = Buffer.from("synthetic release package");
const checksum = Buffer.from(`${createHash("sha256").update(payload).digest("hex")}  tentacles-0.4.1.tgz\n`);
const environment = { FORGEJO_API_URL: "http://127.0.0.1:3000/api/v1", FORGEJO_SERVER_URL: "http://127.0.0.1:3000", FORGEJO_REPOSITORY: "matej/t3-code-tentacles", FORGEJO_REF_NAME: "v0.4.1", BRIDGE_PACKAGE_FILE: "tentacles-0.4.1.tgz", BRIDGE_RELEASE_TOKEN: "synthetic-ci-token" };
const readFileImpl = name => name.endsWith(".sha256") ? checksum : payload;

test("native publication creates a release and uploads both verified artifacts only to its own Forgejo", async () => {
  const calls = [];
  const result = await publishRelease({ environment, readFileImpl, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return new Response(null, { status: 404 });
    return Response.json({ id: 123 });
  } });
  assert.equal(result.releaseId, 123); assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.url.startsWith("http://127.0.0.1:3000/api/v1/repos/matej/t3-code-tentacles/") && c.options.redirect === "error"));
  assert.equal(JSON.parse(calls[1].options.body).tag_name, "v0.4.1");
  assert.equal((await calls[2].options.body.get("attachment").arrayBuffer()).byteLength, payload.byteLength);
});

test("GitHub or mismatched origins, traversal and a wrong repository fail before any token-bearing call", async () => {
  for (const overrides of [{ FORGEJO_API_URL: "https://api.github.com" }, { FORGEJO_SERVER_URL: "http://localhost:9999" }, { BRIDGE_PACKAGE_FILE: "../tentacles-0.4.1.tgz" }, { FORGEJO_REPOSITORY: "other/repo" }]) {
    await assert.rejects(publishRelease({ environment: { ...environment, ...overrides }, readFileImpl, fetchImpl: async () => assert.fail("must not send a credential") }), /configuration/);
  }
});

test("checksum mismatch fails before publishing and existing assets are never overwritten", async () => {
  await assert.rejects(publishRelease({ environment, readFileImpl: name => name.endsWith(".sha256") ? Buffer.from("bad checksum") : payload, fetchImpl: async () => assert.fail("must not publish") }), /checksum/);
  let calls = 0;
  await assert.rejects(publishRelease({ environment, readFileImpl, fetchImpl: async () => { calls++; return Response.json({ id: 1, assets: [{ name: "tentacles-0.4.1.tgz" }] }); } }), /already exists/);
  assert.equal(calls, 1);
});

test("upstream error payloads are never copied into diagnostics", async () => {
  await assert.rejects(publishRelease({ environment, readFileImpl, fetchImpl: async () => new Response("synthetic-ci-token", { status: 500 }) }), error => !error.message.includes(environment.BRIDGE_RELEASE_TOKEN) && error.message.includes("500"));
});
