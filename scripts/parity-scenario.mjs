#!/usr/bin/env node
// KRA-8959: parity scenario "grok-bot-vs-jack-csv-pipeline", keyless and $0.
// The chair runtime (LoopbackRuntimeAdapter: originate, turn-result,
// thread-events, thread-artifact, interrupt, Local Talk custody) runs against
// an in-memory synthetic T3 with two scripted labs. No provider, no network,
// no real T3, no ~/.t3 data. Prints one PASS/FAIL line per step; exit 1 on FAIL.
// Every injection into the chair runtime:
// - client: the synthetic T3 below (snapshot, dispatch, turn-result rows,
//   assets.createUrl and the fetchImpl that serves workspace files).
// - originateImpl: the real originate, with stateFile set to a temp ledger.
// - threadEventsDirectory: a temp journal directory, not the real state dir.
// - interruptOptions: shortened waits (2s/2s/5s/10ms, production 4s/14s/22s/200ms).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { originate } from "../src/bridge.mjs";
import { LoopbackRuntimeAdapter } from "../src/outbound-pairer.mjs";
import { T3HttpError } from "../src/t3-client.mjs";

export const SCENARIO = "grok-bot-vs-jack-csv-pipeline";
const SALES_CSV = "sku,units,price\nA,2,10\nB,3,5\n";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

// Synthetic lab 1: reads sales.csv from the workspace, answers JSON only.
async function analysisLab({ workspace }) {
  const raw = fs.readFileSync(path.join(workspace, "sales.csv"), "utf8");
  const rows = raw.trim().split("\n").slice(1).map((line) => line.split(","));
  const revenue = rows.reduce((sum, [, units, price]) => sum + Number(units) * Number(price), 0);
  return { outputText: JSON.stringify({ revenue, rows: rows.length }), files: [], rawOutput: `raw-tool-output:analysis:${raw}` };
}

// Synthetic lab 2: builds out/index.html from the JSON in its message only.
// Its workspace has no sales.csv, so it cannot read the CSV directly.
// It writes a partial page first, so an interrupt lands mid-run. It also drops
// a credential-shaped file to prove the export filter skips it.
async function builderLab({ workspace, text, signal, holdMs }) {
  const data = JSON.parse(/\{[^{}]*\}/.exec(text)[0]);
  const out = path.join(workspace, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), "<!doctype html><html><body><p>partial");
  await abortableDelay(holdMs, signal);
  const html = `<!doctype html><html><body><h1>Revenue ${data.revenue}</h1><ul><li>A</li><li>B</li></ul><p>rows ${data.rows}</p></body></html>\n`;
  fs.writeFileSync(path.join(out, "index.html"), html);
  fs.writeFileSync(path.join(out, ".env"), "SYNTHETIC_ONLY=1\n");
  return { outputText: "Wrote out/index.html", files: ["out/index.html", "out/.env"], rawOutput: `raw-tool-output:builder:${html}` };
}

/** In-memory T3: projects, threads, exact turn-result rows, assets and interrupt by session. */
export class SyntheticT3 {
  constructor({ labs }) {
    this.labs = labs;
    this.holdMs = 0;
    this.projects = new Map();
    this.threads = new Map();
    this.turns = new Map();
    this.running = new Map();
    this.assets = new Map();
    this.baseUrl = "http://127.0.0.1:1";
    this.requestTimeoutMs = 1_000;
    this.fetchImpl = async (url) => {
      const asset = this.assets.get(new URL(url).pathname);
      return asset ? new Response(fs.readFileSync(asset)) : new Response("gone", { status: 404 });
    };
  }

  key({ threadId, messageId, turnCommandId }) { return `${threadId}|${messageId}|${turnCommandId}`; }

  async getSettings() { return { providerInstances: {} }; }
  async snapshot() { return clone({ projects: [...this.projects.values()], threads: [...this.threads.values()] }); }
  async thread(threadId) {
    if (!this.threads.has(threadId)) throw new T3HttpError({ method: "GET", pathname: "/thread", status: 404, body: null });
    return { thread: clone(this.threads.get(threadId)) };
  }

