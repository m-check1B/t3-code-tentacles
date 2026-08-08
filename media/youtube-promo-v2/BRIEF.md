---
workflow: product-launch-video
flow: automation
storyboard: no
message: "Hermes Agent runs inside T3 Code through one standalone, independently reviewed bridge—and the proof is already public."
destination: youtube
aspect: 1920x1080
language: en
audience: "AI builders, agent-tool maintainers, open-source developers, and technical product leaders"
length: 38s
angle: "proof-first launch: real public artifacts lead, mechanism and three flows follow, open-source invitation closes"
narration: minimal
---

## Intent

Upgrade the v0.1.0 typography-only cut into a proof-first launch film for
Hermes for T3 Code v0.1.1. The first ten seconds must answer what it is, why
it matters, and that it already works — using real public artifacts (the live
launch page, its proof band, its CTA) as evidence plates, with deterministic
Broadside motion graphics connecting them. The founder/AI-execution story is
secondary proof at the close, not the lead.

## Assets

- `assets/site/plate-hero.png` — live launch-page hero (OPEN SOURCE · MIT · V0.1.1).
- `assets/site/plate-flow-diagram.png` — live "One cockpit. Two directions." diagram + three flow cards.
- `assets/site/plate-proof-band.png` — live "Proof before promotion." band: 39/39 · 3 · 0 · 2×, tested-on line.
- `assets/site/plate-receipt.png` — live "The product is also the receipt." section.
- `assets/site/plate-cta.png` — live closing section with the github.com/m-check1B/t3-hermes-bridge button.
- `assets/proof/test-run-v0.1.1.txt` — real `npm test` TAP summary on the v0.1.1 checkout (39 pass / 0 fail).
- `https://m-check1b.com/hermes-for-t3-code/` — production launch page (capture tree in `capture/live/`).
- `https://github.com/m-check1B/t3-hermes-bridge` — public code and v0.1.1 release.

## Customizations

- Keep the Broadside system (ink black, white, electric blue #0055FF, proof green #20C55A)
  but add a second visual register: real white site plates cut against the black field.
- Show all three flows: T3 → Hermes over ACP, Hermes → a visible T3 thread, any thread → `@hermes`.
- Durable proof wording: "independently reviewed", "39/39 tests on v0.1.1", "verified on macOS".
  Never imply the two post-audit main-branch tests ship in v0.1.1; never claim Windows/Linux support.
- Every claim on screen traces to a public artifact or real repo output (see `assets/PROVENANCE.md`).

## Notes

- Exact product name: Hermes for T3 Code. Standalone MIT bridge; no fork of T3 Code or Hermes Agent.
- Independent community project; never imply endorsement by T3 Code, Ping Labs,
  Hermes Agent, Nous Research, the ACP project, xAI, HeyGen, or any model vendor.
- No private paths, credentials, local absolute paths, or fabricated product UI in any frame.
- Narration is Kokoro `am_michael` (offline). The per-frame source segments are
  retained for replacement, then deterministically pre-mixed with local SFX into
  one render-safe master track.
