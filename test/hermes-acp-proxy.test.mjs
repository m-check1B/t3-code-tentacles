import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CODEX_AUTH_MISSING,
  hasOpenAiCodexAuth,
  inspectHermesOpenaiCodexAuth,
  providerNotConstructableMessage,
  requestedProviderFromModel,
  requireRequestedProviderConstructable,
  resolveHermesBinary,
  startHermesAcpProxy,
  transformClientToAgentLine,
} from "../src/hermes-acp-launch.mjs";

const CLI_PATH = path.resolve("src/cli.mjs");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-hermes-auth-"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

test("requestedProviderFromModel parses provider:model and ignores bare ids", () => {
  assert.deepEqual(requestedProviderFromModel("openai-codex:gpt-5.6-sol"), {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  });
  assert.equal(requestedProviderFromModel("gpt-5.6-sol"), null);
  assert.equal(requestedProviderFromModel(""), null);
});

test("missing Codex auth fails closed with a named error and never returns token material", () => {
  const home = tempHome();
  try {
    const missing = inspectHermesOpenaiCodexAuth({ home });
    assert.deepEqual(missing, {
      present: false,
      constructable: false,
      provider: "openai-codex",
      code: CODEX_AUTH_MISSING,
    });
    assert.equal(hasOpenAiCodexAuth({ home }), false);
    assert.throws(
      () => requireRequestedProviderConstructable("openai-codex:gpt-5.6-sol", { home }),
      (error) => error.code === CODEX_AUTH_MISSING && /cannot construct openai-codex/.test(error.message),
    );
    assert.equal(JSON.stringify(missing).includes("sk-"), false);
    requireRequestedProviderConstructable("deepseek:deepseek-v4-flash", { home });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Codex auth presence is boolean-only across Hermes store, pool, and Codex CLI files", () => {
  const home = tempHome();
  const sentinel = "synthetic-codex-token-material-do-not-leak";
  try {
    writeJson(path.join(home, ".hermes", "auth.json"), {
      providers: { "openai-codex": { tokens: { access_token: sentinel, refresh_token: `${sentinel}-refresh` } } },
    });
    assert.equal(hasOpenAiCodexAuth({ home }), true);
    fs.rmSync(path.join(home, ".hermes"), { recursive: true, force: true });

    writeJson(path.join(home, ".hermes", "auth.json"), {
      credential_pool: { "openai-codex": [{ access_token: sentinel }] },
    });
    assert.equal(hasOpenAiCodexAuth({ home }), true);
    fs.rmSync(path.join(home, ".hermes"), { recursive: true, force: true });

    writeJson(path.join(home, ".codex", "auth.json"), {
      tokens: { access_token: sentinel, refresh_token: `${sentinel}-refresh` },
    });
    assert.equal(hasOpenAiCodexAuth({ home }), true);
    const inspected = inspectHermesOpenaiCodexAuth({ home });
    assert.equal(inspected.constructable, true);
    assert.equal(JSON.stringify(inspected).includes(sentinel), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("transformClientToAgentLine fails closed on openai-codex set_model without auth", () => {
  const home = tempHome();
  try {
    const setModel = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/set_model",
      params: { sessionId: "s1", modelId: "openai-codex:gpt-5.6-sol" },
    });
    const blocked = transformClientToAgentLine(setModel, { home });
    assert.deepEqual(blocked.respond.error.data, { code: CODEX_AUTH_MISSING, provider: "openai-codex" });
    assert.match(blocked.respond.error.message, /^codex_auth_missing:/);
    assert.equal(blocked.respond.error.message.includes("sk-"), false);
    assert.equal(blocked.respond.id, 7);

    const notice = transformClientToAgentLine(
      JSON.stringify({ jsonrpc: "2.0", method: "session/set_model", params: { modelId: "openai-codex:gpt-5.6-sol" } }),
      { home },
    );
    assert.deepEqual(notice, { drop: true });

    const sessionNew = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/repo", mcpServers: [{ name: "t3-code" }] },
    });
    assert.deepEqual(transformClientToAgentLine(sessionNew, { home }), { line: sessionNew });
    assert.deepEqual(transformClientToAgentLine("not-json", { home }), { line: "not-json" });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("transformClientToAgentLine forwards openai-codex set_model when credentials are present", () => {
  const home = tempHome();
  try {
    writeJson(path.join(home, ".hermes", "auth.json"), {
      providers: {
        "openai-codex": { tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } },
      },
    });
    const setModel = JSON.stringify({
      jsonrpc: "2.0",
      id: "mdl-1",
      method: "session/set_model",
      params: { sessionId: "s1", modelId: "openai-codex:gpt-5.6-sol" },
    });
    assert.deepEqual(transformClientToAgentLine(setModel, { home }), { line: setModel });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("resolveHermesBinary rejects relative HERMES_BIN and missing PATH entries", () => {
  assert.throws(() => resolveHermesBinary({ HERMES_BIN: "hermes" }), /absolute path/);
  assert.throws(() => resolveHermesBinary({ PATH: "" }), /hermes executable not found on PATH/);
  assert.equal(resolveHermesBinary({ HERMES_BIN: process.execPath }), process.execPath);
});

test("the proxy answers missing Codex set_model itself and never forwards it to Hermes", async () => {
  const home = tempHome();
  const fakeHermes = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } }) + "\\n");
  } else if (message.method === "session/set_model") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { leaked: "deepseek-fallback" } }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = startHermesAcpProxy({
    hermesBin: process.execPath,
    hermesProfile: "default",
    authOptions: { home },
    spawnImpl: (binary, args, options) => {
      assert.equal(binary, process.execPath);
      assert.deepEqual(args, ["--profile", "default", "acp"]);
      return spawn(binary, ["--input-type=module", "-e", fakeHermes], options);
    },
    stdin,
    stdout,
    exitImpl: () => {},
  });
  const lines = [];
  let pending = "";
  stdout.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    const split = pending.split("\n");
    pending = split.pop();
    lines.push(...split.filter(Boolean));
  });
  const nextLine = async (count) => {
    while (lines.length < count) await new Promise((resolve) => setTimeout(resolve, 10));
    return JSON.parse(lines[count - 1]);
  };
  try {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }) + "\n");
    assert.equal((await nextLine(1)).result.protocolVersion, 1);
    stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/set_model",
      params: { sessionId: "s1", modelId: "openai-codex:gpt-5.6-sol" },
    }) + "\n");
    const blocked = await nextLine(2);
    assert.equal(blocked.error.data.code, CODEX_AUTH_MISSING);
    assert.equal(blocked.result, undefined);
    assert.equal(JSON.stringify(blocked).includes("deepseek-fallback"), false);
    assert.equal(JSON.stringify(blocked).includes(providerNotConstructableMessage()), true);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("CLI hermes originate fails closed before T3 dispatch when Codex auth is missing", () => {
  const home = tempHome();
  const tokenDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bridge-cli-token-"));
  const tokenFile = path.join(tokenDirectory, "t3.token");
  fs.writeFileSync(tokenFile, "0".repeat(32) + "\n", { mode: 0o600 });
  try {
    const spawned = spawnSync(process.execPath, [
      CLI_PATH,
      "originate",
      "--workspace", home,
      "--title", "Hermes Codex",
      "--message", "must fail closed",
      "--instance", "hermes",
      "--model", "openai-codex:gpt-5.6-sol",
      "--runtime-mode", "full-access",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        T3_HERMES_TOKEN_FILE: tokenFile,
        T3_URL: "http://127.0.0.1:9",
      },
    });
    assert.equal(spawned.status, 1);
    assert.match(`${spawned.stderr}`, /codex_auth_missing: Hermes cannot construct openai-codex/);
    assert.equal(`${spawned.stdout}${spawned.stderr}`.includes("sk-"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(tokenDirectory, { recursive: true, force: true });
  }
});