  async request(url, options) {
    if (url !== "/api/orchestration/turn-result") throw new Error("synthetic T3: unknown request");
    if (options?.method !== "POST") return { talkTurnResult: "v1" };
    const turn = this.turns.get(this.key(options.body));
    if (!turn) throw new T3HttpError({ method: "POST", pathname: url, status: 404, body: null });
    return clone(turn);
  }

  async rpc(method, { resource }) {
    if (method !== "assets.createUrl" || resource._tag !== "workspace-file") throw new Error("synthetic T3: unknown asset");
    const workspace = this.projects.get(this.threads.get(resource.threadId).projectId).workspaceRoot;
    const relativeUrl = `/api/assets/${randomUUID()}`;
    this.assets.set(relativeUrl, path.join(workspace, resource.path));
    return { relativeUrl };
  }

  async dispatch(command) {
    const now = new Date().toISOString();
    if (command.type === "project.create") {
      this.projects.set(command.projectId, { id: command.projectId, workspaceRoot: command.workspaceRoot, deletedAt: null });
    } else if (command.type === "thread.create") {
      this.threads.set(command.threadId, { id: command.threadId, projectId: command.projectId, modelSelection: command.modelSelection,
        runtimeMode: command.runtimeMode, session: { status: "ready", activeTurnId: null }, messages: [], activities: [], checkpoints: [] });
    } else if (command.type === "thread.turn.start") {
      const thread = this.threads.get(command.threadId);
      thread.messages.push({ id: command.message.messageId, role: "user", text: command.message.text, createdAt: now });
      const turn = { threadId: command.threadId, messageId: command.message.messageId, turnCommandId: command.commandId,
        turnId: null, assistantMessageId: null, instanceId: thread.modelSelection.instanceId, model: thread.modelSelection.model,
        effort: null, state: "pending", outputText: null };
      this.turns.set(this.key(turn), turn);
      setImmediate(() => this.runTurn(thread, turn, command.message.text));
    } else if (command.type === "thread.turn.interrupt") {
      // Like T3: interrupt the session's active turn, whatever turnId says.
      this.running.get(command.threadId)?.abort(new Error("interrupted"));
    }
    return { sequence: 1 };
  }

  async runTurn(thread, turn, text) {
    const controller = new AbortController();
    turn.turnId = randomUUID();
    thread.session = { status: "running", activeTurnId: turn.turnId };
    this.running.set(thread.id, controller);
    const workspace = this.projects.get(thread.projectId).workspaceRoot;
    let result = null;
    try {
      result = await this.labs[thread.modelSelection.instanceId]({ workspace, text, signal: controller.signal, holdMs: this.holdMs });
    } catch {
      result = null;
    }
    this.running.delete(thread.id);
    const completedAt = new Date().toISOString();
    if (!result) {
      turn.state = "cancelled";
      thread.latestTurn = { turnId: turn.turnId, state: "interrupted", completedAt };
    } else {
      const assistantMessageId = randomUUID();
      thread.messages.push({ id: assistantMessageId, role: "assistant", text: result.outputText, turnId: turn.turnId, createdAt: completedAt });
      thread.activities.push({ id: randomUUID(), kind: "tool.completed", summary: "Synthetic tool ran", createdAt: completedAt, payload: { rawOutput: result.rawOutput } });
      if (result.files.length) {
        thread.checkpoints.push({ status: "ready", checkpointRef: randomUUID(), completedAt, files: result.files.map((file) => ({ path: file, kind: "added" })) });
      }
      thread.latestTurn = { turnId: turn.turnId, state: "completed", completedAt };
      Object.assign(turn, { state: "succeeded", outputText: result.outputText, assistantMessageId });
    }
    thread.session = { status: "ready", activeTurnId: null };
  }
}

