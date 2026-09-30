import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_STATE_DIR } from "./config.mjs";
import { acquirePairStateLock } from "./pair-state.mjs";

export const DEFAULT_THREAD_EVENTS_DIRECTORY = path.join(DEFAULT_STATE_DIR, "thread-events");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const PAGE_BYTES = 750_000; // Preserve existing 1 MiB relay frame limit.
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const safeText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) throw new Error("Invalid thread journal directory");
}

function readJournal(file) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid()) || stat.size > MAX_JOURNAL_BYTES) {
      throw new Error("Invalid thread journal file");
    }
    const data = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!Array.isArray(data) || data.some((event, index) => event.sequence !== index + 1)) {
      throw new Error("Invalid thread journal sequence");
    }
    return data;
  } finally { fs.closeSync(fd); }
}

function iso(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Missing event time");
  return new Date(value).toISOString();
}

/** Compact allowlisted projection; raw terminal input/output and auth stay unread. */
export function projectThreadEvents(thread) {
  if (!record(thread) || !UUID.test(thread.id)) throw new Error("Invalid thread identity");
  const projected = [];
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  for (const message of messages) {
    if (!record(message) || !["user", "assistant"].includes(message.role)) continue;
    // A streaming assistant message is not an immutable journal entry yet.
    if (message.streaming === true || message.isStreaming === true) continue;
    if (message.role === "assistant" && thread.session?.status === "running"
      && (!message.turnId || message.turnId === thread.session?.activeTurnId)) continue;
    if (!safeText(message.id, 160) || typeof message.text !== "string" || message.text.length > 100_000) throw new Error("Invalid thread message");
    if (!message.text) continue;
    const eventId = `message:${message.id}`;
    projected.push({ eventId, kind: "message", occurredAt: iso(message.createdAt),
      payload: { role: message.role, text: message.text, messageId: message.id,
        ...(safeText(message.turnId, 200) ? { turnId: message.turnId } : {}) } });
    // Only explicit user marks become memory candidates. Jack revalidates the
    // complete original text against its durable-facts parser, including
      // fences, quotes and message-wide negation. This is a candidate, not
      // authorization to persist memory; Jack resolves face/team scope.
    if (message.role === "user") {
      for (const line of message.text.split(/\r?\n/)) {
        const match = /^[ \t]*(?:Remember that|Remember:|Fact:)[ \t]+(.{1,280})[ \t]*$/.exec(line);
        if (!match) continue;
        const text = match[1].replace(/\s+/g, " ").trim();
        projected.push({ eventId: `memory:${hash(`${message.id}:${text}`)}`, kind: "memory",
          occurredAt: iso(message.createdAt), payload: { text, scope: "face", sourceEventId: eventId } });
      }
    }
  }
  for (const activity of Array.isArray(thread.activities) ? thread.activities : []) {
    if (!record(activity) || !safeText(activity.id, 160)) continue;
    if (!["tool.completed", "terminal.completed", "tool.result"].includes(activity.kind)) continue;
    // Summary/title is deliberately separate from rawInput/rawOutput.
    const summary = activity.summary ?? activity.title;
    if (!safeText(summary, 4000)) continue;
    projected.push({ eventId: `tool:${activity.id}`, kind: "tool_summary",
      occurredAt: iso(activity.createdAt), payload: { summary } });
  }
  projected.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const status = thread.hasPendingApprovals || thread.hasPendingUserInput ? "blocked"
    : ["starting", "running"].includes(thread.session?.status) ? "generating"
      : thread.session?.status === "error" ? "failed" : "ready";
  // State transition IDs are assigned by the journal, not snapshot timestamps.
  return { events: projected, state: status };
}

