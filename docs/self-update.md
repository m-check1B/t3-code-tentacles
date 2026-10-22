# Standalone self-update (KRA-8371, KRA-8367 A3)

This page covers standalone Tentacles: the CLI installs on paired computers.
Desktop-bundled Tentacles never uses this path; it follows the signed desktop
update (KRA-8367 A2).

**Status:** the code ships fail-closed. `src/updater/pinned.mjs` has no public
keys, so every install is refused with `updater_unconfigured`. The release
workflow also refuses to build (`scripts/release/assert-pinned-keys.mjs`). Real
keys arrive only by a Founder-approved PR, after GUARDIAN has audited the signer
script and the vault item setup on the exact bytes.

## Trust model

- **Compiled in:** the base URL (`UPDATE_BASE_URL`), the two Ed25519 public keys
  (current and next), and `MIN_MANIFEST_SERIAL`. Nothing the server or the RPC
  sends can change them.
- **Signed manifest:** the device reads `tentacles-manifest/v1`, which holds
  `{serial, expires, versions[], securityFloor, recommended}`. Each entry is
  `{version, commit, sha256, legacyRpc, t3Contract, minDesktop, minApi, needs, changelog}`.
  The envelope `tentacles-manifest-envelope/v1` signs the exact payload bytes.
- **Replay:** `serial` must be greater than the last accepted serial (persisted
  in `state/updater.json`) and at least `MIN_MANIFEST_SERIAL`. A byte-identical
  re-read of the same manifest is allowed.
- **Freeze:** once `expires` has passed, nothing is installed or downgraded. The
  update reports `manifest_expired`.
- **Selection (U5):** "Update now" and the server hint carry no version, URL or
  hash. The device applies `recommended`.
  - It never installs below `securityFloor`.
  - It never steps down from a version that is listed and at or above the floor.

## On-disk layout (user space only)

```
~/.tentacles/
  versions/<v>/   verified, extracted package trees
  current         symlink -> versions/<v> (atomic rename switch)
  hold            any file here blocks every version change
  state/          updater.json, events.jsonl, starts.json, restart-request/ack
  updater/        the updater, installed OUTSIDE the swapped tree
  tmp/            same-filesystem staging
```

No sudo is used, no OS permission is requested, and no unit is created or
changed. The updater never touches T3 (it never runs `t3 update`), `~/.claude`,
`~/.codex` or `~/.t3`.

## Install sequence (U4)

1. Fetch the manifest and verify its signature, schema, serial and expiry.
2. Fetch `v<version>/tentacles-<version>.tgz` and check its sha256 against the
   signed entry **before** parsing a single tar entry.
3. Extract into `tmp/stage-*/tree`. The extractor refuses absolute paths, `..`,
   entries outside `package/`, symlinks with absolute or `..` targets, writes
   through a symlink, hardlinks to anything other than a file already extracted
   from the package, duplicates, devices, FIFOs and unknown entry types. It
   drops setuid, setgid, sticky and group/other write bits.
4. Check that `package.json` has the manifest version, then write
   `bin/node-path` and fsync.
5. Rename the tree to `versions/<v>`, then rename a fresh symlink over `current`.

## Consent, idle and Undo

- **Consent card:** an entry with a non-empty `needs` (a new permission or unit)
  is never applied automatically. It becomes `tentacles_update_needs_consent`.
- **Idle only:** the update is applied only when `observe` reports no active
  turn. Unknown counts as busy.
- **Notice:** after a successful update the device emits `tentacles_updated`
  with `undoAvailable`. Customer computers get the same notice.
- **Undo** (`tentacles-updater undo`) goes only to the previous version, and
  only when that version:
  - is still on disk,
  - is at or above the floor of a fresh, unexpired manifest, and
  - is still listed in that manifest.

## Health check and rollback

After the switch, the launcher restarts its child. Within 60 s:

1. `doctor --json` must exit 0.
2. The pairer must write `paired` presence after the switch.
3. `observe` must answer. This is the local source of the `seats` RPC.

If any step fails, the device switches back, restarts and reports
`tentacles_update_rolled_back` with a reason code.

## Holds (U6)

- A hold blocks auto-apply, "Update now" and Undo. A held computer does not
  even fetch the manifest.
- **Crash guard:** three starts that die within 60 s, all inside 10 minutes,
  pin the previous version (when it is on disk, at or above the last verified
  floor, and listed). The guard then **adds** a hold (`crash-guard <v> <time>`).
  - If a hold already exists, the guard changes neither the version nor the
    hold text.
- **No code removes a hold.** A person lifts a hold by deleting the file.
- **Lifting the Pro hold `0.4.1 KRA-6911` needs the Founder's OK.** Any other
  hold needs the Founder, or a Senior with the Founder's OK.

## Events (U7)

`state/events.jsonl` keeps the last 50 events. The existing `doctor-status` RPC
reply gains a `selfUpdate` block (the last 10 events, current and previous
versions, held flag, hold ticket and hold version), but only when the updater
is installed. The 0.4.1 legacy RPC list is unchanged.

- An event carries `{schema, code, computerId, from, to, reason, undoAvailable, at}`
  and nothing else.
- Events never carry paths, user names, hold text or changelog.
- A computer id that contains the local user name is refused.

## Operator steps (per computer, explicit)

1. `tentacles self-update install-updater` copies the updater into
   `~/.tentacles/updater`. Run it again only for an audited updater change;
   auto-update never replaces the updater.
2. Point the **existing** user service at
   `node ~/.tentacles/updater/cli.mjs launch -- pair ...`. This is a one-time
   change to the existing unit and is out of scope for this PR.
3. `tentacles self-update now`, `undo` and `status` run the installed updater.

## Signing (U1, U2): `scripts/release/sign-manifest.mjs`

The release captain calls the script. The script alone decides whether to sign.

```
node scripts/release/sign-manifest.mjs --draft draft.json --previous signed-current.json \
  --log signing.log --out signed-next.json [--founder-ok KRA-NNNN:ref]
```

**Provenance.** Every new version entry needs all of these:

- The protected branch `jack/0.4.1-maintenance` is reported as protected.
- The commit is the merge commit of a merged PR into that branch, and an
  ancestor of the branch tip.
- The PR has a `B3 APPROVE|CLEAR|PASS` comment that cites the PR head sha.
- A clean rebuild (`git archive` + `npm pack --ignore-scripts`) and the
  published release asset both match the entry's sha256.
- The commit's `package.json` version matches the entry, and so do its
  `REMOTE_RPC_METHODS` and its two pinned keys.

**Policy.**

- `serial` is the previous serial + 1, and is above the last serial in the
  signing log.
- `expires` is at most 45 days ahead.
- Entries that were already signed must be byte-identical.
- The previous manifest must verify under the signing key.

**Founder OK** (`--founder-ok`) is required for:

- lowering `securityFloor` or `recommended`;
- any new version below `recommended`;
- any change of the pinned keys;
- the first manifest.

**Key custody.**

- The private key is fetched only after every check has passed, from
  `~/bin/tentacles-signer-key-source` by the exact item name
  `tentacles-manifest-signing-key-current`.
- It arrives on a pipe and is held in memory only. It never appears in argv,
  env, on disk or on stdout.
- `tentacles-manifest-signing-key-next` is never fetched by this script.

**Outputs.** The script writes the signed envelope with `wx`, appends one
hash-chained line to the log, and prints the Linear comment body for the
captain to post.
