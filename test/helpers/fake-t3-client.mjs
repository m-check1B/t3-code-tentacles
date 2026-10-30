// Preload for spawned CLI tests: replaces T3Client I/O with an in-memory T3.
// FAKE_T3_SETTINGS is the getSettings result; dispatched commands are appended
// to FAKE_T3_COMMANDS as JSON lines. FAKE_T3_CONFIG, when set, is the
// server.getConfig RPC result. FAKE_T3_CALLS, when set, gets one line per
// T3Client method call.
import fs from "node:fs";
import { T3Client, T3HttpError } from "../../src/t3-client.mjs";

const projects = new Map();
const threads = new Map();
Object.assign(T3Client.prototype, {
  getSettings: async () => JSON.parse(process.env.FAKE_T3_SETTINGS),
  snapshot: async () => ({ projects: [...projects.values()], threads: [...threads.values()] }),
  thread: async (threadId) => {
    if (!threads.has(threadId)) throw new T3HttpError({ method: "GET", pathname: threadId, status: 404, body: null });
    return { thread: threads.get(threadId) };
  },
  dispatch: async (command) => {
    fs.appendFileSync(process.env.FAKE_T3_COMMANDS, `${JSON.stringify(command)}\n`);
    if (command.type === "project.create") projects.set(command.projectId, { id: command.projectId, workspaceRoot: command.workspaceRoot });
    if (command.type === "thread.create") threads.set(command.threadId, { id: command.threadId, projectId: command.projectId, messages: [] });
    if (command.type === "thread.turn.start") threads.get(command.threadId).messages.push({ id: command.message.messageId, role: "user", text: command.message.text });
    return { sequence: 1 };
  },
  ...(process.env.FAKE_T3_CONFIG ? {
    rpc: async (tag) => {
      if (tag === "server.getConfig") return JSON.parse(process.env.FAKE_T3_CONFIG);
      throw new Error(`Synthetic T3 has no RPC ${tag}`);
    },
  } : {}),
});

if (process.env.FAKE_T3_CALLS) {
  for (const name of Object.getOwnPropertyNames(T3Client.prototype)) {
    const method = T3Client.prototype[name];
    if (name === "constructor" || typeof method !== "function") continue;
    T3Client.prototype[name] = function (...args) {
      fs.appendFileSync(process.env.FAKE_T3_CALLS, `${name}\n`);
      return method.apply(this, args);
    };
  }
}
