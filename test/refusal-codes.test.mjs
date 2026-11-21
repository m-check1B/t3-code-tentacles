import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { RemoteRpcShim } from "../src/outbound-pairer.mjs";
import { REFUSALS, refusalOf } from "../src/refusal-codes.mjs";

const UNAVAILABLE = { code: "computer.unavailable", message: "Computer unavailable", data: null };
const request = (method) => ({ version: 1, type: "rpc.request", id: "r1", method, params: {} });
const throwing = (error) => ({ originate: async () => { throw error; }, continue: async () => { throw error; } });

test("KRA-10870: a known refusal is logged with its typed code; the relay frame stays exactly unavailable", async () => {
  const cases = [
    ["Jack tools need this computer paired again from an updated Agent Jack (Settings > Local labs > pair this computer)", "bot_connectors.pair_again"],
    ["Codex home config keeps projects in a form Tentacles does not edit; trust this Bot workspace in Codex first", "bot_connectors.codex_home"],
    ["Bot connectors need this Bot's own workspace", "bot_connectors.new_talk"],
    ["Bot connectors are not supported on this lab", "bot_connectors.lab_not_covered"],
    ["This Talk is still answering. Its tools change once it finishes; try again then.", "talk.still_answering"],
  ];
  for (const [text, code] of cases) {
    const logged = [];
    const shim = new RemoteRpcShim(throwing(new Error(text)), { onRefusal: (refusal) => logged.push(refusal) });
    const reply = await shim.handle(request("continue"));
    assert.deepEqual(reply, { version: 1, type: "rpc.error", id: "r1", error: UNAVAILABLE }); // Sphere and today's Jack accept only this
    assert.deepEqual(logged, [{ method: "continue", code, text: REFUSALS[code] }]);
  }
});

test("KRA-10870: an unknown error is logged as unknown, with none of its own text", async () => {
  const logged = [];
  const raw = new Error("EISDIR: /home/owner/.jack-local-scratch/x Bearer SECRET-TOKEN");
  const shim = new RemoteRpcShim(throwing(raw), { onRefusal: (refusal) => logged.push(refusal) });
  assert.deepEqual((await shim.handle(request("originate"))).error, UNAVAILABLE);
  assert.deepEqual(logged, [{ method: "originate", code: "unknown", text: REFUSALS.unknown }]);
  assert.doesNotMatch(JSON.stringify(logged), /owner|SECRET|EISDIR/);
  // Envelope faults are not runtime refusals and log nothing; a failing logger never changes the reply.
  const quiet = new RemoteRpcShim(throwing(raw), { onRefusal: () => { throw new Error("log down"); } });
  assert.deepEqual((await quiet.handle(request("originate"))).error, UNAVAILABLE);
  const none = [];
  await new RemoteRpcShim(throwing(raw), { onRefusal: (refusal) => none.push(refusal) }).handle({ ...request("originate"), version: 9 });
  assert.deepEqual(none, []);
  assert.equal(refusalOf("not an error").code, "unknown");
});

test("KRA-10870: every mapped text still exists in the source, so a reworded refusal cannot fall to unknown unseen", () => {
  const source = fs.readdirSync(new URL("../src/", import.meta.url)).filter((name) => name.endsWith(".mjs") && name !== "refusal-codes.mjs")
    .map((name) => fs.readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")).join("\n");
  const table = fs.readFileSync(new URL("../src/refusal-codes.mjs", import.meta.url), "utf8");
  const texts = [...table.matchAll(/^\s*\["(.+)", "([a-z_.]+)"\],$/gm)];
  assert.ok(texts.length >= 16);
  for (const [, text, code] of texts) {
    assert.ok(source.includes(text.replace(/\\"/g, '"')), `refusal text drifted: ${text}`);
    assert.ok(Object.hasOwn(REFUSALS, code));
  }
});
