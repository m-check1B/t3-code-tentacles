# Support

Tentacles is an early, community-maintained integration. There is no
commercial support contract or guaranteed response time.

## Before opening an issue

1. Read the [five-minute setup](README.md#five-minute-setup) and run
   `tentacles doctor`. Doctor is this-machine truth; advertised is not proved.
2. Record exact versions for Node.js, T3 Code, the affected lab runtime,
   operating system, and architecture. Include the doctor row for the failed
   lab (`ready` / `status` / normalized `code`).
3. Search [existing issues](https://github.com/m-check1B/t3-code-tentacles/issues)
   and the [Discussions](https://github.com/m-check1B/t3-code-tentacles/discussions).
4. Remove bearer tokens, authorization headers, usernames, local paths, prompts,
   private project names, and complete state files from all output.

Use a structured issue for reproducible bugs or feature requests. Use
Discussions for setup questions, compatibility reports, adapter ideas, and
design conversations.

## Security reports

Do not disclose a vulnerability in a public issue or Discussion. Follow the
private process in [SECURITY.md](SECURITY.md).

## Compatibility

The macOS service path is live-verified. Tentacles also ships a unit-tested
systemd user-service path for Linux, which is not yet live-verified on a real
distribution. Windows has no native service package. Compatibility reports are
welcome when they include exact versions and redacted diagnostics.