/** Append-only durable source journal. No secrets/payloads are logged. */
export function recordThreadEvents(threadId, candidates, { directory = DEFAULT_THREAD_EVENTS_DIRECTORY, state } = {}) {
  if (!UUID.test(threadId)) throw new Error("Invalid thread identity");
  privateDirectory(directory);
  const file = path.join(directory, `${threadId}.json`);
  // Reuse private owner/PID locks with safe dead-process recovery.
  const release = acquirePairStateLock(file);
  if (!release) throw new Error("Thread journal is busy");
  try {
    const journal = readJournal(file);
    const existing = new Map(journal.map((event) => [event.eventId, event]));
    for (const candidate of candidates) {
      if (!record(candidate) || !safeText(candidate.eventId, 200)
        || !["message", "tool_summary", "artifact", "state", "memory"].includes(candidate.kind)
        || !record(candidate.payload)) throw new Error("Invalid journal candidate");
      const old = existing.get(candidate.eventId);
      if (old) {
        if (old.kind !== candidate.kind || JSON.stringify(old.payload) !== JSON.stringify(candidate.payload)) {
          throw new Error("Source event changed after journaling");
        }
        continue;
      }
      const event = { threadId, eventId: candidate.eventId, sequence: journal.length + 1,
        occurredAt: iso(candidate.occurredAt), kind: candidate.kind, payload: candidate.payload };
      if (Buffer.byteLength(JSON.stringify(event)) > 36 * 1024 * 1024) throw new Error("Event exceeds relay frame bound");
      journal.push(event);
      existing.set(event.eventId, event);
    }
    if (state && journal.findLast((event) => event.kind === "state")?.payload.status !== state) {
      const sequence = journal.length + 1;
      journal.push({ threadId, eventId: `state:${sequence}`, sequence,
        occurredAt: new Date().toISOString(), kind: "state", payload: { status: state } });
    }
    const encoded = JSON.stringify(journal);
    if (Buffer.byteLength(encoded) > MAX_JOURNAL_BYTES) throw new Error("Thread journal storage bound exceeded");
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, encoded);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file);
      const dirFd = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return journal;
  } finally {
    release();
  }
}

export async function threadEvents(client, params, { directory = DEFAULT_THREAD_EVENTS_DIRECTORY } = {}) {
  if (!record(params) || Object.keys(params).some((key) => !["threadId", "afterSequence", "limit"].includes(key))) {
    throw new Error("Invalid thread-events params");
  }
  const { threadId, afterSequence = 0, limit = 100 } = params;
  if (!UUID.test(threadId) || !Number.isSafeInteger(afterSequence) || afterSequence < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid thread-events cursor");
  const response = await client.thread(threadId);
  if (!record(response?.thread) || response.thread.id !== threadId) throw new Error("Thread identity mismatch");
  // If upstream announces windowed history, refuse silent loss. A future T3
  // full-history/event API adapter must explicitly page it before projecting.
  if (response.hasMore || response.nextCursor || response.pagination?.hasMore || response.page?.hasMore || response.page?.beforeCursor) throw new Error("Incomplete T3 history");
  const projected = projectThreadEvents(response.thread);
  privateDirectory(directory);
  const previous = readJournal(path.join(directory, `${threadId}.json`));
  projected.events.push(...await attachmentEvents(client, response.thread, previous));
  projected.events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const journal = recordThreadEvents(threadId, projected.events, { directory, state: projected.state });
  if (afterSequence > journal.length) throw new Error("Thread journal cursor is ahead of source");
  const events = [];
  let bytes = 0; let artifactBytes = 0;
  for (const stored of journal.slice(afterSequence, afterSequence + limit)) {
    const event = stored.kind === "artifact" ? { ...stored, payload: {
      name: stored.payload.name, mediaType: stored.payload.mediaType, sha256: stored.payload.sha256,
      artifactId: stored.eventId, sizeBytes: Buffer.from(stored.payload.contentBase64, "base64").length,
    } } : stored;
    const artifactSize = event.kind === "artifact" ? event.payload.sizeBytes : 0;
    if (artifactBytes + artifactSize > 25 * 1024 * 1024) break;
    artifactBytes += artifactSize;
    const size = Buffer.byteLength(JSON.stringify(event));
    if (bytes + size > PAGE_BYTES) break;
    events.push(event); bytes += size;
  }
  const nextSequence = events.at(-1)?.sequence ?? afterSequence;
  return { threadId, afterSequence, events, nextSequence, hasMore: nextSequence < journal.length };
}

async function readAsset(client, resource, expectedSize) {
  const signed = await client.rpc("assets.createUrl", { resource });
  if (typeof signed?.relativeUrl !== "string" || !signed.relativeUrl.startsWith("/api/assets/")
    || signed.relativeUrl.includes("\\") || signed.relativeUrl.length > 4096) throw new Error("Invalid local asset URL");
  const url = new URL(signed.relativeUrl, client.baseUrl);
  if (url.origin !== new URL(client.baseUrl).origin || !url.pathname.startsWith("/api/assets/")) {
    throw new Error("Invalid local asset origin");
  }
  const response = await client.fetchImpl(url.href, {
    redirect: "error", signal: AbortSignal.timeout(client.requestTimeoutMs),
  });
  if (!response.ok || !response.body) throw new Error("Thread artifact unavailable");
  const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 25 * 1024 * 1024 || (expectedSize !== undefined && size > expectedSize)) {
        throw new Error("Thread artifact exceeds bound");
      }
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  if (expectedSize !== undefined && size !== expectedSize) throw new Error("Thread artifact size changed");
  return Buffer.concat(chunks, size);
}

