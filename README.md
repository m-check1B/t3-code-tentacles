# Tentacles

T3 Code tentacles — originate any ready lab (instance + model + budget).
Hermes was the first tentacle, not the product.

Repository documentation and integration authority boundaries start at
[docs/README.md](docs/README.md). The GitHub repo and CLI binary remain
`t3-agent-bridge`; `tentacles` is an exact command alias.

[![CI](https://github.com/m-check1B/t3-agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/m-check1B/t3-agent-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/m-check1B/t3-agent-bridge)](https://github.com/m-check1B/t3-agent-bridge/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-43853d.svg)](package.json)

Connect ACP agent harnesses to [T3 Code](https://github.com/pingdotgg/t3code)
without forking either side. The included adapters support
[Hermes Agent](https://github.com/NousResearch/hermes-agent) and
[Pi Agent](https://github.com/Dicklesworthstone/pi_agent_rust); the repository
name and command surface stay stable as more providers are added.

This is a standalone, reversible bridge. T3 Code stays the polished multi-agent
cockpit; Hermes and Pi stay independent ACP harnesses with their own runtime,
model, authentication, and tool configuration.

> **Project status:** early integration, tested with T3 Code
> 0.0.34-nightly.20260811.1064, Hermes Agent
> 0.20.0, Pi Agent 0.1.23, and Node.js 22 on macOS. Other versions and platforms
> are not yet verified—compatibility reports are welcome.

## What works today

| Flow | Result | Status |
|---|---|---|
| T3 Code → Hermes | Hermes appears as a normal T3 provider over ACP | Tested |
| T3 Code → Pi | Pi appears as a parallel T3 provider; T3's picker switches Pi models over ACP | Tested |
| Hermes → T3 Code | `t3-agent-bridge originate` creates a visible Hermes-backed T3 thread | Tested |
| Any T3 thread → Hermes | A new `@hermes` message routes to one linked Hermes thread | Tested |
| Existing T3 providers | Provider install/remove preserves unrelated instances | Tested |
| Background routing | Reversible per-user macOS LaunchAgent or Linux systemd user unit | macOS tested; Linux unit-tested |
| Inline Hermes reply in another provider's thread | Requires an upstream T3 extension point | Not available |

The mention bridge deliberately creates a clearly labeled linked Hermes thread.
It does not impersonate the assistant inside another provider's existing thread.

## Why T3 shows Hermes or Pi as Grok

The bridge registers both harnesses through T3 Code's `grok` driver because that
driver is T3's configurable ACP-over-stdio adapter. T3 starts the configured
binary with `agent stdio`; the matching wrapper starts either `hermes --profile
<profile> acp` or Pi's native `pi --acp` transport.

This selects a transport adapter, not a model provider. Hermes still uses its
active profile. Pi advertises only the models belonging to the configured
`PI_PROVIDER`; choosing a bare model ID such as `gpt-5.6-terra` in T3 calls
Pi's ACP `session/set_model` method.

T3's `codex` driver is not a generic route to every Codex-backed model. It
speaks the Codex-specific `app-server` protocol and expects Codex authentication,
model discovery, thread lifecycle, and message semantics. Hermes speaks ACP, so
using the Codex driver would require an unnecessary Codex `app-server`
compatibility layer.

On an unmodified T3 Code release, Hermes and Pi may therefore display the Grok icon.
That is a cosmetic limitation only: the bridge and both communication
directions still work. Stock T3 also adds its built-in `grok-build` entry to
every instance using this adapter; that entry is not a Pi model and should not
be selected. A small T3 UI patch can give the bridge's stable
`grok:hermes` driver + instance identity its own logo, without relying on its
editable display name. The patch is optional and remains outside this bridge.
It was submitted upstream as [T3 Code #5732](https://github.com/pingdotgg/t3code/pull/5732),
which closed without merging; the reviewed patch remains available in our
[public patch repository](https://github.com/m-check1B/t3code-hermes-ui).
A neutral generic-ACP provider/icon extension in T3 Code remains the clean
long-term solution.

If native Grok turns end immediately with no assistant message and Grok's own
session events report invalid API-key authentication, an `XAI_API_KEY` stored
on T3's native `grok` instance may be overriding a valid cached Grok login.
Switch that instance back to cached login explicitly:

```bash
t3-agent-bridge use-native-grok-cached-auth
```

This command removes only the native Grok instance's stored `XAI_API_KEY` and
routes that instance through a bridge wrapper that unsets an inherited
`XAI_API_KEY` and sets `GROK_DISABLE_API_KEY_AUTH=true` before starting Grok,
forcing Grok's cached OIDC login instead of its ACP API-key preference. It
also acknowledges T3's driver-specific `cached_token` ACP handshake locally;
Grok continues to own and refresh the cached credential, and all other ACP
frames pass through unchanged. The repair preserves every other provider
setting and refreshes the native provider. It is never run automatically by
`originate` or `act`.

## Five-minute setup

### 1. Prerequisites

- T3 Code 0.0.34-nightly.20260811.1064 listening on `127.0.0.1:3773`.
- Hermes Agent 0.20.0+ with ACP support.
- Pi Agent 0.1.23+ for the optional Pi harness.
- Node.js 22+.

Clone the bridge and install the command shim:

```bash
git clone https://github.com/m-check1B/t3-agent-bridge.git
cd t3-agent-bridge
mkdir -p ~/.local/bin
t3_bridge_command="$HOME/.local/bin/t3-agent-bridge"
if [ -e "$t3_bridge_command" ] || [ -L "$t3_bridge_command" ]; then
  printf 'Refusing to replace existing path: %s\n' "$t3_bridge_command" >&2
else
  ln -s "$PWD/bin/t3-agent-bridge" "$t3_bridge_command"
fi
unset t3_bridge_command
```

Ensure `~/.local/bin` is on your `PATH`.

The former `t3-hermes` command remains packaged as an exact compatibility
alias. Existing ownership markers, LaunchAgent labels, and
`~/.local/state/t3-hermes-bridge` paths also remain valid so upgrades do not
silently orphan provider or watcher state.

### 2. Issue a local T3 token

Create a scoped bearer file without printing the token:

```bash
install -d -m 700 ~/.local/state/t3-hermes-bridge
umask 077
npx -y t3@0.0.34-nightly.20260811.1064 auth session issue \
  --base-dir ~/.t3 \
  --ttl 30d \
  --label t3-hermes-bridge \
  --subject local:t3-hermes-bridge \
  --token-only > ~/.local/state/t3-hermes-bridge/t3.token
chmod 600 ~/.local/state/t3-hermes-bridge/t3.token
```

The bridge accepts only an owner-controlled regular `0600` token file and only
connects to loopback T3/Hermes origins.

### 3. Register Hermes in T3 Code

Choose your Hermes profile and the T3 model identifier you want displayed. The
defaults are `default` and the model used by the tested setup:

```bash
t3-agent-bridge install-provider \
  --profile default \
  --model openai-codex:gpt-5.6-sol
t3-agent-bridge doctor
```

If your installation exposes a different model identifier, pass it with
`--model` or set `T3_HERMES_MODEL`.

Open T3 Code, select the **Hermes** provider, and send a message. A real Hermes
assistant reply is the first-direction proof.

### 3a. Register Pi as a parallel harness

Authenticate and configure Pi through Pi's normal local setup first. Credentials
remain in Pi's custody and are never copied into T3 settings or this bridge.
Then register the model that T3 should select initially:

```bash
t3-agent-bridge install-pi-provider \
  --instance pi \
  --pi-provider openai-codex \
  --model gpt-5.6-terra
```

Open T3 Code and select **Pi**. The Pi ACP session advertises only models owned
by the configured Pi provider—three Codex models for `openai-codex` in the
tested setup. T3's model picker sends the selected bare model ID to Pi with
`session/set_model`. The compatibility relay normalizes Pi 0.1.x's legacy ACP
model/mode state and local-auth handshake. Prompts, streamed updates, tool
calls, approvals, cancellation, and model switching otherwise pass unchanged.

If a pre-v0.2 Pi installation already populated T3 with cross-provider models,
quit T3, move `~/.t3/caches/pi.json` to a private backup, reopen T3, and rerun
`install-pi-provider`. Current T3 nightly builds retain previously discovered
models across refreshes, so changing the relay alone cannot prune that stale
cache in place. Fresh v0.2 installations do not populate it.

### 3b. Register DeepSeek or Kimi as additional harnesses

**DeepSeek (dsh-acp).** Install the ACP server and make sure the OpenCode auth
store holds a DeepSeek key (`~/.local/share/opencode/auth.json`, JSON path
`.deepseek.key`). The bridge launcher reads the key at spawn time and passes it
to the server only through the environment, never the command line:

```bash
npm i -g dsh-acp
t3-agent-bridge install-deepseek-provider \
  --instance deepseek \
  --model deepseek-v4-flash
```

The default model is `deepseek-v4-flash`; override it with `--model` or
`T3_DEEPSEEK_MODEL`. The wrapper launches `dsh-acp` from `PATH` (or an absolute
`--dsh-acp-bin`/`DSH_ACP_BIN` override) with a bridge-owned Cordis config and
`workspace-write` permissions. Sessions persist under
`~/.dsh/acp-sessions/<workspace-hash>`: dsh-acp's SQLite session store is
single-process, so the bridge keys the store on a digest of the working
directory T3 spawned the thread with—sessions stay resumable per workspace
while parallel T3 threads in different workspaces each get their own store.
An explicit `DSH_SESSIONS_ROOT` replaces this default entirely and must then
be unique per concurrent lane.

**Kimi CLI.** Kimi speaks ACP natively through `kimi acp`, so no proxy is
needed—only an authenticated `kimi` CLI on `PATH` (or an absolute
`--kimi-bin`/`KIMI_BIN` override):

```bash
t3-agent-bridge install-kimi-provider \
  --instance kimi \
  --model kimi-code/k3
```

Remove either registration with `remove-deepseek-provider` or
`remove-kimi-provider`. Both carry the same ownership markers and refusal rules
as the Hermes and Pi providers.

### 4. Prove the reverse direction

```bash
t3-agent-bridge originate \
  --workspace "$PWD" \
  --title "Hermes surfaced this" \
  --message "This T3 thread originated through the standalone Hermes bridge." \
  --runtime-mode full-access
```

A new Hermes-backed thread should appear in T3 Code.

Cursor is an explicit, non-default lab: pass `--instance cursor` together with
the model T3 currently advertises for that instance. Tentacles does not install,
enable, or select Cursor by default; the T3 Cursor instance must already be
enabled and ready before a real originate can succeed.

POL-036/POL-GB-016 mandate `--runtime-mode full-access` on every originate
and `"runtimeMode":"full-access"` on every non-empty continue, for every lab
and effort; an omitted runtime mode is refused, never defaulted.

### 5. Enable `@hermes`

```bash
t3-agent-bridge watch --once --allow-all-projects   # arms the initial watermark
t3-agent-bridge watch --allow-all-projects          # polls for new mentions
```

In any non-Hermes T3 thread, send `@hermes investigate this`. The watcher creates
or continues one linked `[Hermes]` thread. The first pass never backfills old
messages.

On macOS, keep the watcher running as a per-user service. Service operations
require both a filesystem-safe Hermes profile and a bridge instance; this avoids
accidentally replacing a different watcher:

```bash
t3-agent-bridge install-service \
  --profile default \
  --instance hermes \
  --model openai-codex:gpt-5.6-sol \
  --interval 2000 \
  --t3-url http://127.0.0.1:3773 \
  --hermes-url http://127.0.0.1:8642 \
  --token-file ~/.local/state/t3-hermes-bridge/t3.token \
  --state-file ~/.local/state/t3-hermes-bridge/profiles/default/instances/hermes/bridge-state.json \
  --max-messages 10 \
  --allow-all-projects
t3-agent-bridge service-status --profile default --instance hermes
```

`install-service` snapshots the bridge runtime into private Application Support
storage before activation. The LaunchAgent uses that immutable snapshot rather
than the mutable checkout, and contains only non-secret settings: profile,
instance, model, polling/routing policy, loopback origins, and token/state file
paths. It never stores a bearer value, auth header, WebSocket ticket, or routed
prompt.

Mention routing is deny-by-default. `--allow-all-projects` is the explicit local
policy used when every non-Hermes T3 project may summon this Hermes instance.
The library also accepts project/provider allowlists for narrower embedders.

The service uses no public, unbounded stdout/stderr logs. Instead it keeps a
private structured watcher status file and reports its freshness, state-file
freshness, token-file metadata (without reading the bearer), launchd PID/runs/
last-exit data when available, and runtime identity through `service-status`.

```bash
t3-agent-bridge restart-service --profile default --instance hermes
t3-agent-bridge uninstall-service --profile default --instance hermes
```

Uninstall removes only the owned namespaced LaunchAgent. It deliberately
preserves the token, routing state, private status, and immutable runtime
snapshot for recovery and audit. Existing pre-namespaced v0.1 services are
reported as migration information and are never deleted implicitly; install a
new namespaced service, verify it, then remove the old owned service manually
when you are ready. A legacy routing state is likewise preserved; pass its path
explicitly as `--state-file` only when intentionally migrating that watcher.
The bridge atomically upgrades replay-safe v0.1.0 state before dispatch. It
refuses to migrate unresolved legacy pending deliveries so they can be audited
with v0.1.0 rather than silently dropped.

### 6. Linux: run the watcher as a systemd user service

On Linux, the same service commands install a per-user systemd unit instead of
a LaunchAgent:

```bash
t3-agent-bridge install-service \
  --profile default \
  --instance hermes \
  --model openai-codex:gpt-5.6-sol \
  --interval 2000 \
  --t3-url http://127.0.0.1:3773 \
  --hermes-url http://127.0.0.1:8642 \
  --token-file ~/.local/state/t3-hermes-bridge/t3.token \
  --state-file ~/.local/state/t3-hermes-bridge/profiles/default/instances/hermes/bridge-state.json \
  --max-messages 10 \
  --allow-all-projects
t3-agent-bridge service-status --profile default --instance hermes
```

Install writes the owned, private unit to
`~/.config/systemd/user/<label>.service`, links it from
`~/.config/systemd/user/default.target.wants/` (the same effect as
`systemctl --user enable`), runs `systemctl --user daemon-reload`, and starts
it. The immutable runtime snapshot and service/status files live under
`~/.local/share/t3-hermes-bridge`, with the same ownership markers and
non-secret content policy as the macOS LaunchAgent.

launchd semantics map onto systemd as follows: `KeepAlive` →
`Restart=always`, `ThrottleInterval` (10 s) → `RestartSec=10`, and the
`[Unit]` directives `StartLimitIntervalSec=0` plus `StartLimitBurst=0`
disable systemd's default start-burst limit so the restart policy remains
the only retry governor. `service-status` reads
`systemctl --user status` and `systemctl --user show`, reporting the same
shape as macOS with the restart count (`NRestarts`) mapped to launchd's runs
counter and `ExecMainStatus` to the last exit code.

```bash
t3-agent-bridge restart-service --profile default --instance hermes
t3-agent-bridge uninstall-service --profile default --instance hermes
```

Uninstall removes only the owned namespaced unit and enable link, and preserves
the token, routing state, private status, and immutable runtime snapshot for
recovery and audit, exactly like macOS. No bearer value, auth header, WebSocket
ticket, or routed prompt is ever written to the unit.

> **Status:** the systemd path is unit-tested against synthetic `systemctl`
> fixtures but has not yet been live-verified on a real Linux host. User units
> also only start at login unless lingering is enabled for the account
> (`loginctl enable-linger <user>`). Both remain to be proven on a target
> distribution before production use.

## Optional Hermes skill

Expose thread origination to a Hermes profile:

```bash
mkdir -p ~/.hermes/profiles/default/skills
t3_bridge_skill="$HOME/.hermes/profiles/default/skills/t3-code-bridge"
if [ -e "$t3_bridge_skill" ] || [ -L "$t3_bridge_skill" ]; then
  printf 'Refusing to replace existing path: %s\n' "$t3_bridge_skill" >&2
else
  install -d -m 700 "$t3_bridge_skill"
  install -m 600 \
    "$PWD/integrations/hermes-skill/SKILL.md" \
    "$t3_bridge_skill/SKILL.md"
  printf '%s\n' "$PWD" > "$t3_bridge_skill/.t3-hermes-bridge-owned"
  chmod 600 "$t3_bridge_skill/.t3-hermes-bridge-owned"
fi
unset t3_bridge_skill
```

Use the same profile name you passed to `install-provider`.

The skill is copied rather than symlinked because Hermes intentionally warns
when a skill resolves outside the active profile's trusted `skills/` directory.

## Uninstall

```bash
t3-agent-bridge uninstall-service --profile default --instance hermes
t3-agent-bridge remove-deepseek-provider --instance deepseek
t3-agent-bridge remove-kimi-provider --instance kimi
t3-agent-bridge remove-pi-provider --instance pi
t3-agent-bridge remove-provider

t3_bridge_command="$HOME/.local/bin/t3-agent-bridge"
if [ "$(readlink "$t3_bridge_command" 2>/dev/null)" = "$PWD/bin/t3-agent-bridge" ]; then
  rm -- "$t3_bridge_command"
else
  printf 'Refusing to remove unowned path: %s\n' "$t3_bridge_command" >&2
fi

t3_bridge_skill="$HOME/.hermes/profiles/default/skills/t3-code-bridge"
if [ -f "$t3_bridge_skill/.t3-hermes-bridge-owned" ] && \
   [ "$(cat "$t3_bridge_skill/.t3-hermes-bridge-owned")" = "$PWD" ]; then
  rm -- "$t3_bridge_skill/SKILL.md" \
        "$t3_bridge_skill/.t3-hermes-bridge-owned"
  rmdir "$t3_bridge_skill"
else
  printf 'Refusing to remove unowned path: %s\n' "$t3_bridge_skill" >&2
fi

unset t3_bridge_command t3_bridge_skill
```

Then revoke the issued T3 session. Provider removal is ownership-marked and
refuses to delete a provider it did not create.

## How it stays source-independent

- T3 → Hermes and T3 → Pi use the Agent Client Protocol already implemented by
  the harnesses, with a narrow Pi 0.1.x wire-shape compatibility relay.
- Hermes → T3 uses T3's authenticated local orchestration API.
- Mention routing reads T3 state and dispatches immutable correlated commands.
- The functional bridge modifies neither upstream repository. An optional T3 UI
  patch only corrects the displayed Hermes logo.

See [the architecture](docs/architecture.md), [the security policy](SECURITY.md),
and [the v0.1.0 demo recipe](docs/demo.md).

## Built by the workflow it connects

Matej Havlin proposed the bidirectional bridge: T3 Code as the visible cockpit,
Hermes behind it, and a standalone module glued to both ends. Hermes/Orbit
orchestration and Codex-led implementation then turned that direction into a
working bridge, while independent adversarial reviews found and drove fixes for
token forwarding, duplicate routing, concurrent dispatch, async projection, and
provider ownership.

That traceable idea → implementation → attack → correction → live proof loop is
part of the project. It is documented in [the build story](docs/build-story.md).

## Roadmap

One provider-neutral T3 bridge, with Hermes and Pi Agent adapters today and a
stable extension seam for additional ACP harnesses.

- Contract-test newer T3 Code and Hermes releases.
- Live-verify Linux systemd service packaging (unit-tested; not yet proven on a real host).
- Explore an upstream-safe inline reply extension.
- Add more ACP harnesses through the same ownership-safe parallel-provider seam.

## Orchestration control plane

Beyond the provider adapter, the bridge exposes a full read/write orchestration
surface so Hermes — or any system — can act as the top orchestrator of a T3 Code
environment. `observe` returns the live state (projects, threads, pending
approvals/user-input, active turns, archived threads); `act` and `orchestrate`
dispatch the full project/thread/turn/approval command vocabulary with
idempotent command IDs and projection verification. See
[docs/orchestration.md](docs/orchestration.md).

Contributions and real compatibility reports are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This is an independent community project. It is not an official T3 Code, Ping
Labs, Hermes Agent, Nous Research, Pi Agent, or Agent Client Protocol project and
is not affiliated with or endorsed by those organizations.
