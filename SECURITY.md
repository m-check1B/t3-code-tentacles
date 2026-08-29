# Security Policy

## Supported versions

Security fixes are applied to the latest released version. Version 0.3.0 is the
currently supported line.

## Reporting a vulnerability

Email private reports to `axis@verduona.com` with the subject
`SECURITY: tentacles`. Do not open a public issue containing a working
exploit, bearer token, private path, provider configuration, or user prompt.

Include the affected version, impact, minimal reproduction, and any proposed
mitigation. You should receive an acknowledgement within five business days.

## Local trust model

This bridge is intended for one user's local machine. It accepts only loopback
T3/Hermes origins, reads a private T3 bearer from an owner-controlled `0600`
regular file, rejects redirects, and refuses to replace or remove a provider it
does not own. It does not make T3 Code or Hermes remotely accessible.

The macOS service is namespaced by explicit filesystem-safe `--profile` and
`--instance` values. It fails closed on foreign files, symlinks, ownership
changes, oversized plists, and missing identity instead of selecting a profile
implicitly. Installation stages and plist-lints an owned private LaunchAgent,
uses an immutable verified runtime snapshot outside the checkout, verifies the
new job after bootstrap, and rolls back the prior owned plist/runtime reference
if activation fails. It never deletes a legacy service implicitly.

The service persists only non-secret operational configuration. Bearer values,
authorization headers, WebSocket tickets, and routed prompts are excluded from
the plist, runtime manifest, service config, and structured watcher status.
Status inspects token metadata only; it never reads or prints the token. Per-
service directories and status/config files are private (`0700`/`0600`), and the
watcher uses a bounded structured-status contract instead of public unbounded
log files.

Treat Hermes profiles and Pi Agent as privileged local processes: the bridge
does not reduce or expand the filesystem, shell, network, or tool permissions
already granted to the selected runtime.

Pi authentication remains exclusively in Pi's normal local configuration. The
Pi provider stores only non-secret absolute executable, provider, initial model,
and ownership metadata in T3. The ACP relay never logs protocol payloads, does
not forward T3's transport authentication request to Pi, bounds JSON-line and
pending-request memory, exposes only models belonging to the explicitly selected
Pi provider, and passes T3-selected bare model IDs to Pi's native
`session/set_model` method.

The Hermes ACP relay never logs protocol payloads. When T3 requests
`openai-codex` and Codex credentials are missing, the relay returns a named
`codex_auth_missing` JSON-RPC error instead of letting Hermes construct a
different provider. Doctor reports that fail-closed state as presence only; it
never prints token values. After Hermes accepts a provider-qualified model
switch, the relay withholds success until Hermes' structured session state
reports that exact provider and model. It returns `provider_identity_mismatch`
and blocks the prompt when Hermes binds a profile fallback instead. Hermes'
bare `grok-build` alias is also exact-identity gated, so it cannot fall through
to DeepSeek merely because the requested ID lacks a provider prefix.
