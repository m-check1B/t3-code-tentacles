# Orchestration follow-ups (KRA-6432)

These are designs for items 5–8, not shipped CLI features. Keep T3 as the
conversation owner; Tentacles adapts supported commands and reads.

## Originator provenance

`originate` should record an immutable origin receipt keyed by threadId and
commandId: origin kind (human CLI or agent), an optional parent threadId, and
createdAt. A seat can read that receipt through a bounded local command. User,
TTY and parent-thread claims are descriptive metadata, never proof that the
Founder authorized credentials or privileged work. Authenticated delegation
requires a separate owner-issued grant; don't infer it from a terminal or name.
Do not persist prompts, credentials or environment dumps. Write atomically in an
owner-only ledger and deduplicate by the originate idempotency key.

## Idle and last activity

Add `report --idle 30m` or `status --json` using T3 shell timestamps and bounded
thread detail reads where needed. Return threadId, lastMessageAt, sessionStatus,
waitingOnHuman, and observedAt. Use explicit null for unavailable timestamps;
settled does not imply stopped, and a ready session does not imply human input
is needed. Avoid reading T3's database or retrieving whole histories. Test
pending approvals, pending user input, active turns, missing clocks and archived
threads. Parse durations with an explicit unit and bound the query.

## Seat-to-orchestrator inbox

Add an owner-local typed event ledger with eventId, threadId, type
(`approve`, `ready`, `block`), createdAt and a bounded non-secret summary.
`tentacles inbox --after CURSOR` reads events; explicit acknowledgement advances
an orchestrator's cursor. Delivery is at least once and consumers deduplicate
by eventId. Persist before acknowledging the sender; cap disk use and return a
named full-ledger failure rather than dropping approval requests. An `approve`
event requests approval; it grants no execution authority. Validate thread
identity and authenticate the local sender before accepting an event.

## Ephemeral/one-shot threads

`originate --ephemeral` should mark a thread in the owner-local ledger, observe
the exact first turn completion, stop its session, verify termination, and
archive it. A partial assistant delta, tool output, interrupt, or error is not
a completed first reply. Keep state across watcher restarts and reuse commandIds
for cleanup retries. Never delete conversation history. Timeout or unavailable
T3 leaves cleanup pending with an explicit event; it must not kill processes.
A one-shot cleanup worker is distinct from a recurring automation and requires
an explicit caller invocation. No new scheduled wakeup is part of this design.

## Acceptance and implementation order

Provenance and the inbox need durable owner-local state, bounded serialization,
replay and concurrency tests before release. Idle reporting can ship separately.
Ephemeral cleanup depends on verified stop/archive behavior and a reliable T3
turn-completion signal. Each follow-up gets its own development ticket and PR;
none is enabled by this design note.
