import test from "node:test";
import assert from "node:assert/strict";
import { approvedB3 } from "../scripts/release/sign-manifest.mjs";

const head = "a".repeat(40);
const binding = { head, number: 71, writerThread: "writer-session", headAvailableAt: "2026-10-24T10:00:00Z", mergedAt: "2026-10-24T11:30:00Z", now: Date.parse("2026-10-24T12:00:00Z") };
const receipt = {
  body: `APPROVE tentacles-private#71 ${head} P1=0 P2=0\nwriter-thread=writer-session reviewer-thread=reviewer-session`,
  user: { id: 127414494, login: "m-check1B" }, created_at: "2026-10-24T11:00:00Z", updated_at: "2026-10-24T11:00:00Z",
};

test("GitHub B3 accepts a pinned-account exact-head receipt from a different thread", () => {
  assert.equal(approvedB3(receipt, binding), true);
});

for (const [label, patch] of [
  ["wrong account id", { user: { id: 1, login: "m-check1B" } }],
  ["wrong account login", { user: { id: 127414494, login: "other" } }],
  ["wrong PR", { body: receipt.body.replace("#71", "#72") }],
  ["wrong head", { body: receipt.body.replace(head, "b".repeat(40)) }],
  ["nonzero P1", { body: receipt.body.replace("P1=0", "P1=1") }],
  ["nonzero P2", { body: receipt.body.replace("P2=0", "P2=1") }],
  ["not first line", { body: `quoted\n${receipt.body}` }],
  ["legacy receipt", { body: `B3 APPROVE head=${head}` }],
  ["same thread", { body: receipt.body.replace("reviewer-session", "writer-session") }],
  ["missing threads", { body: receipt.body.split("\n")[0] }],
  ["writer mismatch", { body: receipt.body.replace("writer-thread=writer-session", "writer-thread=other") }],
  ["duplicate marker", { body: `${receipt.body}\nwriter-thread=other reviewer-thread=other2` }],
  ["edited", { updated_at: "2026-10-24T11:01:00Z" }],
  ["missing edit metadata", { updated_at: undefined }],
  ["old before push evidence", { created_at: "2026-10-24T09:59:59Z", updated_at: "2026-10-24T09:59:59Z" }],
  ["same time as push evidence", { created_at: binding.headAvailableAt, updated_at: binding.headAvailableAt }],
  ["future", { created_at: "2026-10-24T13:00:00Z", updated_at: "2026-10-24T13:00:00Z" }],
  ["post merge", { created_at: "2026-10-24T11:31:00Z", updated_at: "2026-10-24T11:31:00Z" }],
]) test(`GitHub B3 refuses ${label}`, () => assert.equal(approvedB3({ ...receipt, ...patch }, binding), false));

for (const patch of [{ writerThread: null }, { headAvailableAt: null }, { mergedAt: null }, { number: 72 }]) {
  test(`GitHub B3 refuses missing or mismatched binding ${Object.keys(patch)[0]}`, () => assert.equal(approvedB3(receipt, { ...binding, ...patch }), false));
}

const signer = await import("../scripts/release/sign-manifest.mjs");
const repo = "m-check1B/t3-code-tentacles-private";
const suite = { head_sha: head, repository: { full_name: repo }, app: { id: 15368, slug: "github-actions" }, created_at: binding.headAvailableAt };
function provenanceBackend({ pullPatch = {}, suites = [suite], comments = [receipt], candidates = null } = {}) {
  const calls = [];
  const pull = { number: 71, merged: true, merge_commit_sha: head, head: { sha: head, repo: { full_name: repo } }, base: { ref: signer.PROTECTED_BRANCH, repo: { full_name: repo } }, body: "writer-thread=writer-session", merged_at: binding.mergedAt, ...pullPatch };
  return { calls, async api(suffix) { calls.push(suffix); assert.equal(suffix, "/pulls/71"); return pull; }, async list(suffix, field) {
    calls.push(suffix);
    if (suffix.endsWith("/pulls?per_page=100")) return candidates ?? [pull];
    if (suffix.includes("/check-suites?")) { assert.equal(field, "check_suites"); return suites; }
    if (suffix === "/issues/71/comments?per_page=100") return comments;
    assert.fail(`unexpected endpoint ${suffix}`);
  } };
}

test("GitHub provenance binds a full merged PR, exact head, protected repo and authenticated post-push evidence", async () => {
  const backend = provenanceBackend();
  const result = await signer.verifyGithubProvenance(backend, { commit: head, version: "0.4.1" }, binding.now);
  assert.equal(result.binding.writerThread, "writer-session");
  assert.ok(backend.calls.includes(`/commits/${head}/pulls?per_page=100`));
  assert.ok(backend.calls.includes("/issues/71/comments?per_page=100"));
});