const sensitivePath = (name) => name.split(/[\\/]/).some((part) =>
  /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.git|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part)
  || /\.(?:pem|key|p12|pfx)$/i.test(part));

async function attachmentEvents(client, thread, previous) {
  const result = [];
  const existing = new Map(previous.map((event) => [event.eventId, event]));
  for (const message of thread.messages ?? []) {
    for (const attachment of message.attachments ?? []) {
      if (!["file", "image"].includes(attachment.type)) continue;
      if (sensitivePath(attachment.name ?? "")) continue;
      if (!safeText(attachment.id, 256) || !safeText(attachment.name, 255)
        || attachment.name === "." || attachment.name === ".." || /[/\\\x00]/.test(attachment.name)
        || !safeText(attachment.mimeType, 100) || !Number.isSafeInteger(attachment.sizeBytes)
        || attachment.sizeBytes < 0 || attachment.sizeBytes > 25 * 1024 * 1024) throw new Error("Invalid thread attachment");
      const eventId = `artifact:${hash(`${message.id}:${attachment.id}`)}`;
      if (existing.has(eventId)) { result.push(existing.get(eventId)); continue; }
      const content = await readAsset(client, { _tag: "attachment", attachmentId: attachment.id,
        fileName: attachment.name, mimeType: attachment.mimeType }, attachment.sizeBytes);
      result.push({ eventId, kind: "artifact",
        occurredAt: iso(message.createdAt), payload: { name: attachment.name, mediaType: attachment.mimeType,
          contentBase64: content.toString("base64"), sha256: hash(content) } });
    }
  }
  // T3 checkpoint summaries are the authoritative set of generated/changed
  // files. Resolve only those relative paths through T3's workspace-file gate;
  // never parse terminal text into paths or crawl the user's filesystem.
  const latest = new Map();
  for (const checkpoint of thread.checkpoints ?? []) {
    if (checkpoint.status !== "ready") continue;
    for (const file of checkpoint.files ?? []) latest.set(file.path, { file, checkpoint });
  }
  for (const [relativePath, { file, checkpoint }] of latest) {
    if (file.kind === "deleted" || file.kind === "delete" || sensitivePath(relativePath ?? "")) continue;
    if (!safeText(relativePath, 1024) || path.isAbsolute(relativePath)
      || relativePath.includes("\\") || relativePath.split("/").includes("..")) throw new Error("Invalid checkpoint path");
    const eventId = `file:${hash(`${relativePath}:${checkpoint.checkpointRef}`)}`;
    if (existing.has(eventId)) { result.push(existing.get(eventId)); continue; }
    const content = await readAsset(client, { _tag: "workspace-file", threadId: thread.id, path: relativePath });
    const digest = hash(content);
    result.push({ eventId, kind: "artifact",
      occurredAt: iso(checkpoint.completedAt), payload: { name: path.posix.basename(relativePath),
        mediaType: "application/octet-stream", contentBase64: content.toString("base64"), sha256: digest } });
  }
  return result;
}

export function threadArtifact(params, { directory = DEFAULT_THREAD_EVENTS_DIRECTORY } = {}) {
  if (!record(params) || Object.keys(params).some((key) => !["threadId", "eventId", "offset", "limit"].includes(key))) {
    throw new Error("Invalid thread-artifact params");
  }
  const { threadId, eventId, offset = 0, limit = 393216 } = params;
  if (!UUID.test(threadId) || !safeText(eventId, 200) || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 393216) throw new Error("Invalid artifact range");
  privateDirectory(directory);
  const journal = readJournal(path.join(directory, `${threadId}.json`));
  const event = journal.find((entry) => entry.eventId === eventId && entry.kind === "artifact");
  if (!event) throw new Error("Artifact not journaled for this thread");
  const content = Buffer.from(event.payload.contentBase64, "base64");
  if (offset > content.length || hash(content) !== event.payload.sha256) throw new Error("Invalid artifact content");
  const chunk = content.subarray(offset, offset + limit);
  return { threadId, eventId, offset, totalBytes: content.length,
    contentBase64: chunk.toString("base64"), sha256: event.payload.sha256,
    nextOffset: offset + chunk.length };
}
