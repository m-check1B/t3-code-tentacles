// KRA-8810: the $0 replacement for branch protection. Fake GitHub API only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  REFUSAL_FIXES, RELEASE_BRANCH, SignerRefusal, verifyReleaseBranch,
} from "../scripts/release/sign-manifest.mjs";

const [base, middle, tip, side, other] = ["b", "c", "d", "e", "f"].map((digit) => digit.repeat(40));
const zero = "0".repeat(40);
const ref = `refs/heads/${RELEASE_BRANCH}`;
const now = Date.parse("2026-10-25T13:00:00Z");
const receiptAt = "2026-10-25T11:00:00.000Z";
const entry = { commit: tip, version: "0.4.1-jack.4" };
const event = (activity_type, before, after, timestamp) => ({ activity_type, before, after, timestamp, ref });
const history = () => [
  event("push", middle, tip, "2026-10-25T12:00:00Z"),
  event("pr_merge", base, middle, "2026-10-25T10:00:00Z"),
  event("branch_creation", zero, base, "2026-10-25T09:00:00Z"),
];
const firstParent = () => ({ status: "ahead", behind_by: 0, total_commits: 2, commits: [
  { sha: middle, parents: [{ sha: base }] },
  { sha: tip, parents: [{ sha: middle }, { sha: side }] },
] });

function fakeGithub({ branch = { name: RELEASE_BRANCH, commit: { sha: tip } }, compare = firstParent(), events = history() } = {}) {
  const calls = [];
  return { calls, async api(suffix) {
    calls.push(suffix);
    if (suffix === `/branches/${encodeURIComponent(RELEASE_BRANCH)}`) return branch;
    if (suffix.startsWith("/compare/") && suffix.endsWith(`...${tip}`)) return compare;
    assert.fail(`unexpected api ${suffix}`);
  }, async list(suffix) {
    calls.push(suffix);
    assert.equal(suffix, `/activity?ref=${encodeURIComponent(ref)}&direction=desc&per_page=100`);
    return events;
  } };
}

const check = (github, binding = {}) => verifyReleaseBranch(github, entry, { auditedHead: tip, receiptAt, baseline: base, ...binding }, now);

test("accepts the branch tip reached by first-parent fast-forward pushes after the receipt", async () => {
  const github = fakeGithub();
  await check(github);
  assert.deepEqual(github.calls, [
    `/branches/${encodeURIComponent(RELEASE_BRANCH)}`,
    `/compare/${base}...${tip}`,
    `/activity?ref=${encodeURIComponent(ref)}&direction=desc&per_page=100`,
  ]);
});

test("the first manifest has no baseline and needs no compare call", async () => {
  const github = fakeGithub();
  await check(github, { baseline: null });
  assert.equal(github.calls.some((call) => call.startsWith("/compare/")), false);
});

test("activity order from GitHub does not matter; timestamps decide", async () => {
  await check(fakeGithub({ events: history().reverse() }));
});

const moved = history();
moved.unshift(event("push", tip, other, "2026-10-25T12:30:00Z"));
const twice = [event("push", other, tip, "2026-10-25T12:30:00Z"), event("push", tip, other, "2026-10-25T12:10:00Z"), ...history()];
const pushedEarly = history();
pushedEarly[0] = event("push", middle, tip, "2026-10-25T10:30:00Z");
const pushedLater = history();
pushedLater[0] = event("push", middle, tip, "2026-10-25T14:00:00Z");

for (const [label, facts, binding, code] of [
  ["a commit that is not the tip", { branch: { name: RELEASE_BRANCH, commit: { sha: other } } }, {}, "commit_not_branch_tip"],
  ["a malformed branch response", { branch: { protected: false } }, {}, "github_response_invalid"],
  ["a different branch", { branch: { name: "main", commit: { sha: tip } } }, {}, "github_response_invalid"],
  ["a baseline the tip diverged from", { compare: { ...firstParent(), status: "diverged", behind_by: 1 } }, {}, "history_not_first_parent"],
  ["a baseline only reachable through a second parent", { compare: { ...firstParent(), commits: [
    { sha: middle, parents: [{ sha: base }] }, { sha: tip, parents: [{ sha: side }, { sha: middle }] },
  ] } }, {}, "history_not_first_parent"],
  ["a truncated compare", { compare: { ...firstParent(), total_commits: 300 } }, {}, "history_too_long"],
  ["a malformed baseline", {}, { baseline: "not-a-sha" }, "history_not_first_parent"],
  ["an audited head off the first-parent line", {}, { auditedHead: side, baseline: null }, "history_not_first_parent"],
  ["any force-push", { events: [history()[0], event("force_push", base, middle, "2026-10-25T10:00:00Z"), history()[2]] }, {}, "branch_history_rewritten"],
  ["a branch deletion", { events: [...history().slice(0, 2), event("branch_deletion", base, zero, "2026-10-25T09:30:00Z"), history()[2]] }, {}, "branch_history_rewritten"],
  ["a branch re-creation", { events: [...history().slice(0, 2), event("branch_creation", zero, base, "2026-10-25T09:30:00Z"), history()[2]] }, {}, "branch_history_rewritten"],
  ["a gap in the push chain", { events: [event("push", other, tip, "2026-10-25T12:00:00Z"), ...history().slice(1)] }, {}, "branch_history_rewritten"],
  ["an unknown activity type", { events: [{ ...history()[0], activity_type: "merge_queue_merge" }, ...history().slice(1)] }, {}, "branch_history_rewritten"],
  ["an activity log that moved past the commit", { events: moved }, {}, "commit_not_branch_tip"],
  ["a commit reached twice", { events: twice }, {}, "commit_not_branch_tip"],
  ["a push before the B3 receipt", { events: pushedEarly }, {}, "branch_push_after_receipt_missing"],
  ["a push at the receipt time", { events: [event("push", middle, tip, receiptAt), ...history().slice(1)] }, {}, "branch_push_after_receipt_missing"],
  ["a future push", { events: pushedLater }, {}, "branch_push_after_receipt_missing"],
  ["a commit that only exists as the branch creation", { events: [event("branch_creation", zero, tip, "2026-10-25T12:00:00Z")] }, {}, "branch_push_after_receipt_missing"],
  ["an empty activity log", { events: [] }, {}, "github_response_invalid"],
  ["a foreign ref", { events: [{ ...history()[0], ref: "refs/heads/main" }, ...history().slice(1)] }, {}, "github_response_invalid"],
  ["a malformed timestamp", { events: [{ ...history()[0], timestamp: "yesterday" }, ...history().slice(1)] }, {}, "github_response_invalid"],
]) test(`refuses ${label}`, async () => {
  await assert.rejects(check(fakeGithub(facts), binding), (error) => error instanceof SignerRefusal && error.code === code);
});

test("every refusal the signer can raise names one concrete fix", () => {
  const sources = ["sign-manifest.mjs", "github-backend.mjs"].map((name) => fs.readFileSync(new URL(`../scripts/release/${name}`, import.meta.url), "utf8")).join("\n");
  const codes = new Set([...sources.matchAll(/refuse\("([a-z_0-9]+)"/g), ...sources.matchAll(/SignerRefusal\("([a-z_0-9]+)"/g)].map((match) => match[1]));
  assert.ok(codes.size > 30);
  for (const code of codes) assert.equal(typeof REFUSAL_FIXES[code], "string", code);
  assert.match(new SignerRefusal("commit_not_branch_tip", "0.4.1").message, /^refused: commit_not_branch_tip \(0\.4\.1\); fix: sign exactly one new version/);
});