for (const [label, facts] of [
  ["unmerged", { pullPatch: { merged: false } }],
  ["merge commit instead of reviewed head", { pullPatch: { merge_commit_sha: "b".repeat(40) } }],
  ["different head", { pullPatch: { head: { sha: "b".repeat(40), repo: { full_name: repo } } } }],
  ["foreign base repo", { pullPatch: { base: { ref: signer.PROTECTED_BRANCH, repo: { full_name: "other/repo" } } } }],
  ["foreign head repo", { pullPatch: { head: { sha: head, repo: { full_name: "other/repo" } } } }],
  ["wrong branch", { pullPatch: { base: { ref: "main", repo: { full_name: repo } } } }],
  ["missing PR writer", { pullPatch: { body: null } }],
  ["duplicate PR writer", { pullPatch: { body: "writer-thread=writer-session\nwriter-thread=other" } }],
  ["missing push bound", { suites: [] }],
  ["wrong head push bound", { suites: [{ ...suite, head_sha: "b".repeat(40) }] }],
  ["foreign repo push bound", { suites: [{ ...suite, repository: { full_name: "other/repo" } }] }],
  ["forged app id", { suites: [{ ...suite, app: { id: 1, slug: "github-actions" } }] }],
  ["forged app slug", { suites: [{ ...suite, app: { id: 15368, slug: "other" } }] }],
  ["future push bound", { suites: [{ ...suite, created_at: "2026-10-25T00:00:00Z" }] }],
  ["no comments", { comments: [] }],
  ["ambiguous PR association", { candidates: [{ number: 71, head: { sha: head }, base: { ref: signer.PROTECTED_BRANCH, repo: { full_name: repo } } }, { number: 72, head: { sha: head }, base: { ref: signer.PROTECTED_BRANCH, repo: { full_name: repo } } }] }],
]) test(`GitHub provenance refuses ${label}`, async () => {
  await assert.rejects(signer.verifyGithubProvenance(provenanceBackend(facts), { commit: head, version: "0.4.1" }, binding.now), error => ["pr_not_merged", "b3_head_not_signed_commit", "b3_receipt_missing"].includes(error.code));
});

test("default GitHub backend pins the host, paginates comments and uses gh for private assets", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-fake-gh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeGh = path.join(dir, "gh.cjs");
  fs.writeFileSync(fakeGh, `const args = process.argv.slice(2); const route = args.at(-1);
    if (route.includes('/branches/')) console.log(JSON.stringify({protected:true}));
    else if (route.includes('/comments?')) console.log(JSON.stringify([[{id:1}],[{id:2}]]));
    else if (route.includes('/check-suites?')) console.log(JSON.stringify([{check_suites:[{id:3}]},{check_suites:[{id:4}]}]));
    else if (route.endsWith('/releases/tags/v0.4.1')) console.log(JSON.stringify({id:5,tag_name:'v0.4.1',draft:false}));
    else if (route.endsWith('/releases/5/assets?per_page=100')) console.log(JSON.stringify([[{id:6,name:'tentacles-0.4.1.tgz',browser_download_url:'https://github.com/m-check1B/t3-code-tentacles-private/releases/download/v0.4.1/tentacles-0.4.1.tgz'}]]));
    else if (route.endsWith('/releases/assets/6')) process.stdout.write('SYNTHETIC-PACKAGE');
    else process.exit(1);
  `);
  const calls = [];
  const backend = signer.githubBackends({ workDir: dir, spawnImpl(command, args, options) {
    calls.push({ command, args });
    assert.equal(command, "gh");
    assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
    return spawn(process.execPath, [fakeGh, ...args], options);
  } });
  assert.deepEqual(await backend.api("/branches/x"), { protected: true });
  assert.deepEqual(await backend.list("/issues/71/comments?per_page=100"), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await backend.list(`/commits/${head}/check-suites?per_page=100`, "check_suites"), [{ id: 3 }, { id: 4 }]);
  assert.equal(await backend.releaseAssetSha256("0.4.1"), createHash("sha256").update("SYNTHETIC-PACKAGE").digest("hex"));
  assert.ok(calls.filter((call) => call.args.includes("--paginate")).every((call) => call.args.includes("--slurp")));
  assert.ok(calls.every((call) => call.args.at(-1).startsWith(`repos/${repo}/`)));
  assert.ok(calls.some((call) => call.args.includes("Accept: application/octet-stream")));
});
