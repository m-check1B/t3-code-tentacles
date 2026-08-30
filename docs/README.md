# Tentacles documentation index

Status: active

Owner: Tentacles maintainers

Last reviewed: 2026-08-29

The public product name is **Tentacles**. The public command is `tentacles`.
This repository owns the standalone provider-neutral ACP bridge,
its adapter contracts, packaging, compatibility evidence, component security,
and repository history. It connects independent systems without becoming their
product or control-plane authority.

Start here: clone, issue a local T3 token, run `tentacles doctor`, then originate
a lab doctor marks `ready`. Doctor is this-machine truth. Advertised is not
proved. The README lab matrix records which labs have a fresh e2e proof.

## Repository-owned documentation

- Purpose, lab matrix, setup, operations, and uninstall: [README.md](../README.md)
- Agent contribution and live-runtime boundary: [AGENTS.md](../AGENTS.md)
- Component architecture: [architecture.md](architecture.md)
- Outbound remote-pairing protocol: [remote-pairing.md](remote-pairing.md)
- Security policy: [SECURITY.md](../SECURITY.md)
- Contribution workflow: [CONTRIBUTING.md](../CONTRIBUTING.md)
- Synthetic demo runbook: [demo.md](demo.md)
- Release and compatibility history: [release records](releases/v0.1.1.md)
- Build decision/history narrative: [build story](build-story.md)
- Support boundary: [SUPPORT.md](../SUPPORT.md)

Git history owns decisions and evidence for this bridge component only.

## Product-category boundary

This repository owns no customer product direction, product-wide architecture,
customer product contract, product-wide runbook, product security authority,
product decision, or product history. Those categories remain with the
relevant upstream systems. A historical optional T3 UI patch is separately
maintained in
[`m-check1B/t3code-hermes-ui`](https://github.com/m-check1B/t3code-hermes-ui).

T3 Agent Bridge carries no management, provider, model, access, deployment, or
customer authority. Live installation and service lifecycle actions require a
separate reviewed operational packet.
