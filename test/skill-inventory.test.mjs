import assert from "node:assert/strict";
import test from "node:test";
import { doctor, SKILL_INVENTORY_VERSION, skillInventoryRow } from "../src/bridge.mjs";

test("doctor projects native lab skills without paths or descriptions (KRA-6203)", async () => {
  const client = {
    snapshot: async () => ({ projects: [], threads: [] }),
    getSettings: async () => ({ providerInstances: { codex: { driver: "codex", enabled: true } } }),
    rpc: async () => ({ providers: [{
      instanceId: "codex",
      status: "ready",
      installed: true,
      models: [{ slug: "gpt-6-astra" }],
      skills: [
        { name: "review", description: "PRIVATE DESCRIPTION", path: "/Users/someone/.codex/skills/review/SKILL.md", scope: "user", enabled: true },
        { name: "draft", description: "x", path: "/secret/draft", scope: "project", enabled: false },
      ],
    }] }),
  };
  const result = await doctor(client, { fetchImpl: async () => new Response("{}", { status: 503 }) });
  assert.equal(result.skillInventory.version, SKILL_INVENTORY_VERSION);
  const codex = result.skillInventory.labs.find((lab) => lab.instanceId === "codex");
  assert.equal(codex.state, "observed");
  assert.equal(codex.count, 2);
  assert.deepEqual(codex.skills, [
    { name: "draft", scope: "project", enabled: false },
    { name: "review", scope: "user", enabled: true },
  ]);
  assert.match(codex.digest, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(result.skillInventory);
  assert.doesNotMatch(serialized, /PRIVATE|\/Users\/|\/secret\//);
  // A lab T3 did not report skills for is unobserved, never zero.
  const cursor = result.skillInventory.labs.find((lab) => lab.instanceId === "cursor");
  assert.deepEqual([cursor.state, cursor.count, cursor.digest], ["unavailable", null, null]);
});

test("skill inventory drops unsafe names, normalizes scope and bounds size", () => {
  const skills = [
    { name: "ok", scope: "user", enabled: true },
    { name: "bad\u0007name", scope: "user", enabled: true },
    { name: "", enabled: true },
    { name: "x".repeat(129), enabled: true },
    { name: "odd-scope", scope: "../etc", enabled: true },
    { name: "odd-enabled", enabled: "yes" },
    { name: " padded", enabled: true },
    { name: "a/b", enabled: true },
    { name: "rtl\u202egnp", enabled: true },
    ...Array.from({ length: 600 }, (_, index) => ({ name: `bulk-${String(index).padStart(3, "0")}`, scope: "user", enabled: true })),
  ];
  const row = skillInventoryRow("codex", { skills });
  // Nothing is normalized: bad scope/enabled/whitespace/path/bidi names are dropped.
  assert.equal(row.dropped, 8);
  assert.equal(row.count, 601);
  assert.equal(row.truncated, true);
  assert.equal(row.skills.length, 512);
  assert.deepEqual(skillInventoryRow("codex", { skills: [{ name: "bare" }] }).skills, [
    { name: "bare", scope: null, enabled: null },
  ]);
  assert.equal(skillInventoryRow("hermes", { skills: [{ name: "x", enabled: true }] }).state, "unavailable");
});

test("skill inventory digest is order independent and changes with state", () => {
  const a = skillInventoryRow("codex", { skills: [{ name: "a", enabled: true }, { name: "b", enabled: true }] });
  const b = skillInventoryRow("codex", { skills: [{ name: "b", enabled: true }, { name: "a", enabled: true }] });
  const c = skillInventoryRow("codex", { skills: [{ name: "a", enabled: false }, { name: "b", enabled: true }] });
  assert.equal(a.digest, b.digest);
  assert.notEqual(a.digest, c.digest);
  assert.equal(skillInventoryRow("codex", { skills: [] }).count, 0);
  assert.equal(skillInventoryRow("codex", {}).state, "unavailable");
});

test("skill digest is order independent for duplicate identities with distinct enabled state", () => {
  const skills = [{ name: "duplicate", scope: "user", enabled: true }, { name: "duplicate", scope: "user", enabled: false }];
  const forward = skillInventoryRow("codex", { skills });
  const reverse = skillInventoryRow("codex", { skills: [...skills].reverse() });
  assert.equal(forward.digest, reverse.digest);
  assert.deepEqual(forward.skills, reverse.skills);
  assert.equal(forward.count, 2, "duplicate identities remain visible for consumer quarantine");
});
