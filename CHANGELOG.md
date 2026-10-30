# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Fixed

- `doctor`: when a Kimi, Pi or DeepSeek lab's installed model (`defaultSource` `installed`) is not advertised by T3, the action names that model and says to pass `--model` to `originate` or re-run the lab's installer with `--model`, instead of the generic env-variable hint. The shim comments now say it runs under `/bin/sh` (often dash on Linux) and that the Node probe costs one Node start per probed candidate. A `deepseek-noweb` lab now gets an installer action too (installed model not advertised, absent or binary unavailable), naming `tentacles install-deepseek-provider --instance deepseek-noweb`.

## [0.5.0-jack.8] - 2026-10-30

### Fixed

- KRA-6432: the `t3-agent-bridge` / `tentacles` shim now also finds Node.js in `$HOME/.local/node/bin/node` when no recorded path works, so a non-interactive ssh on hosts that keep Node there no longer exits 127. Every candidate (recorded path, fixed paths and PATH) must now be Node.js 22 or newer; an older one is skipped, and the shim still exits 127 when none qualifies. The probe reads stdin from `/dev/null` and must print the token `tentacles-node-ok`, so a non-Node that exits 0 is rejected; it runs in a subshell, so a signal-killed candidate leaks no job-status line on macOS `/bin/sh`. The probe runs on every invocation and adds about 25 ms to the shim's start.
- KRA-6909: `doctor` and `originate` without `--model` now use the installed Kimi and Pi model as the lab default: `T3_KIMI_MODEL` / `T3_PI_MODEL`, then the installed provider's non-sensitive `KIMI_MODEL` / `PI_MODEL`, then the built-in model, reported as `defaultSource` `env`, `installed` or `built-in`. `install-kimi-provider` and `install-pi-provider` always write that variable (the `--model` value or the default at install time), so an existing install reports `installed` and keeps its install-time model until it is reinstalled.

## [0.5.0-jack.7] - 2026-10-30

### Fixed

- KRA-9785: `doctor --json` lab rows carry `defaultSource` (`t3-marked`, `t3-declared`, `env`, `installed` or `built-in`), the branch that picked `defaultModel`. When T3 marks or declares a default that `originate` without `--model` would not pick, a ready row (and the text report, under Default model) carries an action: pass `--model` or make originate's pick the T3 default. Originate is unchanged.
- KRA-6909: `doctor` and `originate` without `--model` now share one DeepSeek default: `T3_DEEPSEEK_MODEL`, then the installed provider's non-sensitive `DEEPSEEK_MODEL` (written by `install-deepseek-provider --model`), then the built-in model. An installed non-default model reports ready and is the model originate selects, without a CLI override. T3's own marked default still wins in doctor only; originate does not read it yet. A DeepSeek harness installed at a non-deepseek lab id (for example `install-deepseek-provider --instance grok`) keeps that lab's built-in default in both doctor and originate, so doctor reports it `default_model_unavailable` instead of ready. Other labs are unchanged.

## [0.5.0-jack.6] - 2026-10-30

### Security

- 0.5.0-jack.1 to 0.5.0-jack.5 created Local Talk workspaces without the instruction guard, so a Local turn could load the owner's home `CLAUDE.md`, `AGENTS.md` or user memory. This release guards new workspaces on originate (KRA-7502) and existing ones on their next paired `continue` (KRA-9781).

### Fixed

