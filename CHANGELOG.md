# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added — KRA-6945

Release dependency: the signer fields are inert until Agent Jack wires the
connector and verifies the device proof through its authority. At Jack master
`d75df6428aa9e31258ea7764ee3ce54d1020b37d`, enrollment uses the seven-line C1
message, but the desktop connector's `sign.request` consumer is not merged.
The old five-field pipe-separated proof and origin-only `wss://host[:port]`
verifier are also absent; this PR retains the later seven-line C1 contract.
No live Mac reconnect or latency proof is claimed.

- `tentacles connect (--signer-fd FD | --host-port) --relay wss://…` speaks the
  device relay from KRA-6945 contract v1 (C4/C5) with amendments A1 and A2.
  Tentacles owns the one device WebSocket. The connector owns the key: Tentacles
  sends `sign.request` with only `purpose`, `audience`, `nonce` and `issuedAt`,
  and the connector builds the exact 7-line C1 message itself. Key flags and key
  material in a signer reply are refused.
- The hello audience must name the dialed relay, or nothing is signed.
- `device.auth` advertises `labs`, `turns` and the connector's `mac` methods from
  `host.hello`. `mac` RPCs are forwarded to the connector as `host.rpc`.
  `interrupt` is not advertised on this 0.4.1 line.
- Unknown relay frames are ignored. `ping` echoes `seq`. 45 s without an inbound
  frame reconnects.
- Close codes follow C4: 4401 and 4403 tell the connector `device.closed` and
  exit 0; 4402 and 4404 retry hourly (4404 at once on `host.signed-in`); 4100
  waits 60 s ± 20 %; everything else backs off 1 → 60 s with jitter.
- `doctor-status` answers from a cached report and logs sub-step timings.
  A relay ping no longer starts `refreshModels()`. A cold cache waits up to
  2.5 s for the first warm.
- A9 (KRA-6931): while a relay is paired or bound, Tentacles refreshes the
  doctor itself every 30 s ± 20 %, one refresh at a time, so `doctor-status`
  stays a cache read (< 500 ms) after any idle. A report older than 60 s is never
  served. A cold or stale miss is `computer.warming` on the device path; the
  legacy pair path keeps `computer.unavailable`, which production Jack reads.
- `connect --host-port` exits when the connector stops and drops its
  `parentPort` listeners. An RPC whose deadline has passed is refused without
  running. `device.superseded` keeps the 60 s wait whatever close code follows.
  A `sign.result` with fields beyond A1 is refused.
### Fixed

- Port release publishing to the private GitHub canonical repository, verify
  checksums and existing tags, and take release notes from CHANGELOG (KRA-8749).
  The updater rejects other release sources; live signing holds until the
  GitHub B3 provenance port lands.


### Added

- GitHub B3 release provenance pins the reviewer account, exact merged head,
  unedited post-push-bound receipt and distinct writer/reviewer thread ids
  (KRA-8371). Thread attestations are weaker than independent accounts; first
  real signing remains Founder-gated.

- A failed `turn-result` carries `failureDetail`, the redacted first line of
  T3's `session.lastError`, so Jack can name a plan limit or sign-in failure.
- Signed self-update for standalone Tentacles (KRA-8371, KRA-8367 A3), shipped
  fail-closed until GUARDIAN-audited keys are pinned: signed manifest with
  replay and expiry limits, safe user-space install under `~/.tentacles`,
  hold, crash guard, health-checked rollback, Undo, path-free events in
  `doctor-status`, and the no-AI signer `scripts/release/sign-manifest.mjs`.
  The 0.4.1 legacy RPC list is unchanged. See `docs/self-update.md`.

## [0.4.1-jack.1] - 2026-10-12

Jack maintenance build of 0.4.1 for the Founder's Mac Pro (KRA-6915).

### Fixed

- Doctor reports a signed-in Claude Code (claudeAgent) as ready instead of
  `assistant_unverified` ("update required") — backport of #39 (#43).
