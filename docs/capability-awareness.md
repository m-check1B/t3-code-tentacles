# Capability awareness

Status: Phase 1 (Tentacles collector) built; Jack ingest and agent tools follow

Owner: Tentacles maintainers. Linear: KRA-7369 (parent KRA-6253)

Last reviewed: 2026-10-14

Tentacles does **not** build connectors. Agents already use the vendors' CLIs,
MCP servers and plugins. Tentacles makes every agent **aware** of five things:

- what exists;
- on which computer;
- whether it is signed in or ready;
- how to invoke it;
- the one fix when it is missing or signed out.

```
 per computer (Tentacles)                    Jack (per business / seat / computer)
 ┌──────────────────────────────┐            ┌──────────────────────────────────────┐
 │ registry probes  (CLIs)      │            │ store latest inventory per pair_id   │
 │ lab config readers (names)   │──doctor──▶ │ capabilities.list / capabilities.find│
 │ T3 lab readiness (doctor)    │  status    │  → estate.route/classify for "which  │
 │ redaction gate → v1 document │  (pair)    │    lab"; one-click fix when missing  │
 └──────────────────────────────┘            └──────────────────────────────────────┘
```

## 1. Curated CLI registry

`CAPABILITY_REGISTRY` in `src/capabilities.mjs` is reviewed code, not user
configuration. A computer cannot add probes, so a lab config or a remote caller
can never make Tentacles run an arbitrary command. Each entry has these fields:

| field | meaning |
|---|---|
| `id` / `bin` | registry id and executable name looked up on PATH |
| `name` | display name |
| `services` | needs this CLI answers, e.g. `["github"]`, `["gmail","google-drive"]` |
| `category` | `forge`, `work`, `chat`, `cloud`, `lab`, `toolchain` |
| `version` | argv for the version probe, default `["--version"]` |
| `auth` | `null`, or `{ args, mode, verified, signedOutExitCodes? }` |
| `install` | install hint per platform (`darwin`/`linux`/`win32`/`default`) |
| `signIn` | the sign-in command shown when the probe says signed out |

There are two auth probe modes:

- `exit`: exit 0 means `signed_in`. An exit code in `signedOutExitCodes`
  (default `[1]`) means `signed_out`, but only when `verified: true`. Any other
  code reports `unknown`, so a usage error is never read as a sign-out.
- `stdout-nonempty`: exit 0 with non-empty stdout means `signed_in`; empty
  stdout means `signed_out`. This is used for gcloud, whose stdout is the
  account email. The output is tested for emptiness and then thrown away.

Entries with no auth probe report `auth: "unknown"`. That is true until a probe
has been checked on a real signed-out account. `verified: false` marks probes
that have not been checked yet. Each new probe is added only with that check.

Phase 1 registry: `gh`, `glab`, `tea`, `linear`, `gcloud`, `gws`, `slack`,
`claude`, `codex`, `cursor-agent`, `grok`, `opencode`, `gemini`, `uv`, `npm`,
`docker`.

These are deliberately absent:

- **vault and password-manager CLIs** (`bw`, `nasvault`, `op`, `pass`). These
  are never probed.
- **ClickUp**. There is no vendor CLI; ClickUp arrives as an MCP server.
- **Telegram/WhatsApp bridges**. There is no settled vendor CLI yet.

Registry PRs add these when they exist.

Each row reports these fields:

- `installed`
- `onPath`
- `where`: the path, folded to `~`
- `version`: a bounded token
- `auth`: `signed_in` | `signed_out` | `unknown` | `timeout` | `not_applicable`
- `state`: `signed_in` | `signed_out` | `installed` | `missing` | `probe_timeout`
- `fix`: `{kind: install|sign_in|path, command}` or `null`

Service managers often start Tentacles with a short PATH, so lookup also checks
`~/.local/bin`, `~/.local/node/bin`, `~/bin`, `~/.grok/bin`, `~/.cargo/bin`,
`~/.bun/bin`, `~/.npm-global/bin`, `~/go/bin`, `/opt/homebrew/bin`,
`/usr/local/bin` and `/usr/bin`. A CLI found only there reports
`onPath: false` and a `path` fix.

### Probe safety

Every probe follows these rules:

- It is an argv run with `shell: false`. Stdin is `ignore`, so no TTY prompt
  can wait. Stderr is discarded. Stdout is capped at 4 KiB.
- It runs in its own process group. At the per-probe timeout (5 s) the whole
  group is killed with SIGKILL. On Windows it uses System32 `taskkill /T /F`.
  The whole scan has a 30 s deadline; when it is hit, the document says
  `complete: false`.
- It gets the parent environment plus `NO_COLOR=1`, `TERM=dumb`,
  `GH_PROMPT_DISABLED=1`, `GIT_TERMINAL_PROMPT=0` and `NONINTERACTIVE=1`.
  `BROWSER` is set to a no-op. A probe that tries to start a login flow cannot
  open a browser, and it hits its timeout.