- `scripts/publish-github-release.mjs` rejects a CHANGELOG section that is only its version heading (or a heading plus blank lines) with `Empty CHANGELOG.md entry for <version>`, instead of publishing a heading-only release note. A normal section is published unchanged.
- KRA-7502: a Local Talk workspace that 0.5.x creates through `ensureLocalTalkWorkspace` now gets the instruction guard before T3 `project.create`, so a first Local turn from a browser, phone or routine no longer loads the owner's home `CLAUDE.md`, `AGENTS.md` or user memory. `<workspace>/.claude/settings.local.json` (0700/0600, atomic, never through a symlink, other keys kept) lists every ancestor's `*` and `.claude/**` as `claudeMdExcludes` and sets `autoMemoryEnabled: false`. `src/talk-instruction-guard.mjs` is byte-identical to Agent Jack's desktop guard and the 0.4.1 maintenance line.
- KRA-9781: a paired `continue` now writes the same instruction guard into the thread's Local Talk workspace before T3 `thread.turn.start`, so a workspace that 0.5.0-jack.1..5 created without the guard is fixed on its next turn even on a host without the Jack desktop. The workspace is the thread's project `workspaceRoot`; a refused path or a symlinked `.claude` aborts the continue before T3. Hire and chair workspaces are untouched.
- KRA-9781 hardening from the PR 45 review: the continue guard fails closed. When the thread's working directory cannot be resolved (snapshot/shell read fails, no `projects` array, project missing, `workspaceRoot` not a string), the paired `continue` is refused before any T3 dispatch. A thread `worktreePath`, when set, is guarded instead of the project root, and an async workspace hook is awaited. Each paired continue that is not an idempotent replay now reads the orchestration snapshot (protocol 1) or shell (protocol 2), the same read originate already does; on an estate whose snapshot is over the 32 MiB cap or slower than 15 s every paired continue fails. Operator CLI `orchestrate` intents (`thread.continue`, `thread.restart`) are unchanged and do not run the guard.
- KRA-9781 follow-up from the PR 46 review: on protocol 2 the thread detail now carries `worktreePath` and `branch` (a non-empty string, else null), so a protocol 2 thread with a `worktreePath` is guarded at that worktree and not at its project root, as on protocol 1. V2 shell thread summaries carry the same two fields. An empty `worktreePath` on either protocol falls back to the project root, so the guard is still written.

## [0.5.0-jack.5] - 2026-10-29

### Changed

- On a T3 401 that a rotated token file does not explain, local CLI commands re-authenticate once through the colocated T3 CLI and retry the rejected request once (KRA-8199). The CLI is `TENTACLES_T3_BIN`, else `t3` on PATH, else the newest semver `<T3 home>/runtime/versions/*/t3` (`TENTACLES_T3_HOME`, default `~/.t3`), so the Pro's off-PATH runtime binary is found. A missing CLI, failed issuance or second 401 fails with the exact manual `tentacles reauth` command for the resolved paths. Opt out with `TENTACLES_T3_AUTO_REAUTH=0`; `--computer` targets keep the manual flow.
- KRA-8199 hardening from the PR 40 review: a T3 CLI found under the T3 home runs as the real path its confinement check approved, not a re-resolvable symlink; a second 401 after an operator token-file rotation says the replaced bearer was rejected instead of blaming a newly issued session; an invalid `TENTACLES_T3_BIN` is named as rejected (not absolute, or not an executable file) and the manual command keeps that value. README notes that `doctor` and `capabilities scan` may issue a session on a 401 unless `TENTACLES_T3_AUTO_REAUTH=0`.
- The npm tarball now ships `scripts/stall-watcher.mjs` and `scripts/ledger-count-alert.mjs`, so the bundled `docs/*.plist.sample` files point at scripts the package contains (both use Node built-ins only). It no longer ships the retired `scripts/publish-forgejo-release.mjs`, which stays in the source checkout (Forgejo is a read-only backup, KRA-8749).
- `docs/orchestration.md` and `docs/orchestration-loop.svg` name the 0.5 source line instead of the stale `0.5.0-jack.2` pin.
- `README.md` names the 0.5 source line instead of the stale `0.5.0-jack.2` pin.
- `npm run check` syntax-checks every `.mjs` file that exists under `src/` and `scripts/` instead of a hand-kept list, so it passes inside the extracted npm tarball and no longer skips `scripts/stall-watcher.mjs`, `scripts/record-node-path.mjs`, `scripts/publish-github-release.mjs` or `src/updater/`.

## [0.5.0-jack.4] - 2026-10-29

### Added

