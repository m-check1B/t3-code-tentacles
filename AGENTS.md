# Agent contribution contract

Tentacles is a provider-neutral ACP integration component. Read
[docs/README.md](docs/README.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[SECURITY.md](SECURITY.md) before changing it.

## Boundaries

- The bridge does not own T3 Code, Hermes Agent, Pi Agent, AgentJack, model
  providers, or their product documentation.
- Preserve loopback-only origins, owner-controlled token files, provider and
  service ownership markers, fail-closed routing, and replay/correlation gates.
- Never commit bearer values, auth headers, WebSocket tickets, provider
  credentials, routed prompts, customer data, or live state.
- Source and documentation changes do not authorize installing, removing,
  restarting, booting out, or reconfiguring the live bridge, T3 Code, Hermes,
  its watchdog, or any LaunchAgent.
- Do not change runtime profiles, models, permissions, provider state, token
  files, or active watcher state during ordinary repository work.
- Upstream compatibility claims require exact version and live-proof evidence;
  keep unverified combinations explicit.

## Verification

Run:

```bash
npm test
npm run check
git diff --check
```

Use synthetic, isolated fixtures. Live bidirectional or service tests are
separate operational actions and must preserve the active installation.
