# Orchestration control plane

Tentacles is the user-side of T3 Code: each lab is a tentacle. Hermes was the
first tentacle, not the product. T3 Code tentacles — originate any ready lab
(instance + model + budget).

This document describes the read (`observe`, `report`) and write (`act` /
`orchestrate`) surfaces any local automation — a cron job, another agent, or a
script — can drive over the bridge's existing loopback-authenticated HTTP/RPC
client. The public command is `tentacles`; `t3-agent-bridge` is an exact alias.

## Protocol support and runtime proof

Keep four facts separate:

1. **Tentacles version and commit.** The `0.5.0-jack.2` source line contains a
   V1/V2 adapter. A package version does not establish installed or running bytes.
2. **Negotiated protocol.** Selection reads the T3 environment descriptor;
   protocol 1 selects V1, protocol 2 selects V2, and an absent protocol field or
   a missing (404) descriptor selects V1. Unknown versions and other descriptor
   failures refuse. Tentacles 0.5 with protocol 1 is a supported pairing.
3. **Patched T3 extensions.** V2 turns require the atomic mode/message RPC
   below. Local Talk separately requires the patched `turn-result` endpoint:
   its result must correlate the exact accepted command, message and run and
   retain bounded output/restart-continuation semantics. Negotiating V2 does
   not prove either extension exists. Unpatched upstream T3 is not a supported
   substitute for these flows.
4. **Staged runtime evidence.** Record exact installed and running T3/Tentacles
   builds, negotiated protocol and extension proof, then verify originate,
   continue, report, observe, doctor and the relevant Talk/Guardian consumers
   per host under the authorized rollout gates. Source tests do not replace
   these checks or authorize installations or service actions.

The V2 T3 source of record is `m-check1B/t3code-hermes-private-archive`, branch
`jack/upstream-0.1.0`, with stage-1 source audited at `e027af1a`. The 24 October
2026 audit found all inspected live hosts using V1. The estate V2 cutover is
incomplete; existing host pins, staged deployment and rollback gates still apply.

The [canonical orchestration visual](orchestration-loop.svg) shows these
boundaries. V2 turns require the
`orchestration.dispatchMessageWithMode` extension: the requested runtime mode
and message are accepted together. An older V2 server rejects the method; there
is no fallback to an unguarded message. Retrying the same command/message IDs
returns the original receipt and does not reapply an earlier mode change.

Unsupported cases remain explicit: unknown protocol versions, V2 enum values,
command fields and nested shapes refuse; V2 `thread.checkpoint.revert` is not
supported. Optional fresh provider context requires its own advertised runtime
capability; the stage-1 patch does not advertise it. None of these cases permits
a silent fallback to another protocol, provider, model or unsafe dispatch.

## Read: observe

```bash
tentacles observe
```

Returns one JSON document:

- `projects`, `threads` — the active shell snapshot (threads carry
  `hasPendingApprovals`, `hasPendingUserInput`, `session`, `modelSelection`,
  lifecycle flags).
- `archivedThreads` — the archived shell snapshot (WebSocket RPC
  `orchestration.getArchivedShellSnapshot`).
- `pendingWork` — compact index of threads that need an approval or user-input
  decision.
- `activeTurns` — threads with a non-null session `activeTurnId`, or a session
  status of `starting`/`running`, with turn id, provider, instance, and runtime
  mode. Ready or interrupted status alone does not imply an active turn.
  V2's validated `preparing`/`queued`/`starting` and `running`/`waiting` statuses
  map to `starting` and `running`, respectively, and conservatively count even
  if the turn id is absent.
- `staleTurnThreadIds` — ids (never titles) of the `activeTurns` threads whose
  `lastActivity` is more than 6 h old (`STALE_TURN_MS`).
