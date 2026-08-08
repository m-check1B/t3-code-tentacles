# Changelog

All notable changes to this project are documented here.

## [0.1.1] - 2026-08-07

### Security

- Make mention routing deny-by-default and require an explicit project/provider
  authorization policy or the deliberate `--allow-all-projects` local policy.
- Treat source-thread history as bounded, role-labelled untrusted context rather
  than prompt authority.
- Fail closed on corrupt, oversized, unknown-version, or ownership-mismatched
  watcher state; bound every persisted collection.
- Redact HTTP/RPC error bodies and keep bearer values, tickets, prompts, and
  routed content out of service metadata and status.

### Reliability

- Add bounded retry/backoff and dead-letter handling so one malformed or
  unavailable source cannot starve healthy work.
- Make origination idempotent across ambiguous accepted responses.
- Migrate replay-safe v0.1.0 watcher state to v0.1.1 before dispatch; refuse
  legacy state with unresolved pending deliveries instead of dropping work.
- Harden crash recovery with ownership-token locks and a recovery barrier.
- Namespace macOS services by explicit profile and instance, snapshot an
  immutable runtime, verify activation, and roll back safely on failure.
- Add private structured service health/status and preserve recovery data on
  uninstall.

### Launch

- Add a public-safe social, profile, and YouTube launch kit.
- Add reproducible source for the 35-second launch film and its generated
  thumbnail; rendered media ships as release assets rather than npm contents.

## [0.1.0] - 2026-08-07

### Added

- Hermes as a native T3 Code provider through ACP.
- Hermes- or automation-originated visible T3 projects, threads, and turns.
- `@hermes` routing from any non-Hermes T3 thread into one linked Hermes thread.
- Reversible per-user macOS watcher service.
- Ownership-safe command, skill, provider, and LaunchAgent installation/removal.
- Durable cursors, bounded fallback deduplication, pending-intent reconciliation,
  and an interprocess routing lock.
- Ownership-safe provider install and removal.
- Loopback-only authenticated transport, redirect rejection, strict token-file
  validation, timeouts, and response/frame size limits.
- Compatibility documentation, architecture, demo recipe, and contribution and
  security policies.

[0.1.0]: https://github.com/m-check1B/t3-hermes-bridge/releases/tag/v0.1.0
[0.1.1]: https://github.com/m-check1B/t3-hermes-bridge/releases/tag/v0.1.1
