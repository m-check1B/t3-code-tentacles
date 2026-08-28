# Tentacles documentation index

Status: active

Owner: TBA-One integration engineering

Last reviewed: 2026-08-28

The public product name is **Tentacles**. This repository owns the standalone provider-neutral ACP bridge,
its adapter contracts, packaging, compatibility evidence, component security,
and repository history. It connects independent systems without becoming their
product or control-plane authority.

## Repository-owned documentation

- Purpose, compatibility, setup, operations, and uninstall: [README.md](../README.md)
- Agent contribution and live-runtime boundary: [AGENTS.md](../AGENTS.md)
- Component architecture: [architecture.md](architecture.md)
- Security policy: [SECURITY.md](../SECURITY.md)
- Contribution workflow: [CONTRIBUTING.md](../CONTRIBUTING.md)
- Synthetic demo runbook: [demo.md](demo.md)
- Release and compatibility guidance: [launch kit](launch-kit.md) and [release records](releases/v0.1.1.md)
- Build decision/history narrative: [build story](build-story.md)
- Support boundary: [SUPPORT.md](../SUPPORT.md)

Git history owns decisions and evidence for this bridge component only.

## Product-category boundary

This repository owns no customer product direction, product-wide architecture,
customer product contract, product-wide runbook, product security authority,
product decision, or product history. Those seven categories remain with the
relevant upstream systems and TBA-One product repositories. AgentJack product
authority is at
[`m-check1B/agentjack`](https://github.com/m-check1B/agentjack/tree/aa32bfa0a01af5ff776f491f5d8af73d38d3c50a/docs);
the maintained T3 UI integration boundary is separately held by
[`m-check1B/t3code-hermes-ui`](https://github.com/m-check1B/t3code-hermes-ui/tree/85326b65e7451de50e59b23287bb5a5c900c3a73).

T3 Agent Bridge carries no management, provider, model, access, deployment, or
customer authority. Live installation and service lifecycle actions require a
separate reviewed operational packet.
