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
  - The full environment is kept on purpose. Some CLIs sign in through it
    (`GH_TOKEN`), and an agent on the same computer sees the same environment,
    so a reduced one would report false sign-outs.
  - No probe output is kept, so the environment never leaves the computer.
- Some status probes **make network calls**. `gh auth status`,
  `claude auth status` and possibly `codex mcp list` check with their services.
  A running pair does this at most every 5 minutes, and a failed scan backs
  off by the same 30 s minimum interval as a forced refresh.
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
- `dropped` counts names that failed `^[A-Za-z0-9@][A-Za-z0-9@._+/-]{0,63}$`
  (no `:`, no leading `-`, at most 64 characters) or looked like a secret.
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

The published copy is bounded twice, so the inventory can never take
`doctor-status` down:

- **Room left.** `inventoryRoom` gives the inventory only the room the lab
  catalog leaves in the pairer's frame, minus the envelope, capped at
  **128 KiB**. The catalog is never trimmed for it. Within that room,
  `boundForPublish` trims skills first, then plugins, then MCP rows, with
  `truncated` flags. CLI rows always stay. No room means
  `capabilityInventory: null`.
- **Overflow fallback.** If an encoded reply still exceeds the frame, the
  pairer resends it with `capabilityInventory: null`. It never answers
  `computer.unavailable` because of the inventory. A future `capabilities` RPC is an additive Sphere +
Tentacles change; this field stays for older relays.

Jack side (agent-jack-3 PR, `api/src/jack_api/capability_inventory.py`):

1. **Read, do not copy.** `capabilities.list` / `capabilities.find` read each
   seat computer's inventory live. They go through the same owner-scoped
   paired-host registry and 30 s doctor cache as the lab picker
   (`paired_hosts.list_seat_hosts` → `runtime.lab_doctor()`), so the answer is
   never older than the computer's last scan plus that TTL. Revoking a pair
   removes it at once.
   - A closed projection (`project_inventory`) keeps only the v1 fields above:
     bounded names, known enums, and fixes without `[redacted]`.
   - `where`, the version source and unknown keys never reach an agent.
   - A computer that cannot be reached is `offline`; one whose Tentacles sends
     no inventory is `no_inventory`. Neither is ever guessed.
   - A durable per-pair table is a later option if an offline computer's last
     inventory is needed.
2. **Agent tools.** Both tools are read-only (not in `MUTATING_TOOLS`) and
   granted to operator seats only. Friends and Team turns do not get them.
   - **Need routing.** For the Founder business the need goes through
     estate-guardian first:
     - `estate.classify` gates a `restricted` need to the Founder path, with
       no install or sign-in suggestion;
     - `estate.route` supplies the lab and host that rank equally ready paths;
     - `estate.capability` names (`linear`, `clickup.verduona`,
       `gmail.read_draft`) give a worker route.
   - **Inventory matching.** Only matching stays local. A need names a
     service when a term on its word boundaries is a CLI id, an MCP or plugin
     name, or a `services` value in the seat's inventories, Jack's reviewed
     MCP catalog (`tool_registry.MCP_CATALOG`), or an estate capability.
     Jack keeps no private synonym table.
   - **No dead ends.** `fixes` holds one concrete fix per computer:
     - sign in where the connector is signed out;
     - install the CLI (from the registry hint) where it is missing;
     - for a catalog MCP such as ClickUp, add it through the computer's
       signed-in or installed lab (installing the lab first if needed),
       with the Market link `/app/marketplace?tab=catalog`;
     - reconnect an offline computer, or update a Tentacles that sends no
       inventory;
     - pair a computer when the seat has none.
   - **Statuses, in this order:**
     - `available`: the signed-in paths;
     - `unverified`: installed or configured, sign-in unknown;
     - `needs_sign_in`;
     - `via_worker`: the estate worker's hire line;
     - `missing`, with the first concrete fix;
     - `restricted`;
     - `unknown_need`.
   - **Names.** The Jack projection applies the same name rule and token
     check as Tentacles. A token-shaped name or fix from an older Tentacles
     never reaches an agent.
3. **Freshness.** An inventory older than 15 minutes (3× the cadence) is
   `stale`. It is ranked last and never counted as signed in.

## 6. Redaction rules

The rules are enforced in code and covered by `test/capabilities.test.mjs`:

1. **Never values.** Readers copy names only. Command, args, env, headers,
   URLs, project paths and account fields stay on the computer.
2. **Never probe output** beyond a bounded version token
   (`^[0-9][A-Za-z0-9.+-]{0,63}$`) and the boolean emptiness of a
   `stdout-nonempty` probe. Stderr is never read.
3. **Never environment.** No env name or value is emitted.
4. **Paths** are folded to `~` (`redactHomePaths`). `/Users/<x>`,
   `/home/<x>`, `C:\Users\<x>` and `/root` become `~`.
5. **Names** must match the safe-name pattern and not look secret. Otherwise
   they are dropped and counted.
6. **Final gate.** `redactCapabilities` walks the whole document and replaces
   any string with a credential shape with `"[redacted]"`. Credential shapes
   cover:
   - prefixes: `sk-`, `sk_live_`/`sk_test_` (and `rk_`/`pk_`), `ghp_`,
     `github_pat_`, `glpat-`, `xox?-`, `xapp-`, `lin_api_`, `hf_`, `ntn_`,
     `secret_`, `AIza`, `ya29.`, `AKIA`, JWT, Telegram bot tokens
     (`<digits>:<20+>`) and `api-key-…`;
   - `Bearer …`, `token=`, `password:` and similar;
   - an alphanumeric run (separators end a run) of 20+ characters that mixes
     letters and digits or cases, or any run of 32+ characters whatever its
     case;
   - a 40+ character base64url run with all character classes;
   - URL userinfo and email addresses.

   Then it counts `redactions`. A non-zero count on a real computer is a bug to
   report by field name only.
7. **No hostname, username or machine id** in the document.
8. **The file is owner-only**: 0600, in a state dir tightened to 0700 on every
   write.

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