- It only runs read-only status commands (`--version`, `auth status`,
  `login status`, `mcp list --json`). There are no login, refresh or install
  commands.
- On Windows, `.cmd`/`.bat` shims are not probed, because running them needs a
  shell. They report `installed` with auth `unknown`.
- At most 4 probes run at once.

## 2. Per-lab MCP / plugin / skill discovery (names only)

Readers parse each lab's own config file and return **names and a closed set of
flags**. No value is copied: no command, args, env, header, URL, project path
or account field.

| lab | file(s) read | reported |
|---|---|---|
| Claude Code | `~/.claude.json` `mcpServers` (user) and `projects[*].mcpServers` (names only, scope `project`, project path never reported); `~/.claude/settings.json` `enabledPlugins`; `~/.claude/plugins/installed_plugins.json` `plugins`; `~/.claude/skills/<name>/SKILL.md` | MCP name, scope, transport, enabled; plugin name, enabled; skill name |
| Codex | `~/.codex/config.toml` `[mcp_servers.<name>]` table headers plus `enabled`/`command`/`url` presence; then `codex mcp list --json`, from which only `name`, `enabled` and `auth_status` are read; `~/.codex/skills/<name>` | MCP name, transport, state `signed_in`/`signed_out`/`configured`/`disabled`; skill name |
| Cursor | `~/.cursor/mcp.json` `mcpServers` | MCP name, transport, enabled |
| OpenCode | `~/.config/opencode/opencode.json[c]` `mcp` (JSONC aware) | MCP name, transport, enabled |
| Gemini CLI | `~/.gemini/settings.json` `mcpServers`; `~/.gemini/extensions/<name>` | MCP name, transport; extension name |

Transport is one of `stdio`, `http` or `unknown`. It is decided from which keys
are present, never from their values.

MCP auth state comes only from a lab that reports it without connecting. Today
that is Codex (`auth_status`). Other labs report `configured`. Health-checking
an MCP server would mean starting stdio servers or calling remote URLs. That has
side effects, so it is not done in a scan.

Grok Code has no file-based MCP config that Tentacles reads yet.

Account-level connectors (for example claude.ai connectors) are not visible in
local config. They are out of scope for Phase 1.

Every MCP and plugin row also gets `services` from `SERVICE_KEYWORDS`. For
example, `clickup-verduona` maps to `["clickup"]`. That is how "file this in
Linear" finds a `linear` CLI and a Linear MCP server alike.

## 3. `capabilities.v1.json`

```json
{
  "schema": "tentacles.capabilities.v1",
  "generatedAt": "2026-10-14T17:25:07.093Z",
  "registryVersion": "2026-10-14.1",
  "tentaclesVersion": "0.4.2",
  "computer": { "platform": "linux", "arch": "x64" },
  "complete": true,
  "durationMs": 670,
  "clis": [
    { "id": "gh", "name": "GitHub CLI", "category": "forge", "services": ["github"],
      "installed": true, "onPath": true, "where": "~/.local/bin/gh", "version": "2.61.0",
      "auth": "signed_out", "state": "signed_out",
      "fix": { "kind": "sign_in", "command": "gh auth login" } }
  ],
  "mcp": [
    { "lab": "codex", "name": "linear", "scope": "user", "transport": "http",
      "state": "signed_out", "services": ["linear"],
      "fix": { "kind": "sign_in", "command": "codex mcp login linear" } }
  ],
  "plugins": [ { "lab": "claude", "name": "github@claude-plugins", "enabled": true, "services": ["github"] } ],
  "skills": [ { "lab": "codex", "name": "alibaba-open-code-review" } ],
  "labs": [ { "instanceId": "codex", "name": "Codex", "ready": true, "code": null, "fix": null } ],
  "labsState": "ok",
  "truncated": { "mcp": false, "plugins": false, "skills": false },
  "dropped": 0,
  "redactions": 0
}
```

Field notes:

- `labs` is a closed projection of `tentacles doctor`: id, name, ready, code and
  action as `fix`. It never includes models. `labsState` is `ok`,
  `unavailable` (T3 unreachable or not authorized) or `skipped`.
- The document carries no hostname: on a Mac it often holds the owner's name.
  Jack already knows which computer it is from the pair.
- Limits: 64 CLI rows, 256 MCP rows, 256 plugin rows and 512 skill rows.
- `dropped` counts names that failed `^[A-Za-z0-9@._:+/-]{1,128}$` or looked
  like a secret.
- `redactions` counts strings replaced by the final gate.

Additive fields are allowed inside v1. A rename or removal is a v2 schema.

## 4. Refresh cadence

- `tentacles capabilities scan [--json] [--no-labs]` runs one scan, about 1 s on
  dev-workers. It writes `<state dir>/capabilities.v1.json` (mode 0600, atomic
  rename) and prints the table or the JSON.
- A running `tentacles pair` owns a `CapabilityCache`. It scans once at start
  and keeps the last good inventory; a failed scan never replaces it.
