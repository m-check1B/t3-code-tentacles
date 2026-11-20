#!/usr/bin/env node
// Minimal ACP agent standing in for dsh-acp in the stock-T3 smoke (no model, no
// network, no credential). It records only the DSH permission mode and the
// ACP client name per process, to FAKE_DSH_LOG.
import fs from "node:fs";

const log = (entry) => fs.appendFileSync(process.env.FAKE_DSH_LOG, `${JSON.stringify({ mode: process.env.DSH_PERMISSION_MODE ?? null, ...entry })}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const model = { id: "model", name: "Model", type: "select", currentValue: "deepseek/deepseek-v4-flash", options: [{ value: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" }] };
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      log({ client: message.params?.clientInfo?.name ?? null });
      send({ id: message.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true, promptCapabilities: {}, sessionCapabilities: { resume: true, list: true, close: false } } } });
    } else if (["session/new", "session/load", "session/resume"].includes(message.method)) {
      send({ id: message.id, result: { sessionId: "fake-session", configOptions: [model] } });
    } else if (message.method === "session/prompt") {
      const text = JSON.stringify(message.params?.prompt ?? "").includes("PONG") ? "PONG" : "PING";
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    } else if (message.id !== undefined && message.method) {
      send({ id: message.id, result: {} });
    }
  }
});
