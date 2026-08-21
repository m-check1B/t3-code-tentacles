# Orchestration control plane

The bridge can act as the top orchestrator of a T3 Code environment, not just a
provider adapter. This document describes the read (`observe`) and write
(`act` / `orchestrate`) surfaces any system — Hermes, a cron job, another agent
— can drive over the bridge's existing loopback-authenticated HTTP/RPC client.

## Read: observe

```bash
t3-agent-bridge observe
```

Returns one JSON document:

- `projects`, `threads` — the active shell snapshot (threads carry
  `hasPendingApprovals`, `hasPendingUserInput`, `session`, `modelSelection`,
  lifecycle flags).
- `archivedThreads` — the archived shell snapshot (WebSocket RPC
  `orchestration.getArchivedShellSnapshot`).
- `pendingWork` — compact index of threads that need an approval or user-input
  decision.
- `activeTurns` — threads whose session is `starting`/`running`/`ready`/
  `interrupted`, with active turn id, provider, instance, and runtime mode.
- `counts` — totals for a quick triage.

Thread detail (messages, activities, checkpoints, pending approval `requestId`)
is available on demand via `t3-agent-bridge` client code (`client.thread` /
`client.threadDetail(threadId, { turnLimit, beforeCursor })`); the CLI exposes
it through the bridge library, not a standalone verb.

## Write: act / orchestrate

Each command carries an immutable `commandId` (for idempotent retry) and is
projected back with the same exact-ID wait used by `originate`.

```bash
t3-agent-bridge act --intent '{"action":"thread.continue","threadId":"...","text":"go"}'
t3-agent-bridge act --intent-file intent.json
t3-agent-bridge orchestrate --intent-file intents.json          # array of intents, in order
t3-agent-bridge orchestrate --intent-file plan.json --no-wait   # fire-and-forget
```

An intent file is a JSON array of intents, or `{"intents": [...]}`.

### Intent vocabulary

| action | required fields | command |
|---|---|---|
| `project.create` | `title`, `workspaceRoot` (`instanceId`+`model` optional) | `project.create` |
| `project.rename` | `projectId`, `title` | `project.meta.update` |
| `project.set-model` | `projectId`, `instanceId`, `model` (`options` optional) | `project.meta.update` |
| `project.delete` | `projectId` | `project.delete` |
| `thread.create` | `projectId`, `title`, `instanceId`, `model` (`options` optional) | `thread.create` |
| `thread.continue` | `threadId`, `text` | `thread.turn.start` |
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
`full-access`; `decision` ∈ `accept`, `acceptForSession`, `decline`, `cancel`;
`interactionMode` ∈ `default`, `plan`. Optional `options` is
`[{ id, value }]` and rides on T3 `modelSelection` / `defaultModelSelection`.
Optional `budget` (`low`/`medium`/`high`) fills the lab effort knob when that
lab has a known id and no overlapping explicit option: `reasoningEffort` for
`codex` and `hermes` (`openai-codex:*` models), `effort` for `claudeAgent`.

## Orchestrator loop

A Hermes orchestrator runs a closed loop entirely through this surface:

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
