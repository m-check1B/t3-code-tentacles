# Architecture

```text
T3 Code UI
  │ native provider session (ACP over stdio)
  ├──▶ t3-hermes-acp ──exec──▶ hermes --profile <profile> acp
  └──▶ t3-pi-acp ──relay─────▶ pi --acp --provider <provider> --model <initial>

Hermes / automation
  │ tentacles originate, authenticated HTTP dispatch
  ▼
T3 orchestration API ──▶ visible project/thread/turn

Any non-Hermes T3 thread
  │ new user message containing @hermes, read-only polling
  ▼
tentacles watch ──▶ linked Hermes-backed T3 thread
```

The functional bridge changes neither upstream. It reuses the ACP contract
implemented by T3 Code's Grok-compatible driver, Hermes, and Pi, then uses T3
Code's local orchestration HTTP and WebSocket RPC surfaces for settings and
Hermes reverse dispatch.

Pi 0.1.x uses local authentication and an older ACP model/mode response shape.
The Pi relay answers T3's transport-level `authenticate` request locally,
normalizes those two state objects, filters discovery to the explicitly selected
Pi provider, and normalizes a successful model-switch response. All other ACP
traffic is forwarded. T3 remains authoritative for the visible model choice and
sends the bare model ID through `session/set_model`.

## Why the Grok adapter is used

T3's provider driver identifies the protocol adapter, not the model a harness
will run. The bridge installs instances with `driver: "grok"` because this T3
adapter supports a configurable binary and ACP over standard input/output. T3
invokes a configured wrapper as `t3-hermes-acp agent stdio` or
`t3-pi-acp agent stdio`. The Hermes wrapper executes
`hermes --profile <profile> acp`; the Pi wrapper relays to `pi --acp` and lets
T3 control Pi's visible model through `session/set_model`.

The Codex adapter is a different protocol boundary. It launches `codex
app-server` and implements Codex-specific authentication, model discovery,
thread lifecycle, approvals, and events. Pointing that adapter at Hermes would
not make Hermes compatible with it; the bridge would need to emulate the Codex
app-server protocol on top of ACP.

The Grok choice therefore provides the smallest source-independent protocol
match. It does not select Grok models or xAI routing. Model selection remains
inside Hermes for the Hermes integration; T3 controls the Pi integration's
visible model through ACP. The visible Grok icon in stock T3 Code is a cosmetic
consequence of reusing that driver. Stock T3 also injects its built-in
`grok-build` model into these instances; it is an adapter artifact, not a Pi
model. An optional UI-only T3 patch can brand the bridge's
stable `grok:hermes` driver + instance identity correctly without relying on the
editable display name or changing bridge behavior. The patch was submitted
upstream as [T3 Code #5732](https://github.com/pingdotgg/t3code/pull/5732), which
closed without merging; the reviewed patch remains available in our
[public patch repository](https://github.com/m-check1B/t3code-hermes-ui).
A neutral generic-ACP driver and provider-icon extension in upstream T3 would
remove this cosmetic coupling entirely.

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
- The bridge grants no new process permissions. Hermes and Pi retain the
  permissions and tools already configured for their selected local runtime.
- Pi credentials remain in Pi's local authentication store. T3 settings contain
  only non-secret executable, provider, initial model, and ownership metadata.

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
