# Thread journal reads (KRA-6218 E8)

Status: implemented, synthetic proof; requires coordinated Sphere allowlist and
Jack importer releases. This change does not restart or deploy a live pairer.

`LoopbackRuntimeAdapter` adds `thread-events` and `thread-artifact` to the existing
outbound paired RPC. Cloud VM callers use the same adapter and journal. T3 keeps
provider authentication; no provider credentials enter the event contract.

## Source and durability

The exporter uses `T3Client.thread(threadId)`, which returns a full thread when
no window is requested. Windowed/incomplete responses fail closed. It projects
completed user/assistant messages, compact tool/terminal summaries, current
state, and explicit user memory candidates from every source-message line. Assistant streaming messages
wait until immutable. Memory candidates carry their source message ID; Jack
must validate candidates against the complete original user text (including
fences, quotes and negations), quarantine refused candidates without blocking
the journal cursor, and resolve face/team custody from the bound Talk. Source
`scope` is a compatibility hint, never memory-write authority.

Artifacts have actual producers: message `attachments` and changed/generated
files in ready T3 checkpoint summaries. Bytes come through T3 `assets.createUrl`
(`attachment` or thread-bound `workspace-file`) and its signed loopback asset
route. Paths come only from checkpoint metadata. No filesystem crawl, terminal
path scraping, absolute paths, parent traversal or credential file export.
Deleted checkpoint files have no bytes to export. Checkpoint files are captured
as observed at first synchronization; this is not historical Git reconstruction.

The per-thread journal is private (0700 directory, 0600 file), bounded to 128 MiB,
and atomically replaced after fsync. Existing owner/PID locks serialize writers
and recover dead processes; live contention returns unavailable for retry.
Source IDs are immutable; source content drift fails closed. Reconnects replay
identical event IDs and sequences. A cursor ahead of the journal is refused;
the journal is never silently reset. The default location is the existing
Tentacles state directory's `thread-events` subdirectory. VM callers may pass
`threadEventsDirectory` to a seat-private durable directory.

## Wire

Message event IDs are exactly `message:<T3 message.id>`. Their payload also
includes the exact `messageId` and `turnId` when T3 provides one. No command ID
is inferred. Jack must register its dispatched user/assistant origin IDs before
draining events so policy envelopes and already-finalized replies are not
projected again. Text or timestamp equality is never an origin match.

- `thread-events` params: `{threadId, afterSequence: 0, limit: 100}`; limit 1–200.
- Page: `{threadId, afterSequence, events, nextSequence, hasMore}`.
- Event: `{threadId,eventId,sequence,occurredAt,kind,payload}`; sequences start at
  one and are contiguous. Kinds: `message`, `tool_summary`, `artifact`, `state`,
  `memory`, `turn_end`. No raw tool input/output is projected.
- Artifact manifest payload: `{name,mediaType,artifactId,sizeBytes,sha256}`.
- Turn end payload (`turn_end`, KRA-8958): `{turnId,outcome}` plus `code` and
  `message` from the [failure-code table](orchestration.md#typed-failure-codes-kra-8958)
  when `outcome` is `failed` or `cancelled`. Outcomes: `succeeded`, `failed`,
  `cancelled`, `unknown`.
- `thread-artifact` params: `{threadId,eventId,offset:0,limit:393216}`.
- Chunk: `{threadId,eventId,offset,nextOffset,totalBytes,sha256,contentBase64}`.

## Sequence contract (KRA-8958)

`sequence` is per thread, starts at 1, increases by exactly one per journaled
event and is never reused or renumbered. The exporter assigns it inside the
per-thread lock and refuses to read or serve a journal whose stored sequences
are not exactly `1..n` (`Invalid thread journal sequence`), so a served page
never skips a number. A page from cursor `afterSequence` holds
`afterSequence+1 .. nextSequence` with no holes. A reader detects loss with
`findSequenceGap(page)` from `src/thread-events.mjs`: it returns the first
missing sequence (a dropped, reordered or truncated page, or a `nextSequence`
that does not match the last event), or `null`. On a gap, refetch from the
last committed cursor; never advance past it.

Each turn ends with exactly one `turn_end` event, ID `turn:<turnId>`. The
exporter journals the first end it sees for a turn and drops every later
observation of that turn, so a terminal event is never duplicated or
rewritten. Sources, newest first:

- T3 `latestTurn` in a terminal state (`completed` → `succeeded`, `error` or
  `failed` → `failed`, `interrupted` or `cancelled` → `cancelled`), at
  `completedAt`. Failure codes come from the session's `lastError`.
- Without `latestTurn`: the newest turn with a final assistant message, once
  the session is `ready`/`idle`/`stopped` (`succeeded`), `error` (`failed`) or
  `interrupted` (`cancelled`).
- An older turn with a final assistant message whose own end was never
  observed as latest: `unknown`, at its last assistant message time.

A live turn (the session's `activeTurnId`, or the newest turn of a running
session without one) never gets an end. Sequence is journal order, not causal
order: an older turn's end can follow events of the next turn.

How far back the guarantee goes: contiguous sequences hold for every journal
entry, because the exporter has always assigned `length + 1` and validated it
on read. `turn_end` exists only from this release. Turns that ended before an
upgraded exporter first polls the thread get an end only if they have a final
assistant message, and then with outcome `unknown` unless the turn is still
T3's `latestTurn`. Turns without a `turnId` on their assistant messages, and
earlier turns that produced no assistant message, have no `turn_end`.
Consumers must ignore unknown kinds; an importer that rejects them must be
updated before it reads a journal written by this release.

A chunk is at most 384 KiB before base64; pages are below 750,000 bytes and carry
at most 25 MiB aggregate artifact content. Individual artifacts are bounded to
25 MiB. Both fit the existing relay's 1 MiB frame limit. Jack validates identity,
offsets, content hash and exact page cursor before committing an import.

## Release coordination

Deploy the additive Sphere method allowlist first, then this pairer/cloud image,
then enable Jack synchronization. The old four-method host bind remains valid
in Sphere. The new pairer advertises both optional methods. Do not enable a Jack
importer against an old pairer and interpret unavailable as an empty journal.

Validation: `npm test` (236 passed, 1 skipped), `npm run check`, and
`git diff --check`; all synthetic, isolated fixtures. Live T3/VM and reconnect
proof remains a release acceptance step.
