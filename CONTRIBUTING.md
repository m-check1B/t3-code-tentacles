# Contributing

Thanks for helping Tentacles support more ACP harnesses safely.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
For setup help and security-reporting boundaries, see [SUPPORT.md](SUPPORT.md)
and [SECURITY.md](SECURITY.md).

## Good first contributions

- Verify a newer T3 Code, Hermes Agent, or Pi Agent release and report the exact versions.
- Live-verify the shipped systemd user-service path on a Linux distribution.
- Improve diagnostics without exposing tokens, prompts, or local paths.
- Propose a bounded adapter seam for another ACP-compatible agent or client.

## Development

Requirements: Node.js 22+ and no package dependencies.

```bash
npm run check
npm test
```

Keep changes source-independent: do not require a fork of T3 Code or an agent
harness. Add focused tests for concurrency, replay, authentication, provider-map,
ACP relay, and ambiguous-dispatch behavior when those surfaces change.

## Compatibility reports

Include:

- operating system and architecture;
- Node.js, T3 Code, and relevant agent-harness versions;
- the command that failed;
- redacted output with tokens, usernames, paths, prompts, and private project
  names removed.

Never paste bearer tokens, provider secrets, Hermes configuration, or complete
bridge state files into an issue.

## Pull requests

Keep each pull request narrow, explain its security impact, and include the exact
verification commands run. By contributing, you agree that your contribution is
licensed under the MIT License.

Before submitting:

```bash
npm run check
npm test
git diff --check
```

Do not include generated renders, credentials, private prompts, local state, or
machine-specific paths.

## Releases

Version tags use `v<package-version>`. Pushing a matching tag runs checks and
tests, packs the npm-compatible tarball, writes its SHA-256 checksum, and creates
a GitHub Release in `m-check1B/t3-code-tentacles-private` using existing `gh` authentication or the workflow token. The workflow does not publish to npm. It requires an existing matching tag and
a version entry in `CHANGELOG.md`; assets are never overwritten.

## Stack lock (KRA-10845)

`stack-lock/` holds a byte copy of the Agent Jack stack lock (`stack.lock.json`), the agent-jack-3 commit it came from (`FROM`) and the shared checker. CI runs `python3 stack-lock/check-stack-lock.py tentacles`; it fails with one line naming the file to change when the locked Tentacles tag, its commit and version, or `T3_SUPPORT` in `src/t3-support.mjs`, disagrees with the lock. Never edit the copy by hand: change the canonical lock in agent-jack-3 first, then copy it here. The stack bump procedure (order: Tentacles release, agent-jack-3, agent-jack-setup, onboarding; one shared proof; nothing tagged until every lock check passes) is in agent-jack-3 `docs/LOCAL-STACK.md`.
