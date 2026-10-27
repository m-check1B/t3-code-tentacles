# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- `observe` reports `counts.staleTurns` and `staleTurnThreadIds` (ids only):
  in-progress turns with no activity for over 6 h (KRA-8952). They stay in
  `activeTurns`, so the seat cap is unchanged.
- Typed failure codes (KRA-8958): a blocked `report` or seats report, a failed
  or cancelled `turn-result` and a failed `act`/`orchestrate` receipt add a
  stable `code` (`session_busy`, `lab_not_ready`, `timeout`, `cancelled`,
  `provider_error`, `usage_limit`, `approval_required`) and a static, redacted
  `message`. Existing fields are unchanged.
- `thread-events` journals exactly one `turn_end` event per turn and exports
  `findSequenceGap` so a resuming reader detects a missing sequence
  (KRA-8958). Readers receive `turn_end` only with `includeTurnEnd: true`;
  without it, pages keep the base kinds and contiguous base-view sequences,
  so strict importers such as Jack's are unaffected.

### Fixed

- `doctor` names the missing app-bundle prerequisite before recommending
  `install-codex-app-provider` for an unstartable codex-app binary (KRA-7727).
  The action also names `--codex-app-bin` for a nonstandard app location.
- `thread-events` no longer journals a message turn that is newer than T3's
  `latestTurn` as `unknown` when the session is not running (KRA-8998); first
  write wins, so that outcome was permanent. Its real end is journaled on a
  later poll. `findSequenceGap` now throws on a cursor that is not a
  non-negative safe integer.
- `observe` no longer counts a ready/idle session with an explicit active turn
  id in `readySessions`; it counts only in `activeTurns` (KRA-8952).
