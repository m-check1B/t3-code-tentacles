import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { T3Client } from "../src/t3-client.mjs";
import {
  MatrixToolAuditEmitter,
  TOOL_AUDIT_EVENT_TYPE,
  TOOL_AUDIT_SCHEMA,
  matrixToolAuditEmitterFromEnv,
} from "../src/tool-audit.mjs";

const command = {
  type: "thread.turn.start",
  commandId: "command-1",
  message: { text: "must-not-enter-audit", secret: "must-not-enter-audit" },
};

function successfulMatrixFetch(calls) {
  return async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ event_id: `$event-${calls.length}:matrix.example` }), { status: 200 });
  };
}

test("Matrix emitter writes only the fixed secret-free schema", async () => {
  const calls = [];
  const emitter = new MatrixToolAuditEmitter({
    matrixUrl: "https://matrix.example",
    roomId: "!audit:matrix.example",
    token: "matrix-audit-token-value",
    actorId: "seat:synthetic",
    now: () => "2026-08-29T10:00:00.000Z",
    fetchImpl: successfulMatrixFetch(calls),
  });

  await emitter.before(command);
  await emitter.after(command, "succeeded");

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, new RegExp(`/send/${TOOL_AUDIT_EVENT_TYPE.replaceAll(".", "\\.")}/`));
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, "Bearer matrix-audit-token-value");
  assert.deepEqual(calls.map(({ body }) => body), [
    {
      schema: TOOL_AUDIT_SCHEMA,
      correlation_id: "command-1",
      actor_id: "seat:synthetic",
      service_name: "Tentacles",
      tool_name: "thread.turn.start",
      phase: "before",
      outcome: "attempted",
      recorded_at: "2026-08-29T10:00:00.000Z",
    },
    {
      schema: TOOL_AUDIT_SCHEMA,
      correlation_id: "command-1",
      actor_id: "seat:synthetic",
      service_name: "Tentacles",
      tool_name: "thread.turn.start",
      phase: "after",
      outcome: "succeeded",
      recorded_at: "2026-08-29T10:00:00.000Z",
    },
  ]);
  assert.equal(JSON.stringify(calls).includes("must-not-enter-audit"), false);
});

test("dispatch fails closed when the before record cannot be written", async () => {
  let dispatched = false;
  const client = new T3Client({
    token: "synthetic-t3-token",
    toolAuditEmitter: {
      before: async () => { throw new Error("audit unavailable"); },
      after: async () => { throw new Error("must not run"); },
    },
    fetchImpl: async () => {
      dispatched = true;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(client.dispatch(command), /audit unavailable/);
  assert.equal(dispatched, false);
});

test("dispatch records failed and successful terminal outcomes without error content", async () => {
  const audit = [];
  const toolAuditEmitter = {
    before: async (value) => { audit.push(["before", value.type]); },
    after: async (value, outcome) => { audit.push(["after", value.type, outcome]); },
  };
  const failed = new T3Client({
    token: "synthetic-t3-token",
    toolAuditEmitter,
    fetchImpl: async () => new Response("provider-secret", { status: 503 }),
  });
  await assert.rejects(failed.dispatch(command), /redacted error body/);
  assert.deepEqual(audit, [
    ["before", "thread.turn.start"],
    ["after", "thread.turn.start", "failed"],
  ]);

  audit.length = 0;
  const succeeded = new T3Client({
    token: "synthetic-t3-token",
    toolAuditEmitter,
    fetchImpl: async () => new Response(JSON.stringify({ sequence: 1 }), { status: 200 }),
  });
  assert.deepEqual(await succeeded.dispatch(command), { sequence: 1 });
  assert.deepEqual(audit, [
    ["before", "thread.turn.start"],
    ["after", "thread.turn.start", "succeeded"],
  ]);
  assert.equal(JSON.stringify(audit).includes("provider-secret"), false);
});

test("Matrix environment configuration is all-or-nothing and reads a private token file", () => {
  assert.equal(matrixToolAuditEmitterFromEnv({}), null);
  assert.throws(
    () => matrixToolAuditEmitterFromEnv({ TENTACLES_AUDIT_MATRIX_URL: "https://matrix.example" }),
    /configuration is incomplete/,
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tentacles-audit-"));
  const tokenFile = path.join(directory, "matrix.token");
  fs.writeFileSync(tokenFile, "synthetic-matrix-token\n", { mode: 0o600 });
  const emitter = matrixToolAuditEmitterFromEnv({
    TENTACLES_AUDIT_MATRIX_URL: "https://matrix.example",
    TENTACLES_AUDIT_MATRIX_ROOM_ID: "!audit:matrix.example",
    TENTACLES_AUDIT_MATRIX_TOKEN_FILE: tokenFile,
    TENTACLES_AUDIT_ACTOR_ID: "lab:synthetic",
  }, { fetchImpl: async () => new Response(JSON.stringify({ event_id: "$event:matrix.example" }), { status: 200 }) });
  assert.ok(emitter instanceof MatrixToolAuditEmitter);
  fs.chmodSync(tokenFile, 0o644);
  assert.throws(() => matrixToolAuditEmitterFromEnv({
    TENTACLES_AUDIT_MATRIX_URL: "https://matrix.example",
    TENTACLES_AUDIT_MATRIX_ROOM_ID: "!audit:matrix.example",
    TENTACLES_AUDIT_MATRIX_TOKEN_FILE: tokenFile,
    TENTACLES_AUDIT_ACTOR_ID: "lab:synthetic",
  }), /permissions are too broad/);
});

test("Matrix emitter rejects unsafe metadata and never reflects response bodies", async () => {
  assert.throws(() => new MatrixToolAuditEmitter({
    matrixUrl: "http://matrix.example",
    roomId: "!audit:matrix.example",
    token: "synthetic-matrix-token",
    actorId: "seat:synthetic",
  }), /must use https/);

  const emitter = new MatrixToolAuditEmitter({
    matrixUrl: "https://matrix.example",
    roomId: "!audit:matrix.example",
    token: "synthetic-matrix-token",
    actorId: "seat:synthetic",
    fetchImpl: async () => new Response("response-secret", { status: 403 }),
  });
  await assert.rejects(
    emitter.before(command),
    (error) => error.message === "Matrix audit write failed (403)" && !error.message.includes("response-secret"),
  );
  await assert.rejects(emitter.before({ ...command, type: "bad tool name" }), /command type/);
});
