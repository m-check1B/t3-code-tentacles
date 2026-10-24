import { startThread, continueThread } from "../../src/bridge.mjs";
import { LoopbackRuntimeAdapter } from "../../src/outbound-pairer.mjs";
import { T3Client } from "../../src/t3-client.mjs";

export const freshCapability = { talkTurnResult: "v1", talkFreshProviderContext: "v1", talkFreshProviderContextProviders: ["codex"] };

// Exercise the real client/bridge/adapter boundary with an isolated T3 transport.
export async function captureWire(protocol, { fresh = false, instanceId = "codex", capabilities = { talkTurnResult: "v1", talkFreshProviderContext: 0 } } = {}) {
  const wire = [], threads = new Map();
  const result = { threadId: "12345678-1111-4111-8111-111111111111", messageId: "next-message", turnCommandId: "next-command", turnId: "turn", assistantMessageId: "assistant", instanceId, model: "gpt-5.6-sol", effort: "high", state: "succeeded", outputText: "synthetic reply", ...(fresh ? { freshProviderContext: true, nativeContextGeneration: "next-command" } : {}) };
  const apply = (command) => {
    if (command.type === "thread.create") threads.set(command.threadId, { id: command.threadId, projectId: command.projectId, title: command.title, modelSelection: command.modelSelection, runtimeMode: command.runtimeMode, messages: [] });
    if (command.type === "thread.turn.start" || command.type === "message.dispatch") {
      threads.get(command.threadId).messages.push({ id: command.message?.messageId ?? command.messageId, role: "user", text: command.message?.text ?? command.text });
    }
  };
  const client = new T3Client({ baseUrl: "http://127.0.0.1:3773", token: "synthetic", orchestrationProtocol: protocol, fetchImpl: async (url, init) => {
    const pathname = new URL(url).pathname;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    wire.push({ pathname, method: init.method, ...(body === undefined ? {} : { body }) });
    let value;
    if (pathname === "/api/orchestration/turn-result") value = init.method === "POST" ? result : capabilities;
    else if (pathname === "/api/orchestration/dispatch") { apply(body); value = { sequence: wire.length }; }
    else {
      const thread = threads.get("12345678-1111-4111-8111-111111111111");
      if (!thread) return new Response("{}", { status: 404 });
      value = protocol === 2 ? { projection: { thread, runs: [], messages: thread.messages } } : { thread };
    }
    return new Response(JSON.stringify(value), { status: 200 });
  } });
  client.rpc = async (method, payload, { beforeSend } = {}) => {
    if (beforeSend) await beforeSend();
    wire.push({ method, payload });
    apply(payload);
    return { sequence: wire.length };
  };
  const selection = { instanceId, model: "gpt-5.6-sol", runtimeMode: "full-access" };
  await startThread(client, { ...selection, projectId: "project", threadId: "12345678-1111-4111-8111-111111111111", threadCommandId: "thread-command", turnCommandId: "first-command", messageId: "first-message", title: "Synthetic", message: "first", ...(fresh ? { freshProviderContext: true, fixedTitle: true } : {}) });
  const adapter = new LoopbackRuntimeAdapter({ client, doctorImpl: async () => ({ ready: true }) });
  await adapter.continue({ ...selection, threadId: "12345678-1111-4111-8111-111111111111", turnCommandId: "next-command", messageId: "next-message", message: "next", ...(fresh ? { freshProviderContext: true } : {}) });
  const doctor = await adapter.doctorStatus();
  const receipt = await adapter.turnResult({ threadId: "12345678-1111-4111-8111-111111111111", messageId: "next-message", turnCommandId: "next-command" });
  const normalized = wire.map((entry) => {
    const value = structuredClone(entry);
    if (value.body?.createdAt) value.body.createdAt = "<timestamp>";
    return value;
  });
  return { wire: normalized, doctor, receipt };
}
