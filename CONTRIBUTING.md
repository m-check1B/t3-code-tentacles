# Contributing

Thanks for helping Tentacles support more ACP harnesses safely.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
For setup help and security-reporting boundaries, see [SUPPORT.md](SUPPORT.md)
and [SECURITY.md](SECURITY.md).

## Good first contributions

- Verify a newer T3 Code, Hermes Agent, or Pi Agent release and report the exact versions.
- Add Linux service packaging.
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
or updates the GitHub release. The workflow does not publish to npm.
