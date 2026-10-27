# Staging Server labs: patched T3 and web-off activation

Plan for KRA-8715 item 21, KRA-8722 and KRA-8812. This is a source runbook,
not permission for a service change, credential read or production rollout.
The appointed staging operator executes a separately admitted packet.

## Inventory and immutable pins

The 24 October inventory recorded upstream T3 0.0.42 on the staging guest,
with a Tailscale listener and `t3-loopback-proxy.service` exposing loopback
port 3773. The assigned brief records Tentacles 0.4.0. These are historical
observations. On 27 October this writer could not refresh them: the alias did
not resolve, both recorded addresses rejected its SSH identity, and the API
readiness connection timed out. Source merges do not prove installed state.

| Component | Pin | Evidence and limitation |
| --- | --- | --- |
| Patched Linux T3 | `t3-0.1.0-jack.1-linux-x64.tar.gz`, SHA-256 `1ff353f41f8160369e133aa01d30b71b1e5ebce7feffd03d76be6baa68a5ecb7` | Archive matches its sidecar. Embedded provenance names source `e027af1a9aa18eb325b68621a4eabf6bfac49c37`, headless/no client, Node 26.8.2. Candidate for the existing cutover lane; host admission remains required. |
| T3 capability record | `talkFreshProviderContext: 0`, `talkTurnResult: 2`, `turnResultRoute: 2` | Embedded `G1.json`, not a live endpoint observation. |
| Tentacles | `v0.5.0-jack.2`, tag commit `78257d5ffaafa6b4a13c88ab4b32b5f28152d2f7` | Tarball `tentacles-0.5.0-jack.2.tgz`, SHA-256 `97eca59d59890127306bb84c4345536668a0cce3e94c729574b7650467ac95ba`. A newer main commit with the same package version is a different build. |
| Jack installer | `deploy/production/scripts/server-labs-runtime.py` in private `m-check1B/agent-jack-3` | PR 79 merged as `f001f2fb2efc1e373cd274f9ad8da10f116dc2ea`; creates dormant scoped runtime and twins. Activation blockers remain binding. |

Canonical T3 V2 source is private `m-check1B/t3code-hermes-private-archive`,
branch `jack/upstream-0.1.0`. Its tip can advance. Do not substitute an unpinned
tip or upstream npm package. A replacement artifact needs new whole-package
checksums, provenance, review and host admission.

## Staging install sequence

1. GUARDIAN/OPS supplies one staging-only packet binding the SSH account/host,
   exact artifacts, Node/provider executable pins, service ownership, separate
   V2 base directory, loopback port, prior launch/link targets, redacted current
   inventory and rollback. Every protected reader needs exact bytes, host,
   parent and allowed outputs. Dev-workers custody admission does not imply
   staging admission. Missing access or a reader pin is HOLD.
2. Stage immutable artifacts into new directories and verify the whole package
   and dependency graph. Preserve old releases, V1 userdata and sessions.
   This task cannot read, import, copy, move or delete V1 data. Do not mint
   an administrative token or repoint an existing launcher.
3. Use `ops-maintainer/runbooks/t3-runtime-drain.md` for cutover prerequisites.
   Its supported targets/readers need explicit staging admission; do not pass
   `dev-workers` as a substitute staging target or improvise a restart.
   Any required V1 reader/backup stays in its separately authorized lane.
4. OPS stages the scoped candidate with the existing Jack installer and
   `docs/kra-6252/server-labs-runtime.md`. Bind a real staging business/seat,
   dedicated UID/GID, state, port and artifact paths. Do not invent a scope or
   share an unrestricted multi-seat runtime. The installer requires exact
   Python 3.13.15 and privileged installation; this writer has no sudo grant.
5. Keep `ACTIVATION-BLOCKED-DO-NOT-CREATE` absent. Never defeat the dormant
   unit's condition. Installer doctor exit `2` means files validated **with
   activation blocked**, not permission to start. Credential brokering,
   confinement and runtime registry admission remain existing host-lane gates.
6. Only the admitted staging packet switches the new runtime and API route.
   API environment access belongs to its audited release reader. Production,
   Pro, Air, retained workers and their deployment locks are outside this task.

The shortest safe path reuses the pinned Linux build and released Tentacles;
it needs no desktop rebuild or Pro install. Staging-first topology does not
waive authentication, isolation or custody gates.

## KRA-8812: separate web-off Codex sign-in

The installer creates the private twin home below
`STATE/instances/codex-noweb/codex`; `STATE` is the admitted scope directory.
Require the intended service owner and private ancestry. Never copy or symlink
base `auth.json`: independent homes must not race on refresh tokens. A ready
base never supplies twin readiness. Do not make root-custody login readable
to an unrestricted worker; home creation does not solve the broker/isolation
blockers above.