- It rescans in the background when the inventory is older than **5 minutes**.
  The trigger is the relay heartbeat `ping` (the same hook that refreshes the
  model catalog) or a `doctor-status` read. Scans are coalesced, so at most one
  runs at a time, and forced refreshes are rate-limited to one per 30 s.
- Picture of done: a sign-in change is visible to Jack within N = 5 minutes,
  plus Jack's own doctor cache TTL.

## 5. Publish path to Jack

The inventory travels inside the existing **`doctor-status`** RPC answer, as
`capabilityInventory`, next to the lab catalog (the same trust path).
`doctor-status` never waits for a scan. It returns the last inventory, or `null`
before the first scan, and kicks a background refresh if the inventory is stale.

A dedicated `capabilities` RPC is **not** used in Phase 1. Sphere's relay
(`jack_pairing.py` `_valid_rpc_capabilities`) rejects a `pair.bind` whose
`rpc` advert has an unknown method, and its `JackPairRpcRequest.method` is a
closed `Literal`. Advertising a new method before Sphere ships it would unpair
every computer. Sphere passes `rpc.result.result` through as `Any` under a
1 MiB frame.

The published copy is therefore bounded to **128 KiB** (`boundForPublish`).
Skills are trimmed first, then plugins, then MCP rows, with `truncated` flags.
CLI rows always stay. A future `capabilities` RPC is an additive Sphere +
Tentacles change; this field stays for older relays.

Jack side (separate agent-jack-3 PR):

1. **Ingest.** On every successful `doctor-status` read, validate
   `capabilityInventory` with a closed pydantic projection (`extra="forbid"`,
   bounded strings, the enums above). Upsert it into a new
   `tentacles_capabilities` table keyed by `pair_id`, with
   `ON DELETE CASCADE` from `tentacles_pairs`. Store the owner tuple, `host_id`,
   `schema`, `payload jsonb`, a digest and `observed_at`. Revoking a pair drops
   its inventory. A colocated Jack runs `tentacles capabilities scan --json`
   locally instead.
2. **Agent tools.** `capabilities.list` returns one row per computer and
   capability for the seat's business. `capabilities.find(need)` normalizes the
   need through `SERVICE_KEYWORDS` (and estate classify when a free-text brief
   is passed). It returns:
   - the signed-in paths first, for example "Linear: `linear` CLI signed in on
     Mac Pro; Linear MCP (codex) signed in on dev-workers";
   - otherwise the best one-click fix: install on the computer whose lab is
     ready, or sign in where the CLI/MCP is already installed;
   - `estate.route` when the agent also needs a lab.
   These tools are read-only (not in `MUTATING_TOOLS`), operator seats only,
   like the `estate.*` tools.
3. **Freshness.** Rows older than 3× the refresh cadence are returned as
   `stale` with their `observed_at`. They are never presented as current.

## 6. Redaction rules

The rules are enforced in code and covered by `test/capabilities.test.mjs`:

1. **Never values.** Readers copy names only. Command, args, env, headers,
   URLs, project paths and account fields stay on the computer.
2. **Never probe output** beyond a bounded version token
   (`^[0-9][A-Za-z0-9.+-]{0,63}$`) and the boolean emptiness of a
   `stdout-nonempty` probe. Stderr is never read.
3. **Never environment.** No env name or value is emitted.
4. **Paths** are folded to `~` (`redactHomePaths`). `/Users/<x>`,
   `/home/<x>` and `C:\Users\<x>` become `~`.
5. **Names** must match the safe-name pattern and not look secret. Otherwise
   they are dropped and counted.
6. **Final gate.** `redactCapabilities` walks the whole document and replaces
   any string with a credential shape with `"[redacted]"`. Credential shapes
   cover:
   - `sk-`, `ghp_`, `github_pat_`, `glpat-`, `xox?-`, `lin_api_`, `ya29.`,
     `AKIA` and JWT prefixes;
   - `Bearer …`, `token=`, `password:` and similar;
   - 32+ hex characters, or a 40+ character mixed-case base64 run;
   - URL userinfo and email addresses.

   Then it counts `redactions`. A non-zero count on a real computer is a bug to
   report by field name only.
7. **No hostname, username or machine id** in the document.
8. **The file is owner-only** (0600, in the 0700 state dir).

## 7. Covered computers

The same collector runs wherever Tentacles runs: the Mac Pro (launchd), Jupiter
dev-workers (systemd user) and the Server lab host. Each publishes through its
own pair. The registry and readers are platform-aware: Windows `PATHEXT`
lookup and no shell for `.cmd` shims.

## 8. Not in Phase 1

- MCP health/auth probes for labs that do not report it without connecting.
- Grok/Kimi/Pi/Hermes plugin discovery.
- Installing anything. Installs belong to the Market (KRA-6253), which uses
  this inventory to know what is missing.
- A dedicated `capabilities` pair RPC. This needs a Sphere change first.
