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

- `thread-events` params: `{threadId, afterSequence: 0, limit: 100,
  includeTurnEnd: false}`; limit 1–200. `includeTurnEnd` must be a boolean.
  Only a reader that passes `includeTurnEnd: true` receives `turn_end` events
  (see [Turn-end opt-in](#turn-end-opt-in-kra-8958)). A pairer older than this
  release rejects the parameter as `Invalid thread-events params`, so an
  opted-in reader never mistakes an old pairer for a journal without ends.
- Page: `{threadId, afterSequence, events, nextSequence, hasMore}`.
- Event: `{threadId,eventId,sequence,occurredAt,kind,payload}`; sequences start at
  one and are contiguous. Kinds: `message`, `tool_summary`, `artifact`, `state`,
  `memory`, and `turn_end` for opted-in readers only. No raw tool input/output
  is projected.
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
that does not match the last event), or `null`. It throws `Invalid
thread-events cursor` for a cursor that is not a non-negative safe integer
below `Number.MAX_SAFE_INTEGER` (KRA-8998). On a gap, refetch from the last
committed cursor; never advance past it.

Each turn ends with exactly one `turn_end` event, ID `turn:<turnId>`. The
exporter journals the first end it sees for a turn and drops every later
observation of that turn, so a terminal event is never duplicated or
rewritten. The check runs inside the journal write, under the per-thread lock,
so a concurrent poller that saw the same turn differently (for example as an
older, `unknown` turn) drops its observation instead of failing. Sources,
newest first:

- T3 `latestTurn` in a terminal state (`completed` → `succeeded`, `error` or
  `failed` → `failed`, `interrupted` or `cancelled` → `cancelled`), at
  `completedAt`. Failure codes come from the session's `lastError`.
- Without `latestTurn`: the newest turn with a final assistant message, once
  the session is `ready`/`idle`/`stopped` (`succeeded`), `error` (`failed`) or
  `interrupted` (`cancelled`). A failure or cancel is attributed to that turn
  only if no user message is newer than the turn's last assistant message;
  otherwise the failure may belong to a turn that never replied, and no end is
  journaled.
- An older turn with a final assistant message whose own end was never
  observed as latest: `unknown`, at its last assistant message time. The
  newest message turn is not older when it is newer than `latestTurn`
  (whatever the session status): it gets no end until a later poll observes
  its real outcome (KRA-8998).

A live turn never gets an end. On a running session it is the session's
`activeTurnId`. Without one, it is the newest turn with an assistant message
when that turn is newer than `latestTurn` (whatever `latestTurn`'s state),
otherwise `latestTurn`, or the newest message turn when `latestTurn` is
missing. A terminal `latestTurn` that is older than the live turn still ends. Sequence is journal order, not causal
order: an older turn's end can follow events of the next turn.

How far back the guarantee goes: contiguous sequences hold for every journal
entry, because the exporter has always assigned `length + 1` and validated it
on read. `turn_end` exists only from this release. Turns that ended before an
upgraded exporter first polls the thread get an end only if they have a final
assistant message, and then with outcome `unknown` unless the turn is still
T3's `latestTurn`. Turns without a `turnId` on their assistant messages, and
earlier turns that produced no assistant message, have no `turn_end`.
### Turn-end opt-in (KRA-8958)

`turn_end` is opt-in through the `includeTurnEnd: true` request parameter.
Strict importers (Jack's `ThreadEventsPage` allows only the five base kinds and
forbids extra fields) keep working unchanged:

- Without the parameter, a page is the **base view**: the journal without
  `turn_end` events, renumbered `1..n` in journal order. A journal with no
  `turn_end` is its own base view, so cursors committed before this release
  stay valid, and a base reader's cursor advances past every skipped end with
  no gap. Page shape, cursor-ahead refusal and `hasMore` are as before, counted
  in the base view.
- With `includeTurnEnd: true`, a page is the full journal with its stored
  sequences.
- Cursors belong to one view. A reader that switches views must restart from
  `afterSequence: 0` (event IDs are stable, so it deduplicates by `eventId`)
  and never reuse a cursor across views. `findSequenceGap` works on either.

A chunk is at most 384 KiB before base64; pages are below 750,000 bytes and carry
at most 25 MiB aggregate artifact content. Individual artifacts are bounded to
25 MiB. Both fit the existing relay's 1 MiB frame limit. Jack validates identity,
offsets, content hash and exact page cursor before committing an import.

## Rollback (KRA-8998)

Do not downgrade the pairer past the KRA-8958 release once any `turn_end` has
been journaled. Older code has no base view: it serves `turn_end` events with
their stored sequences to every reader, and Jack's strict importer stalls on
validation. Before such a rollback, prune `turn_end` events from the journals
and renumber them `1..n`. No prune tool ships yet.

## Release coordination

Deploy the additive Sphere method allowlist first, then this pairer/cloud image,
then enable Jack synchronization. The old four-method host bind remains valid
in Sphere. The new pairer advertises both optional methods. Do not enable a Jack
importer against an old pairer and interpret unavailable as an empty journal.

Validation: `npm test` (236 passed, 1 skipped), `npm run check`, and
`git diff --check`; all synthetic, isolated fixtures. Live T3/VM and reconnect
proof remains a release acceptance step.