async function waitFor(check, { timeoutMs = 10_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("synthetic scenario wait timed out");
}

const tuple = ({ threadId, messageId, turnCommandId }) => ({ threadId, messageId, turnCommandId });

export async function runParityScenario({ log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-parity-"));
  const workspace = path.join(root, "workspace");
  const builderWorkspace = path.join(root, "builder-workspace");
  fs.mkdirSync(workspace);
  fs.mkdirSync(builderWorkspace);
  fs.writeFileSync(path.join(workspace, "sales.csv"), SALES_CSV);
  const stateFile = path.join(root, "bridge-state.json");
  const directory = path.join(root, "thread-events");
  const t3 = new SyntheticT3({ labs: { "lab-one": analysisLab, "lab-two": builderLab } });
  const chair = new LoopbackRuntimeAdapter({
    client: t3,
    // The real originate, pinned to a temporary ledger instead of ~/.t3 state.
    originateImpl: (client, params) => originate(client, { ...params, stateFile }),
    threadEventsDirectory: directory,
    interruptOptions: { startWaitMs: 2_000, terminalWaitMs: 2_000, totalBudgetMs: 5_000, intervalMs: 10 },
  });
  const steps = [];
  const step = async (id, name, body) => {
    let passed = false; let evidence;
    try { evidence = await body(); passed = true; } catch (error) { evidence = error.message; }
    steps.push({ id, name, passed, evidence });
    log(`${passed ? "PASS" : "FAIL"} step${id} ${name}: ${evidence}`);
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const settled = (receipt) => waitFor(async () => {
    const result = await chair.turnResult(tuple(receipt));
    return result.state === "pending" ? null : result;
  });

  const analysisParams = { workspace, title: "Parity analysis", instanceId: "lab-one", model: "synthetic-1", runtimeMode: "full-access",
    idempotencyKey: `parity:${randomUUID()}:analysis`, message: "Read sales.csv in the workspace. Reply with JSON only: {\"revenue\": <number>, \"rows\": <number>}." };
  let analysis; let analysisJson; let builder; let page;
  try {
    await step(1, "analysis worker returns JSON only", async () => {
      analysis = await chair.originate(analysisParams);
      const result = await settled(analysis);
      check(result.state === "succeeded", `turn-result state ${result.state}`);
      check(!Object.hasOwn(result, "code") && !result.outputText.includes("provider-error"), "provider-error body present");
      const parsed = JSON.parse(result.outputText);
      check(Object.keys(parsed).sort().join() === "revenue,rows" && parsed.revenue === 35 && parsed.rows === 2, `unexpected ${result.outputText}`);
      analysisJson = result.outputText;
      return `state=succeeded output=${analysisJson}`;
    });

    await step(2, "builder worker writes out/index.html", async () => {
      check(analysisJson, "no analysis JSON");
      builder = await chair.originate({ workspace: builderWorkspace, title: "Parity builder", instanceId: "lab-two", model: "synthetic-1", runtimeMode: "full-access",
        idempotencyKey: `parity:${randomUUID()}:builder`, message: `Write out/index.html showing revenue, A and B from this JSON only: ${analysisJson}` });
      check(builder.threadId !== analysis.threadId, "builder reused the analysis thread");
      const userText = (await t3.thread(builder.threadId)).thread.messages[0].text;
      check(!userText.includes("sku,units,price"), "builder was given the CSV, not only the JSON");
      const result = await settled(builder);
      check(result.state === "succeeded", `turn-result state ${result.state}`);
      const events = await chair.threadEvents({ threadId: builder.threadId });
      const artifacts = events.events.filter((event) => event.kind === "artifact");
      check(artifacts.length === 1 && artifacts[0].payload.name === "index.html", `artifacts ${artifacts.map((event) => event.payload.name).join(",")}`);
      const read = () => chair.threadArtifact({ threadId: builder.threadId, eventId: artifacts[0].eventId });
      const first = read(); const second = read();
      const bytes = Buffer.from(first.contentBase64, "base64");
      check(first.nextOffset === first.totalBytes, "artifact not read whole");
      check(first.sha256 === second.sha256 && first.sha256 === sha256(bytes) && first.sha256 === artifacts[0].payload.sha256, "artifact sha256 unstable");
      page = bytes.toString("utf8");
      for (const text of ["35", "A", "B"]) check(page.includes(text), `page lacks ${text}`);
      const journal = fs.readFileSync(path.join(directory, `${builder.threadId}.json`), "utf8");
      check(!journal.includes("SYNTHETIC_ONLY") && !/"name":"\.env"/.test(journal), "credential-shaped path exported");
      return `artifact=index.html sha256=${first.sha256} stable=2 reads; out/.env not exported`;
    });

    await step(3, "page text check (browser stand-in)", async () => {
      check(page, "no page");
      const visible = page.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      for (const text of ["35", "A", "B"]) check(new RegExp(`\\b${text}\\b`).test(visible), `visible text lacks ${text}`);
      return `visible="${visible}"`;
    });

    await step(4, "idempotency: same bytes same thread, one altered byte refused", async () => {
      check(analysis, "no analysis receipt");
      const replay = await chair.originate(analysisParams);
      check(replay.threadId === analysis.threadId && replay.messageId === analysis.messageId, "replay changed the thread");
      check((await t3.thread(analysis.threadId)).thread.messages.filter((m) => m.role === "user").length === 1, "replay dispatched a second turn");
      const altered = { ...analysisParams, message: `${analysisParams.message.slice(0, -1)}!` };
      let refused = null;
      try { await chair.originate(altered); } catch (error) { refused = error.message; }
      check(refused && /already used with different input/.test(refused), `altered byte not refused (${refused})`);
      return `replay thread=${replay.threadId}; altered refused: ${refused}`;
    });

    await step(5, "interrupt builder mid-run", async () => {
      check(analysisJson, "no analysis JSON");
      t3.holdMs = 10_000;
      const run = await chair.originate({ workspace: builderWorkspace, title: "Parity builder interrupt", instanceId: "lab-two", model: "synthetic-1", runtimeMode: "full-access",
        idempotencyKey: `parity:${randomUUID()}:interrupt`, message: `Write out/index.html showing revenue, A and B from this JSON only: ${analysisJson}` });
      await waitFor(async () => (await chair.turnResult(tuple(run))).turnId);
      check(fs.readFileSync(path.join(builderWorkspace, "out", "index.html"), "utf8").includes("partial"), "builder was not mid-run");
      const stop = await chair.interrupt({ requestId: `stop-${randomUUID()}`, ...tuple(run), reason: "user_stop" });
      check(["cancelled", "already_terminal"].includes(stop.status), `interrupt status ${stop.status}`);
      const result = await chair.turnResult(tuple(run));
      check(result.state !== "succeeded" && result.outputText === null, `partial reported as ${result.state}`);
      const events = await chair.threadEvents({ threadId: run.threadId, includeTurnEnd: true });
      check(!events.events.some((event) => event.kind === "artifact"), "partial page exported");
      check(events.events.some((event) => event.kind === "turn_end" && event.payload.outcome === "cancelled"), "no cancelled turn_end");
      return `interrupt=${stop.status} turn-result=${result.state} outputText=null; no artifact`;
    });

    await step(6, "isolation: no journal holds the other worker's raw tool output", async () => {
      check(analysis && builder, "workers missing");
      await chair.threadEvents({ threadId: analysis.threadId });
      const journal = (threadId) => fs.readFileSync(path.join(directory, `${threadId}.json`), "utf8");
      const analysisJournal = journal(analysis.threadId);
      const builderJournal = journal(builder.threadId);
      check(!builderJournal.includes("raw-tool-output:analysis") && !builderJournal.includes("sku,units,price"), "builder journal holds analysis raw output");
      check(!analysisJournal.includes("raw-tool-output:builder") && !analysisJournal.includes("<h1>"), "analysis journal holds builder raw output");
      check(!/raw-tool-output:/.test(analysisJournal + builderJournal), "a journal holds raw tool output");
      check(analysisJournal.includes("Synthetic tool ran") && builderJournal.includes("Synthetic tool ran"), "tool summary missing");
      return `journals ${analysis.threadId.slice(0, 8)}/${builder.threadId.slice(0, 8)} hold summaries only`;
    });
  } finally {
    for (const controller of t3.running.values()) controller.abort(new Error("scenario end"));
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { scenario: SCENARIO, passed: steps.length === 6 && steps.every((entry) => entry.passed), steps };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runParityScenario();
  process.stdout.write(`${report.passed ? "PASS" : "FAIL"} ${SCENARIO}\n`);
  if (!report.passed) process.exitCode = 1;
}