- `doctor` no longer reports a lab `provider_error` with the generic action
  while Hermes health is ok (KRA-8860). T3's provider message is classified,
  never echoed. T3's probe-timeout messages for Claude, Codex (codex,
  codex-noweb, codex-app), OpenCode (version check and `opencode serve`
  start), Cursor (`agent about`), Grok, DeepSeek and Antigravity's health
  check (the strings in T3 `t3code-tplus-private`
  main @ 5a738105, kept verbatim in `test/fixtures/t3-probe-timeouts.json`)
  are `provider_probe_timeout` and name the command to run, the lab's install
  command, or where to refresh it in T3. An unstartable binary is
  `provider_binary_unavailable`. Any other Hermes adapter error while Hermes
  answers is `hermes_adapter_error` (health ok) or `hermes_degraded` (any
  other health word), and an enabled Hermes that T3 calls not ready while
  Hermes answers is `hermes_adapter_not_ready` (health ok) or
  `hermes_degraded`, each with one fix. A duplicate Hermes id stays
  `provider_not_ready`. deepseek and deepseek-noweb are no longer reported
  ready over a T3 `status=error`, and `runtime_misconfigured` on a noweb lab
  names that lab and its T3 driver. A lab switched off on the host reports
  `status=disabled code=disabled` over every other finding: a stale T3 error,
  Hermes health, Hermes or adapter auth, and runtime misconfiguration. An
  unavailable default model names the `T3_*_MODEL` override to change (and
  codex-app's `T3_CODEX_MODEL` fallback).

### Rollback

- Do not downgrade the pairer past the KRA-8958 release after any `turn_end`
  has been journaled: older code serves `turn_end` with stored sequences, and
  Jack's importer stalls on validation. Prune `turn_end` from the journals
  first; this release ships no prune tool (KRA-8998).

## [0.5.0-jack.2] - 2026-10-24

### Fixed

- Codex plugin inventory quarantines relative executable paths and bare command
  names before spawning (KRA-6203, R8): settings do not prove T3's cwd or PATH.
  Absolute executable paths remain supported and identify separate cache entries.
- Codex plugin inventory accounts for the selected instance's launch-argument
  environment override and cache identity (KRA-6203). Unverified overrides and
  relative/tilde homes start no child; absolute homes use T3-equivalent path
  resolution without trimming significant path bytes.
- Doctor skill/plugin metadata shares capability secret-shape rejection before
  hashing (KRA-6203). Codex plugin probes require a verified, enabled Codex
  driver and one complete explicit or legacy configuration. All optional
  inventories share a 128 KiB UTF-8 budget and the room left by core doctor
  diagnostics; omitted entries retain truthful counts/digests and truncation,
  and an oversized relay fallback marks inventories unavailable with null.

- Isolate model-selection, bridge-hardening and doctor golden test defaults from ambient model variables without weakening assertions or changing auth rotation coverage (KRA-8794).
- Report rejects short thread IDs before lookup with guidance to obtain the
  full UUID from originate or observe (KRA-7728). Unique, ambiguous, unknown
  and unauthorized prefixes are display-only; full UUIDs retain T3's
  per-thread authorization without enumeration or first-match selection.
- README and orchestration diagrams distinguish the Tentacles source version,
  negotiated V1/V2 protocol, required patched T3 extensions and staged runtime
  evidence (KRA-7187 G14). The corrected V2 source pointer and incomplete
  estate cutover are explicit; unsupported cases remain documented.
- Web-off twins require the exact observed provider driver to match both the
  expected twin driver and inspected settings (KRA-8722). Missing or conflicting
  identity reports unready with unknown web tools. Codex runtime diagnostics
  retain the observed driver instead of synthesizing it from settings.
- Publish checksummed tarballs to the private canonical GitHub repository using
  existing gh authentication, an existing matching tag and CHANGELOG notes
  (KRA-8749). Forgejo publishing is removed.
- Refresh stale enabled, installed provider snapshots during doctor, reread readiness, and rate-limit attempts across CLI invocations to one per instance/origin per 60 seconds (KRA-8833).
- Probe the Local Talk turn-result contract within the doctor deadline; report actionable `t3_not_patched` or unavailable findings without response bodies, and reuse the outcome in paired doctor-status (KRA-8838).
- Observe counts active turn IDs and starting/running work rather than idle
  ready or interrupted sessions (KRA-8227, 0.5.0-jack.2 candidate). Separate
  ready/interrupted session counters preserve both V1 and V2 classifications.
  CLI version tests read package metadata so release bumps remain testable.

### Added

- `doctor-status` adds a versioned, read-only `pluginInventory` block
  (KRA-6203): installed native Codex plugins (`pluginId`, `name`,
  `marketplace`, `version`, `enabled`) read with `codex plugin list --json`
  from the exact configured binary and `CODEX_HOME`; labs with launch
  arguments are not attributed. The listing can take seconds, so the
  long-running pairer refreshes it in the background (10 minute TTL) and
  doctor only serves a fresh cached observation; the CLI `doctor` never
  spawns it. Paths, sources and policies stay on the computer. Other labs
  report `no_native_plugin_source`.
- `doctor` (and paired `doctor-status`) adds a versioned, read-only
  `skillInventory` block (KRA-6203): per originate lab, the native skills T3
  already reports (`name`, `scope`, `enabled`), with `count`, `dropped`,
  `truncated` (512 cap) and an order-independent `digest`. Paths and
  descriptions never leave the computer. A lab without a reported skills list
  is `unavailable` with a null count, never zero. Additive: the pairing method
  list and Sphere contract are unchanged; older consumers ignore the field.

- Antigravity (Gemini) lab (KRA-6725): doctor advertises T3's native
  `antigravity` instance as "Antigravity (Gemini)". T3 owns the ACP agent
  download and the Google sign-in; Tentacles never handles Google credentials.
  The row adds `signedIn` and a fixed `setupUrl`
  (`t3code://app/settings/providers?instanceId=antigravity`). Its codes name
  the fix: `t3_update_required`, `disabled`, `not_installed`,
  `sign_in_unchecked` (installed, no models before the first session) and
  `not_signed_in`. Unknown sign-in or readiness stays not ready, even when
  cached models exist. Source-only refresh; installed/runtime compatibility
  remains separately verified.

- Capability-gated fresh native context and fixed-title Talk forwarding across
  legacy T3 and Orchestrator V2, with exact applied-generation receipts and
  origination replay validation (KRA-6411, KRA-7684). Missing or zero runtime
  capability preserves the default wire. This requires a supporting T3 build;
  no installed-runtime compatibility is implied.
- `tentacles capabilities scan [--json]` (KRA-7369): which vendor CLIs, MCP
  servers, plugins and skills this computer has, signed in or not, with the one
  fix when missing. Probes are time-boxed, shell-free and never start a login;
  lab configs are read for names only and a redaction gate checks the result.
  A running `tentacles pair` refreshes it every 5 minutes and sends it to Jack
  inside `doctor-status` as `capabilityInventory`. See
  [docs/capability-awareness.md](docs/capability-awareness.md).

## [0.4.2] - 2026-10-08

### Fixed

- Doctor reports Claude Code (`claudeAgent`) ready when T3 reports it ready and
  signed in, instead of always `unverified` (KRA-6508). A signed-out account is
  `auth_required` with a `claude auth login` action; a T3 without auth status
  stays fail-closed. Only T3's auth status word is read.
- Stop idempotency survives more than 256 requests (KRA-6578); Local Stop never
  dispatches after its relay budget (KRA-6575); Windows Stop kills the whole lab
  tree via System32 `taskkill` (KRA-6573).
- Pair-lock recovery admits exactly one live owner; a partial lock or dead
  recovery marker no longer wedges a computer (KRA-6572).
- One bad attachment no longer freezes a thread's journal (KRA-6577); frames
  after an RPC settles never crash the pairer (KRA-6576).
- Windows reads the DeepSeek OpenRouter token from `%LOCALAPPDATA%` (KRA-6574).

### Added

- Windows groundwork (KRA-6491, preview, not yet VM-proved): the state
  directory moves to `%LOCALAPPDATA%\t3-hermes-bridge`, executable lookup uses
  `PATHEXT` (`.exe`/`.cmd`/`.bat` only), private-file checks rely on the
  profile ACL instead of POSIX mode bits, a `taskkill /T /F` tree-kill plan is
  added, and there is a `bin\tentacles.cmd` entry point. See
  [docs/windows.md](docs/windows.md).
- Paired `interrupt` RPC (`turn-interrupt-v1`, KRA-6245): exact-receipt Stop
  for a paired Local Talk turn through T3 `thread.turn.interrupt`, serialized
  with `continue` per thread, idempotent by `requestId`, and acknowledged only
  after the exact turn is terminal. Doctor reports
  `capabilities.turnInterrupt`. Requires a Sphere that accepts the extended bind.
- CLI/App display names for providers in doctor (KRA-6506).

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
