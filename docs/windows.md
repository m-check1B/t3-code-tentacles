# Windows (preview, KRA-6491)

Tentacles' pairer and chair commands are being made to run natively on
Windows 10/11 x64. **No Windows run has been proved yet.** Everything below is
unit-tested on POSIX CI with simulated Windows inputs; each `TODO-WINVM` line
is the exact check still needed on a real Windows VM.

## What changes on Windows

| Area | macOS / Linux | Windows |
| --- | --- | --- |
| State directory | `~/.local/state/t3-hermes-bridge` | `%LOCALAPPDATA%\t3-hermes-bridge` |
| Private files | owner uid and mode `0600` / `0700` | per-user profile ACL; mode bits are not checked (Windows reports `0666`) |
| Executable lookup | exact name on `PATH` | `PATH` plus `PATHEXT`, limited to `.exe`, `.cmd`, `.bat` |
| Launcher | `bin/t3-agent-bridge` (POSIX `sh`) | `bin\tentacles.cmd`, or `node <checkout>\src\cli.mjs` |
| Process stop | `SIGTERM`, then `SIGKILL` | `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F` (whole tree) |

Symlinks and junctions are still refused for state, offers and Local Talk
scratch. `lstat` reports both as symbolic links.

## Install (native)

```bat
git clone https://github.com/m-check1B/t3-code-tentacles.git
cd t3-code-tentacles
bin\tentacles.cmd --version
```

`npm link` creates a `tentacles.cmd` shim that calls `/bin/sh`, so it does not
work on Windows. Jack desktop doesn't use that shim. It starts
`node.exe <checkout>\src\cli.mjs pair …` directly.

`service`, `install-service` and the watchdog stay macOS/Linux-only.

## WSL fallback

If a lab CLI only works inside WSL, run Tentacles **and** T3 Code inside the
same WSL distribution and pair from there. Do not mix a Windows-native T3 with
WSL lab binaries: paths, signals and PATH lookup differ across that boundary.

## TODO-WINVM checks

1. `bin\tentacles.cmd --version` prints the package version from `cmd.exe`
   and from PowerShell, in a checkout path that contains a space.
2. After the first `tentacles pair`, `icacls "%LOCALAPPDATA%\t3-hermes-bridge"`
   lists only the user, `SYSTEM` and `Administrators`, with no `Users`,
   `Everyone` or `Authenticated Users` entry.
3. `pair-presence.json` is rewritten atomically while Jack polls it. Run 200
   lease renewals with no `EPERM`/`EBUSY` from `renameSync` (Windows Defender
   or the indexer can hold the target open).
4. `resolveExecutable("grok")` finds `grok.exe`. If Grok installs only
   `grok.cmd`, the ACP proxy (`spawn`, `shell: false`) fails with `EINVAL` on
   Node 20.12 and later. That needs a `cmd.exe /d /s /c` plan before the Grok
   lab can be marked ready on Windows.
5. `ensureLocalTalkWorkspace` accepts
   `%USERPROFILE%\.jack-local-scratch\jack-talk\<32 hex>\<32 hex>` and refuses
   it when `.jack-local-scratch` is a junction (`mklink /J`).
6. `taskkill /T /F` on the pairer leaves no `node.exe` child behind
   (`tasklist /FI "IMAGENAME eq node.exe"`).
