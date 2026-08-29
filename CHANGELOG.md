# Changelog

All notable changes to this project are documented here.

## [0.3.0] - 2026-08-28

### Public identity

- Publish the product as **Tentacles**. The GitHub repository is `tentacles`.
  The public command is `tentacles`; `t3-agent-bridge` remains an exact alias.
- `doctor` prints an advertised lab matrix (ready / installed / explicit) and
  no longer fails the whole command when Hermes health is down.
- Originate picks a per-lab default model. Cursor stays explicit and requires
  `--model`.
- Continue recovers an errored session via ordered stop/start (`thread.restart`
  and `thread.continue` on `session.status: error`).

### Documentation

- README install, doctor, and lab matrix match Tentacles. No secrets. GitHub
  clone URL is `https://github.com/m-check1B/t3-code-tentacles.git`.
- `tentacles doctor` prints a human-readable lab matrix for this machine;
  `--json` keeps the machine-readable document. Advertised is not proved.
- README separates advertised labs from e2e proof: Grok, Codex, OpenCode, and
  Cursor are proved; Claude, Kimi, DeepSeek (OpenRouter 401), Hermes Codex
  auth (`codex_auth_missing`, fail-closed), and Pi OAuth remain blocked.
  Install docs lead with a ready native lab.

### Security and reliability

- Hermes ACP fails closed when T3 requests `openai-codex` and Codex
  credentials are missing. The named error is `codex_auth_missing`. The
  adapter no longer lets Hermes fall open to another provider (including
  DeepSeek) while the turn still looks like Codex. `tentacles doctor`
  prints that fail-closed state without secrets.

## [0.2.1] - 2026-08-11

### Security and reliability

- Pin release Actions to reviewed full commit SHAs, disable checkout credential
  persistence and package-manager caching, and validate the tag/package version
  before repository code executes.
- Serialize release runs per tag and distinguish a missing GitHub release from
  authentication, network, or API failures before creating one.
- Protect `v*` tags with a repository ruleset that restricts creation, updates,
  and deletion to the repository owner.
- Cover provider-scoped fallback when Pi reports a current model owned by a
  different provider.

### Documentation

- Include the provider-scoped T3-to-Pi path in the four-flow launch description.

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
[0.2.1]: https://github.com/m-check1B/t3-agent-bridge/releases/tag/v0.2.1
[0.3.0]: https://github.com/m-check1B/t3-code-tentacles/releases/tag/v0.3.0
