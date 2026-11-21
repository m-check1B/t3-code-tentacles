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
    ["The Codex config in the Codex home T3 uses already has a server named like one of this Bot's Jack tools (for example jack), and Codex would merge the two; rename or remove that server there, then send again", "bot_connectors.codex_servers"],
    ["The Codex config in the Codex home T3 uses keeps servers in a form Tentacles does not read; write each server as its own [mcp_servers.<name>] table, then send again", "bot_connectors.codex_servers"],
    ["This lab cannot use Jack tools on Local yet; run this Bot on Server to use them", "bot_connectors.lab_not_covered"],
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
  assert.ok(texts.length >= 10); // The Bot connector texts are derived from BOT_CONNECTOR_REFUSALS, not listed.
  for (const [, text, code] of texts) {
    assert.ok(source.includes(text.replace(/\\"/g, '"')), `refusal text drifted: ${text}`);
    assert.ok(Object.hasOwn(REFUSALS, code));
  }
});

test("KRA-10870 (B3 P3-4 on #108): every Bot connector refusal text has a code, and the old-Talk text says start a new Talk", async () => {
  const { BOT_CONNECTOR_REFUSALS } = await import("../src/bot-connector-refusals.mjs");
  const { BOT_CONNECTOR_CODES } = await import("../src/refusal-codes.mjs");
  assert.deepEqual(Object.keys(BOT_CONNECTOR_CODES).sort(), Object.keys(BOT_CONNECTOR_REFUSALS).sort());
  for (const [key, text] of Object.entries(BOT_CONNECTOR_REFUSALS)) {
    assert.equal(refusalOf(new Error(text)).code, BOT_CONNECTOR_CODES[key], key);
    assert.ok(Object.hasOwn(REFUSALS, BOT_CONNECTOR_CODES[key]), key);
  }
  assert.equal(refusalOf(new Error(BOT_CONNECTOR_REFUSALS.oldTalk)).code, "bot_connectors.new_talk");
});

test("KRA-10870 (B3 P3-1..P3-3, P3-5 on #108): each refusal gets the fix that works", () => {
  const cases = [
    ["Bot connectors name a host this computer is not paired with", "bot_connectors.pair_again"],
    ["Bot connector admission expired", "bot_connectors.clock"],
    ["Bot connector directory must be a real directory", "bot_connectors.bot_folder"],
    ["Bot connector file must not be a directory", "bot_connectors.bot_folder"],
    ["Talk instruction guard file must not be a directory", "bot_connectors.bot_folder"],
    ["Thread workspace could not be resolved; continue refused before T3", "bot_connectors.new_talk"],
    ["Bridge state is busy; retry originate after the active watcher operation completes", "try_again"],
    ["Codex home config changed while trusting this Bot workspace; try again", "try_again"],
    ["continue does not accept remote parameter refusalCodes", "tentacles.update"],
    ["T3 RPC orchestration.dispatchCommand websocket failed", "t3.unreachable"],
  ];
  for (const [text, code] of cases) assert.equal(refusalOf(new Error(text)).code, code, text);
  // The parameter name is the only value in that text, and the logged words never carry it.
  assert.doesNotMatch(JSON.stringify(refusalOf(new Error("continue does not accept remote parameter refusalCodes"))), /refusalCodes/);
  assert.equal(refusalOf(new Error("continue does not accept remote parameter a b")).code, "unknown");
});

test("KRA-10870: T3 not running is t3.unreachable, by the same test doctor uses", () => {
  const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
  assert.deepEqual(refusalOf(refused), { code: "t3.unreachable", text: "Start T3 Code (Beta) on this computer, then send again." });
  const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  assert.equal(refusalOf(reset).code, "unknown");
});

test("KRA-10870 (B3 P3-6 on #108): a throwing message getter logs unknown, and a rejecting async hook is contained", async () => {
  const sly = new Error("x");
  Object.defineProperty(sly, "message", { get() { throw new Error("getter"); } });
  assert.equal(refusalOf(sly).code, "unknown");
  const logged = [];
  await new RemoteRpcShim(throwing(sly), { onRefusal: (refusal) => logged.push(refusal) }).handle(request("continue"));
  assert.equal(logged[0].code, "unknown");
  let unhandled = 0;
  const count = () => { unhandled += 1; };
  process.on("unhandledRejection", count);
  try {
    const shim = new RemoteRpcShim(throwing(new Error("x")), { onRefusal: async () => { throw new Error("log down"); } });
    assert.deepEqual((await shim.handle(request("continue"))).error, UNAVAILABLE);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, 0);
  } finally {
    process.off("unhandledRejection", count);
  }
});

test("KRA-10870 part 2: a turn RPC that asks with refusalCodes v1 gets the code and fixed words in data.refusal", async () => {
  const seen = [];
  const runtime = {
    originate: async (params) => { seen.push(params); throw new Error("Bot connector admission expired"); },
    continue: async (params) => { seen.push(params); throw new Error("EISDIR: /home/owner/secret"); },
  };
  const shim = new RemoteRpcShim(runtime);
  const asked = (method) => ({ ...request(method), params: { threadId: "t", refusalCodes: "v1" } });
  assert.deepEqual((await shim.handle(asked("originate"))).error, {
    code: "computer.unavailable", message: "Computer unavailable",
    data: { refusal: { code: "bot_connectors.clock", text: REFUSALS["bot_connectors.clock"] } },
  });
  const unknown = (await shim.handle(asked("continue"))).error;
  assert.deepEqual(unknown.data, { refusal: { code: "unknown", text: REFUSALS.unknown } });
  assert.doesNotMatch(JSON.stringify(unknown), /owner|secret|EISDIR/);
  // The runtime never sees the opt-in, so its own parameter allowlist is unchanged.
  assert.deepEqual(seen, [{ threadId: "t" }, { threadId: "t" }]);
});

test("KRA-10870 part 2: without the opt-in the frame stays exactly unavailable, and other values are refused", async () => {
  const seen = [];
  const runtime = { continue: async (params) => { seen.push(params); throw new Error("Bot connector admission expired"); } };
  const shim = new RemoteRpcShim(runtime);
  assert.deepEqual((await shim.handle(request("continue"))).error, UNAVAILABLE); // Sphere closes the relay on any other frame
  assert.deepEqual((await shim.handle({ ...request("continue"), params: { refusalCodes: "v2" } })).error, UNAVAILABLE);
  assert.deepEqual(seen.at(-1), { refusalCodes: "v2" }); // left for the runtime to refuse as an unknown parameter
  // Only turn RPCs take it; an envelope fault before the runtime never carries data.
  const doctor = new RemoteRpcShim({ doctorStatus: async () => { throw new Error("Bot connector admission expired"); } });
  assert.deepEqual((await doctor.handle({ ...request("doctor-status"), params: { refusalCodes: "v1" } })).error, UNAVAILABLE);
  assert.deepEqual((await shim.handle({ ...request("continue"), version: 9, params: { refusalCodes: "v1" } })).error, UNAVAILABLE);
});

test("KRA-10870 part 2: doctor-status advertises refusalCodes v1 next to the other capabilities", async () => {
  const shim = new RemoteRpcShim({ doctorStatus: async () => ({ product: "Tentacles", capabilities: { talkTurnResult: "v1" } }) });
  const reply = await shim.handle(request("doctor-status"));
  assert.deepEqual(reply.result.capabilities, { talkTurnResult: "v1", refusalCodes: "v1" });
  const bare = new RemoteRpcShim({ doctorStatus: async () => ({ product: "Tentacles" }) });
  assert.equal((await bare.handle(request("doctor-status"))).result.capabilities, undefined);
});
