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
    { name: "odd-scope", scope: "../etc", enabled: "yes" },
    ...Array.from({ length: 600 }, (_, index) => ({ name: `bulk-${String(index).padStart(3, "0")}`, scope: "user", enabled: true })),
  ];
  const row = skillInventoryRow("codex", { skills });
  assert.equal(row.dropped, 3);
  assert.equal(row.count, 602);
  assert.equal(row.truncated, true);
  assert.equal(row.skills.length, 512);
  const odd = skillInventoryRow("codex", { skills: [skills[4]] }).skills[0];
  assert.deepEqual(odd, { name: "odd-scope", scope: null, enabled: null });
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