- `counts` — existing totals plus four session counters, restricted to active,
  non-deleted threads:
  - `activeTurns` — the length of `activeTurns`. This is the seat-cap number;
    stale turns stay in it.
  - `staleTurns` — the length of `staleTurnThreadIds`: in-progress turns, by the
    same rule as `activeTurns`, with no activity for over 6 h. They are listed
    so a stuck turn is visible; they are never dropped from `activeTurns` and
    never counted as ready. A turn with no activity stamp is not stale.
  - `readySessions` — V1 `ready` / V2 `idle` sessions with no active turn. A
    ready status with an explicit turn id counts in `activeTurns` only.
  - `interruptedSessions` — V1/V2 `interrupted` sessions. This can overlap
    `activeTurns` when an explicit active turn id is present.

  The V2 adapter retains validated `sourceStatus`
  internally because both idle and interrupted map to V1 stopped; observe's
  public session summary is unchanged. Unknown V2 statuses still refuse the
  observation. V1 summaries remain permissive; an explicit active turn id
  always counts, including with an unknown status.

Thread detail (messages, activities, checkpoints, pending approval `requestId`)
is available on demand via `t3-agent-bridge` client code (`client.thread` /
`client.threadDetail(threadId, { turnLimit, beforeCursor })`); the CLI exposes
it through the bridge library, not a standalone verb.

## Read: report

Parents checking one hire should not scrape `observe`. Use the compact
once-proof document:

```bash
tentacles report --thread THREAD_ID
```

`THREAD_ID` must be the full thread UUID. Short IDs shown in UI summaries are
display-only: unique, ambiguous, unknown and unauthorized prefixes all receive
the same actionable rejection before any thread lookup or enumeration. Use
the `threadId` from `tentacles originate`, or the full `threads[].id` from
`tentacles observe` within your existing authorized scope. A full UUID still
uses T3's existing per-thread authorization; a denied or missing thread does
not trigger a list lookup or prefix fallback. Library `report` and
`client.thread` use the same full-UUID requirement.

The HTTP equivalent is the existing per-thread read
`GET /api/orchestration/threads/:id`, mapped by `report(client, threadId)`.
That path never loads the shell snapshot, archived shell, or `observe`.

The document is `{ threadId, status, lastError, model }`. `status` is one of
`Done`, `generating`, `ready/idle`, `blocked`.

| Input | Result |
| --- | --- |
| `settledAt` present | `Done` |
| pending approvals or pending user input | `blocked` |
| session `starting` / `running` | `generating` |
| session `error`, or a non-empty string `lastError` while not generating | `blocked` |
| session `ready` / `idle` / `stopped`, without an error | `ready/idle` |
| missing/unknown session status (including `interrupted`), with no stronger evidence above | unproven |
| malformed non-string `lastError`, with no stronger evidence above | unproven |

The CLI and relay share this classifier. Unproven is an internal outcome, not
a fifth public status: the CLI exits unsuccessfully and the relay omits the
report. The CLI also rejects an empty projection or a response whose thread ID
does not match the requested ID. It never substitutes ready/idle for missing
evidence or falls back to the observe snapshot.

`lastError` is a presence marker, never provider text: it is
`"provider-error"` when the session is `error` or carries a non-empty/non-null
`lastError`, and `null` otherwise. Provider error payloads can contain prompt or
auth material, so the report never copies their strings or objects; read the
thread through its owner surface when details are needed. `model` is
`modelSelection.model` only when it is a printable ID of at most 80 characters
(`[A-Za-z0-9._:+-]`), otherwise `null`; the relay uses the same bound.
`observe` stays additive and unchanged.

## Write: act / orchestrate

Each command carries an immutable `commandId` (for idempotent retry) and is
projected back with the same exact-ID wait used by `originate`.
`project.create` waits on the shell project snapshot; `thread.create` waits on
thread projection. `thread.continue` and `thread.restart` wait until the exact
user message reaches a live session or produces an assistant response; a
projected user message followed by `session.status: error` fails with the
session's real `lastError`. When a `thread.continue` / `thread.restart` intent
omits every selection field (`instanceId`, `model`, `options`, `budget`), the thread's retained selection is validated
before anything (including a restart stop) dispatches: a missing known effort
knob is pinned on the same lab and model, an above-`high` or duplicate
retained effort fails closed, and an unprojected thread is refused. A continue
or restart that names only part of a selection (`budget`, `options`, or
`modelSelection` alone, or only one of `instanceId` / `model`) is refused before
anything dispatches; to change effort, pass `instanceId` and `model` together
with it. The same rule applies to the library `continueThread` and the pair
relay `continue`. Caller-supplied
`commandId` and `projectId` are preserved across verification polls so a
timeout/retry cannot create a second project.