The exact instance needs its explicit home and the installer launch override
`--config 'web_search="disabled"'`. Config-file disable alone is insufficient;
see [the web-tools contract](web-tools.md).

After custody/isolation admission, the authorized vault seat signs in the twin
separately with its pinned Codex executable and exact `CODEX_HOME`. For API-key
auth the intended operation is `codex login --with-api-key`; the existing
`nasvault` route supplies stdin through an audited reader. This runbook supplies
no new secret reader or raw vault command. Never put the key in argv, an
environment value, logs or the bundle; never open a password-manager browser.
If nasvault fails in that admitted step, stop and report its error.

Device-auth requires separate account/2FA authority. Do not begin interactive
login or request Founder input here. Record missing authority on the existing
issue and keep the twin unready. The other four web-off twins remain
disabled/unknown with failing executables until independently proved.
Do not invent a `jackMcpProviders` capability.

## Next commands and acceptance

These commands download and verify the published Tentacles asset into a new
task-owned directory, without installing it. Run separately, record outputs and
exits, stop on a nonzero exit, and never enable shell errexit. An existing
destination refuses reuse; do not overwrite it.

```sh
mkdir item21-tentacles-assets
gh release download v0.5.0-jack.2 -R m-check1B/t3-code-tentacles-private --dir item21-tentacles-assets --pattern tentacles-0.5.0-jack.2.tgz --pattern tentacles-0.5.0-jack.2.tgz.sha256
cd item21-tentacles-assets
sha256sum -c tentacles-0.5.0-jack.2.tgz.sha256
sha256sum tentacles-0.5.0-jack.2.tgz
```

The last digest must equal the pin above. A sidecar match alone does not
identify the intended release. Staging execution remains HOLD until the
packet supplies admitted absolute paths and readers. After admission, use
these arguments with the installed Node/Tentacles paths **on staging**:

```text
node /admitted/tentacles/src/cli.mjs --version
node /admitted/tentacles/src/cli.mjs doctor --json --models summary
```

Those paths are non-executable placeholders until bound by the packet.
Doctor internally reads authentication/configuration and may refresh providers:
invoke only through the exact admitted parent/reader against the new runtime,
never the historical V1 instance. Emit only the admitted summary, not raw
configuration, tokens, errors or thread contents. Local doctor is not staging
evidence.

| Gate | Required receipt |
| --- | --- |
| Installed build | Exact T3 version/source/artifact, Tentacles `0.5.0-jack.2` and matching installed release bytes, admitted Node/Codex versions, literal loopback endpoint. |
| Patched contract | Live doctor `t3.talk.status == "present"`, `capabilities.talkTurnResult == "v1"`; command/message/run correlation in a fresh synthetic turn receipt. Embedded G1 alone cannot pass. |
| Exact twin | One `codex-noweb` row: ready, null refusal code, observed `codex` driver, `webTools.v == 1`, state `off`, tools `["web_search"]`. Assessed tool names are not enabled tools. |
| Refusal | Unsigned twin remains unready despite ready base. Missing/ambiguous identity or web on/unknown refuses with zero provider calls. |
| Jack web gate | Disposable staging Bot, Browser & web OFF: dispatch exact twin, persist terminal reply and continue on the twin. ON uses base; unknown grant fails closed. |
| Zero fetches | Approved observation separates provider transport from web search/fetch. Controlled synthetic URL yields zero external web fetches, with redacted counters/receipt. A model's answer or config declaration alone is insufficient; no real nft here. |
| Inline fix | Existing provably web-off twin unready only for sign-in: specific KRA-8812 sign-in refusal plus operator activation fix and zero provider calls. Missing twin or web on/unknown keeps the standard Capabilities answer. Backend owner implements this separate API/UI contract; this runbook does not claim it shipped. |
| Isolation/cleanup | Existing per-seat/cross-seat host gates pass. Archive only the synthetic probe through its owning lane; stop task-started processes; preserve retained workers and V1 data. |

Use the current Jack staging test-identity/browser runbooks for the Bot flow,
with a disposable staging identity. An exact Bot-test command needs the admitted
release, identity harness and observation reader; record any missing binding
rather than inventing an endpoint or bearer. No production/customer identity
is an acceptable substitute.

## Failure and rollback

Before activation keep the previous runtime and route serving. Preserve partial
staged files for OPS reconciliation; do not recursively delete runtime state.
After an admitted activation fails, the same release owner restores the recorded
API route and immutable launch/link targets under the existing lock, stopping
only the proven-owned new runtime after drain. Do not reopen V1 data, import V2
state into V1 or replay an uncertain turn. Missing admitted rollback evidence
means HOLD. This runbook does not authorize production promotion.
