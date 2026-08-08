# Architecture

```text
T3 Code UI
  │ native provider session (ACP over stdio)
  ▼
t3-hermes-acp wrapper ──exec──▶ hermes --profile <profile> acp

Hermes / automation
  │ t3-hermes originate, authenticated HTTP dispatch
  ▼
T3 orchestration API ──▶ visible project/thread/turn

Any non-Hermes T3 thread
  │ new user message containing @hermes, read-only polling
  ▼
t3-hermes watch ──▶ linked Hermes-backed T3 thread
```

The module changes neither upstream. It reuses the ACP contract already
implemented by T3 Code's Grok-compatible driver and Hermes, then uses T3 Code's
local orchestration HTTP and WebSocket RPC surfaces for settings and reverse
dispatch.

## Correlation and loop prevention

- A private, versioned, ownership-marked state file maps source thread IDs to
  linked Hermes thread IDs. Invalid, oversized, or unknown-version state fails
  closed; it is never reset as a deduplication recovery tactic.
- v0.1.0 state is upgraded before network dispatch with links, cursors, and
  replay guards preserved. Unresolved legacy pending deliveries require an
  explicit operator audit and are never discarded by migration.
- The first watcher pass records a start watermark and does not backfill
  historical mentions. Per-thread cursors include a timestamp; when a cursor
  was pruned, timestamp-less or equal/older messages are consumed without
  routing rather than replayed.
- Every routed mention receives a random correlation ID and `hop=1/1` marker.
- Only user messages from non-Hermes threads are considered.
- A durable per-thread message cursor is the primary replay guard; a bounded
  1,000-ID ledger covers cursor recovery and migrations.
- Routing intent and immutable command/message IDs are persisted before T3
  dispatch, allowing ambiguous accepted turns to reconcile without replay.
- An ownership-token interprocess lock prevents a background watcher and manual
  scan from routing concurrently. A stale lock is recovered only after its PID
  is provably absent; releases remove only their own lock identity.
- Hermes-backed target threads are excluded from mention scanning.
- Mention routing is deny-by-default. Callers must pass a policy explicitly
  authorising both source project IDs and provider instance IDs (or the explicit
  allow-all policy for a deliberately unconstrained local deployment).
- Source-thread excerpts are transferred as a bounded, role-labelled untrusted
  context window. The linked Hermes prompt treats that excerpt as reference
  material, never as authority.

## Security boundary

- T3 and Hermes origins must resolve to loopback hosts and may not include
  credentials, paths, queries, or fragments.
- HTTP redirects are rejected so the T3 bearer cannot cross origins.
- Token files must be non-symlink, owner-controlled regular files with mode
  `0600` and bounded content.
- HTTP responses and WebSocket frames are size-bounded and time-bounded.
- Provider install/remove requires an immutable bridge ownership marker and
  refuses redacted or foreign provider maps.
- The bridge grants no new process permissions. Hermes retains only the
  permissions and tools already configured for its selected profile.

## T3 command projection

T3 command dispatch is accepted asynchronously. The bridge waits for each exact
project, thread, and initial-message projection before sending the dependent
command. Pending correlation data is written before dispatch and reconciled by
immutable IDs if the final response is ambiguous. Per-intent retries are
bounded with backoff and dead-letter terminal failures, so a malformed or
unavailable source cannot block later healthy work. `originate` records the
same immutable IDs when given an idempotency key, including across an ambiguous
accepted response.

## Known semantic limit

T3 Code's current client command API cannot inject an assistant message into a
different provider's existing thread. Therefore `@hermes` creates or continues
a clearly labeled linked Hermes thread. The original provider may also see the
mention. True inline interception needs an upstream extension point and is
deliberately outside this source-independent release.