```bash
tentacles act --intent '{"action":"thread.continue","threadId":"...","text":"go","runtimeMode":"full-access"}'
tentacles act --intent '{"action":"thread.restart","threadId":"...","text":"resume","runtimeMode":"full-access"}'
tentacles act --intent-file intent.json
tentacles orchestrate --intent-file intents.json          # array of intents, in order
tentacles orchestrate --intent-file plan.json --no-wait   # fire-and-forget
```

An intent file is a JSON array of intents, or `{"intents": [...]}`.

### Intent vocabulary

| action | required fields | command |
|---|---|---|
| `project.create` | `title`, `workspaceRoot` (`instanceId`+`model` optional) | `project.create` |
| `project.rename` | `projectId`, `title` | `project.meta.update` |
| `project.set-model` | `projectId`, `instanceId`, `model` (`options` optional) | `project.meta.update` |
| `project.delete` | `projectId` | `project.delete` |
| `thread.create` | `projectId`, `title`, `instanceId`, `model`, `runtimeMode` (`options` optional) | `thread.create` |
| `thread.continue` | `threadId`, `text`, `runtimeMode` | `thread.turn.start` |
| `thread.restart` | `threadId`, `text`, `runtimeMode` | ordered `thread.session.stop` + `thread.turn.start` |
| `thread.interrupt` | `threadId` | `thread.turn.interrupt` |
| `thread.stop` | `threadId` | `thread.session.stop` |
| `thread.approval.respond` | `threadId`, `requestId`, `decision` | `thread.approval.respond` |
| `thread.user-input.respond` | `threadId`, `requestId`, `answers` | `thread.user-input.respond` |
| `thread.checkpoint.revert` | `threadId`, `turnCount` | `thread.checkpoint.revert` |
| `thread.set-runtime-mode` | `threadId`, `runtimeMode` | `thread.runtime-mode.set` |
| `thread.set-model` | `threadId`, `instanceId`, `model` (`options` optional) | `thread.meta.update` |
| `thread.rename` | `threadId`, `title` | `thread.meta.update` |
| `thread.archive` / `unarchive` / `settle` / `unsettle` / `pin` / `unpin` / `delete` | `threadId` | matching command |
| `thread.snooze` | `threadId`, `snoozedUntil` (ISO) | `thread.snooze` |
| `thread.unsnooze` | `threadId` | `thread.unsnooze` |
| `thread.external-message` | `threadId`, `text` | `thread.external-message.append` |

Enums: `runtimeMode` ∈ `approval-required`, `auto-accept-edits`, `auto`,
`full-access`. Tentacles requires `"runtimeMode":"full-access"` on every
originate and every non-empty continue for every lab and effort
(including Codex xhigh/high); an omitted `runtimeMode` fails closed and is
never a compliant operation. The bridge does not substitute any default.
`decision` ∈ `accept`, `acceptForSession`, `decline`, `cancel`;
`interactionMode` ∈ `default`, `plan`. Optional `options` is
`[{ id, value }]` and rides on T3 `modelSelection` / `defaultModelSelection`.
Optional `budget` (`low`/`medium`/`high`) fills the lab effort knob when that
lab has a known id and no overlapping explicit option: `reasoningEffort` for
`codex` and `hermes` (`openai-codex:*` models), `effort` for `claudeAgent`.

`thread.continue` automatically performs the same ordered stop/start recovery
when the projected session is already `error`. Use `thread.restart` explicitly
when a provider transport is stale but T3 still projects the session as
`ready` or `running`; healthy running Grok sessions continue normally and are
not stopped by `thread.continue`.

## Orchestrator loop

A Tentacles orchestrator runs a closed loop entirely through this surface:

1. `observe` → read `pendingWork` + `activeTurns`.
2. Decide the next intent (approve, answer user input, continue, interrupt, set
   model, settle, …).
3. `act` / `orchestrate` the intent; the bridge returns dispatch evidence
   (`commandId`, projection result).
4. Repeat, or record evidence and go idle.

Deny-by-default and safety invariants from the rest of the bridge still apply:
loopback-only origins, bearer auth, bounded responses, and immutable command
IDs. The bridge grants no new process permissions; the intents it dispatches
are exactly the commands a T3 client is already allowed to send.
