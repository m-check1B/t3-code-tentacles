# Changelog

All notable changes to this project are documented here.

## [0.2.0] - 2026-08-11

### Added

- Add Pi Agent as a parallel T3 Code ACP harness with ownership-safe provider
  install/removal and T3-controlled model selection.
- Add a bounded compatibility relay for Pi 0.1.x local authentication and legacy
  ACP model/mode state without changing prompt, tool, approval, or stream traffic.
- Rename the project and npm package to provider-neutral `t3-agent-bridge`, add
  the matching primary command, and retain `t3-hermes` plus legacy state and
  ownership namespaces as compatibility surfaces.
- Add a tag-driven GitHub release workflow that verifies the version, runs the
  full suite, and publishes the package tarball with a SHA-256 checksum.

### Security and reliability

- Reject invalid mention-watcher work bounds before state or network activity.
- Bound and validate the loopback Hermes health response used by `doctor`.
- Filter Pi ACP model discovery to the explicitly configured Pi provider so T3
  cannot expose unrelated locally configured backends through the Pi instance.
- Document the one-time T3 provider-cache migration required only for Pi
  instances populated by the pre-v0.2 relay; T3 retains missing discovered
  models during an in-place refresh.

### Community

- Add contributor conduct and support policies, structured issue and pull
  request templates, code ownership, release-note categories, and monthly
  dependency update configuration.

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

[0.1.0]: https://github.com/m-check1B/t3-agent-bridge/releases/tag/v0.1.0
[0.1.1]: https://github.com/m-check1B/t3-agent-bridge/releases/tag/v0.1.1
[0.2.0]: https://github.com/m-check1B/t3-agent-bridge/releases/tag/v0.2.0