- No-AI origination-ledger counter `scripts/ledger-count-alert.mjs` with `docs/ledger-count-alert.plist.sample` (KRA-9690): read-only, never takes the state lock or prints keys; prints `LEDGER <count>/1000 <host>` and at 800 keys (950: ` CRITICAL`) exits 3 with `WAKE ledger count=<n> limit=1000 host=<host>`; optional 0600 alert file in `LEDGER_ALERT_DIR`. `docs/remote-pairing.md` adds the mini ssh-read note and the manual rotation runbook. Source checkout only.

- CI check `scripts/changelog-placement.mjs` (KRA-9774): on pull requests it fails when a line added to `CHANGELOG.md` lands under a released section instead of `## [Unreleased]`; a release PR that turns `[Unreleased]` into a new version passes. Sections match by version token, so editing a released header exempts nothing, and only the first `## [Unreleased]` counts. Run locally with `node scripts/changelog-placement.mjs [base-ref]` (default `origin/main`; exit 2 when the base ref is missing).

### Changed

- `scripts/stall-watcher.mjs` classifies the newest provider error of a stalled thread (KRA-9702): a dead login (`AUTH_DEAD`) or an exhausted 429 retry (`RETRY_EXHAUSTED_429`) gets no nudge and wakes at once with exit 3 and `WAKE <threadId> cause=<CAUSE>`; ordinary stalls keep two nudges and the bare `WAKE <threadId>`. 429 retry-limit stalls that previously got two nudges now wake at once with cause `RETRY_EXHAUSTED_429`. Auth markers only classify errors that are already stall-shaped (a disconnect, reconnect or 429), so an unrelated MCP or tool 401 warning never counts. With `TENTACLES_STALL_ALERT_DIR` set, each wake writes a 0600 `<epoch>-<threadId>.json` alert (thread id, cause, nudges, last event time; no title) into that existing directory.

### Fixed

- `scripts/ledger-count-alert.mjs` counts a state without `originations` as 0 only when it is version 1, as the bridge does. Operator-visible: `{}` or any non-version-1 state without `originations` now exits 1 with a one-line reason instead of printing `LEDGER 0/1000` (KRA-9772).

## [0.5.0-jack.3] - 2026-10-28

### Added

- No-AI stall watcher `scripts/stall-watcher.mjs` with `docs/stall-watcher.plist.sample` (KRA-9494): for a stalled Codex turn it sends up to two full-access resume `thread.continue` nudges (60 s stagger, 10 min backoff), then exits 3 with `WAKE <threadId>`; its `concurrency` log line is visibility only; source checkout only (not part of the npm tarball).
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

- `originate` no longer refuses every hire when the idempotency ledger reaches 1000 keys: at the cap it saves one rolling backup (`<state>.rotated`, mode 0600), prunes the oldest keys down to 900 and keeps the current key; it warns on stderr from 800 entries (KRA-9686).
- `orchestrate` names the queried T3 and adds "Wrong computer? Pass --computer <name> for a thread on another host; thread ids must be full UUIDs" when a continue target is not projected (KRA-9673).
- `report` and `observe` mark a turn whose newest activity is a stream disconnect or reconnect warning (seen after HTTP 429) as "stalled", with a reason and a last-error summary, once it has been idle past `TENTACLES_STALL_IDLE_MINUTES` (default 10), instead of "generating" forever (KRA-9494).
- Stall-watcher hardening (KRA-9525): the stall tail depends on the newest relevant event only, counts are prototype-safe and the state file is validated.
- `doctor` names the missing app-bundle prerequisite before recommending
  `install-codex-app-provider` for an unstartable codex-app binary (KRA-7727).
  The action also names `--codex-app-bin` for a nonstandard app location.
  Plain-text output preserves that full repair advice within a bounded
  320-character action budget, including the installer command and rerun hint.
- `doctor` keeps an unverified Hermes assistant skipped with a Hermes-specific
  action, instead of telling the operator to fix Claude Code sign-in (KRA-8860).
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