- A bare `pair.unpaired` is a transient conflict, not a denial (KRA-6929, #45).
- Pairing forwards the fresh-context Talk contract to Jack (#44).
- The release workflow accepts `vX.Y.Z-jack.N` maintenance tags.

## [0.4.1] - 2026-10-04

### Fixed — KRA-6432

- Stop/archive verifies provider session termination and uses supported T3 session
  stop commands when needed. Doctor reports archived session leaks.
- Support the `thread.session.stop` intent alias and list valid actions in help.
- Resolve the shim's Node from an owner-recorded absolute path before known
  macOS locations and PATH, with a clear missing-runtime error.
- Emit explicit accepted/rejected command receipts for `--no-wait`.
- Recover operator-rotated bearer files once on 401; report invalid authentication
  in doctor and provide explicit supported T3 reauthentication without printing
  credentials. Mini installation and reauthentication remain held.
- Publish release packages and checksums to the canonical Forgejo, rather than
  invoking GitHub release tooling from Forgejo CI.

### Designed

- Provenance, idle reporting, typed inbox and ephemeral thread lifecycle remain
  design notes only; no recurring automation was added.


### Added

- `tentacles doctor --json --models full` returns complete validated model IDs
  plus safe display names and T3 thinking/speed option descriptors. Existing
  doctor output remains bounded to 16 IDs per lab.

- Distinguish T3's standalone Codex CLI instance (`codex`) from a separately
  selectable app-bundled runtime (`codex-app`). The latter is an ownership-safe
  second instance of T3's native `codex` driver, not a Tentacles protocol
  wrapper. Doctor exposes both identities and originate preserves the selected
  instance and normal Codex reasoning budget mapping.
- `tentacles report --thread` returns a compact parent-check document
  (`Done` | `generating` | `ready/idle` | `blocked`, plus a `lastError`
  presence marker and a bounded `model` label) from one per-thread HTTP read.
  Provider error text or objects are never copied into it. `observe` stays
  additive.

### Fixed

- Doctor honors T3's live `isDefault` model marker before legacy lab defaults.
  Paired `doctor-status` reads the full catalog afresh and pairing heartbeats
  refresh it in the background without changing the v1 relay wire surface.

- Prefer an explicit boolean provider-instance enablement over stale legacy
  doctor settings, including OpenCode. Malformed flags and an upstream disabled
  status still fail closed; absent providers remain absent.
- Share the CLI and relay thread-report status classifier. Missing or unknown
  status evidence is unproven: the CLI fails and the relay omits the report.
  The CLI also rejects empty or mismatched thread projections.
- Codex app install/remove manage only the `codex-app` instance ID. Canonical
  and native IDs (for example `codex`, even when it exists only as legacy
  settings) are refused before any settings read or write.
- Reject repeated model-option IDs (for example `reasoningEffort=high` then
  `xhigh`, or contradictory Cursor `fastMode`) instead of validating only the
  first match.
- Run the CLI correctly when a clone is reached through a symlinked parent
  path, including the standard macOS `/tmp` alias.
- Grok cached-auth launcher forwards T3's launch arguments (including the
  permission mode) instead of always starting `agent stdio`. Only an allowlist
  of known `agent stdio` / `--permission-mode` argument shapes is accepted;
  anything else fails before the Grok binary starts. The launcher also runs
  when reached through a symlinked path. Grok no longer inherits Kimi's
  configured-model gate from the shared proxy (`configuredModel: null`), so
  T3's selected Grok model is not rewritten. Covered by synthetic proxy tests
  only; this is not a live provider acceptance claim.
- Cursor `composer-2.5-fast` resolves to T3's parameterized base model
  `composer-2.5` with the `fastMode: true` option. A contradictory explicit
  `fastMode` option is rejected rather than silently overridden.
- Partial continue selections fail closed. The CLI library, relay, and `act`
  `thread.continue` / `thread.restart` accept either every selection field
  omitted (retained seat) or both `instanceId` and `model`. `budget` or
  `options` alone (including empty, `null`, duplicate, or above-`high`
  values), or only one of `instanceId` / `model`, is refused before any
  dispatch, including a restart stop. Previously the library and relay
  silently switched such a continue to the Hermes default lab, and `act`
  silently dropped the fields.

### Changed

- Model selection pins known effort knobs to `high` by default, or `medium`
  for Opus/Astra, while retaining explicit `low`/`medium`/`high` selections.
  Grok uses `reasoningEffort`; values above `high` are rejected by the resolver.
  An all-omitted continue (CLI library, relay, and `act` `thread.continue` /
  `thread.restart`) keeps the thread's retained lab and model but validates
  its effort: a missing known knob is pinned, an above-`high` or ambiguous
  retained effort fails before dispatch, and a thread without a projected
  selection is refused. Valid retained seats still dispatch without a
  selection, and replays of an already-projected message dispatch nothing.

### Documentation

- Add the agent user manual and truth-sync the landed Hermes runtime identity
  gate without claiming an answering-assistant proof.

## [0.4.0] - 2026-08-31

### Documentation

- README names T3-native labs and Tentacles-additive labs by their CLIs.
  The paper-ink poster, ASCII, and mermaid match: native Codex CLI,
  Claude Code CLI, Grok Code CLI, OpenCode CLI, Cursor CLI, t3 pair;
  additive Kimi CLI / DeepSeek CLI / Hermes / Pi CLI. Hermes is Hermes.
  Claude Code is T3-native `--instance claudeAgent` and is not proved.

### Public identity

- Publish the product as **Tentacles** in the `t3-code-tentacles` repository.
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
- README separates advertised labs from a fresh, source-bound nine-lab e2e
  receipt. Install docs lead with a ready native lab and keep adapter
  credentials in owner-controlled runtime custody.

### Security and reliability

- Hermes ACP fails closed when T3 requests `openai-codex` and Codex
  credentials are missing. The named error is `codex_auth_missing`. The
  adapter no longer lets Hermes fall open to another provider (including
  DeepSeek) while the turn still looks like Codex. `tentacles doctor`
  prints that fail-closed state without secrets.
- Require explicit full-access runtime mode for originate and non-empty
  continue operations across every advertised lab.
- Add source-bound, ready-only two-turn e2e receipts with runtime immutability
  attestations and fail-closed skips for unverified assistants.
- Add the owner-controlled outbound pairing protocol without exposing the
  loopback T3 service or persisting pair secrets.

### Chair operation

- Add the copyable Operate Tentacles skill and provider-neutral chair workflow.
- Document the public Grok Bot chair example while keeping chairs distinct
  from T3-native and Tentacles-additive labs.

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

[Unreleased]: https://github.com/m-check1B/t3-code-tentacles/compare/v0.4.0...HEAD
[0.1.0]: https://github.com/m-check1B/t3-code-tentacles/releases/tag/v0.1.0
[0.1.1]: https://github.com/m-check1B/t3-code-tentacles/releases/tag/v0.1.1
[0.2.0]: https://github.com/m-check1B/t3-code-tentacles/releases/tag/v0.2.0
[0.2.1]: https://github.com/m-check1B/t3-code-tentacles/releases/tag/v0.2.1
[0.3.0]: https://github.com/m-check1B/t3-code-tentacles/releases/tag/v0.3.0
[0.4.0]: https://github.com/m-check1B/t3-code-tentacles/releases/tag/v0.4.0
