# Asset provenance — youtube-promo-v2

Every asset in this project is either (a) a capture of a real public artifact,
(b) real output from this repository, or (c) generated locally with offline
tools. No fabricated UI, no stock, no paid API output.

## Real public captures (live site, 2026-08-08)

Source URL: `https://m-check1b.com/hermes-for-t3-code/` (public launch page,
shows OPEN SOURCE · MIT · V0.1.1 and the 39/39 proof band at capture time).

Captured with: `npx hyperframes@0.7.99 capture "<URL>" -o ./capture/live --json`
(full capture tree, DOM, tokens and meta preserved under `capture/live/`).

- `assets/site/site-full-page-live.png` — 1920×4201 full-page screenshot, unmodified copy of `capture/live/screenshots/full-page.png`.
- `assets/site/site-hero-viewport-live.png` — 1920×1080 above-the-fold viewport shot, unmodified copy of `capture/live/screenshots/scroll-000.png`.
- `assets/site/plate-hero.png` — crop `1920x800+0+185` of the full-page shot (hero: MIT·V0.1.1 badge, headline, subhead, CTAs). ffmpeg crop only, no edits.
- `assets/site/plate-flow-diagram.png` — crop `1920x700+0+1100` ("One cockpit. Two directions." T3/Hermes diagram + three flow cards).
- `assets/site/plate-proof-band.png` — crop `1920x660+0+1820` ("Proof before promotion." 39/39 · 3 · 0 · 2× band).
- `assets/site/plate-receipt.png` — crop `1920x560+0+2520` ("The product is also the receipt." section).
- `assets/site/plate-cta.png` — crop `1920x560+0+3180` ("A reusable bidirectional ACP bridge tomorrow." + github.com/m-check1B/t3-hermes-bridge button).

## Real repository output

- `assets/proof/test-run-v0.1.1.txt` — real `npm test` tail (TAP summary:
  `# tests 39`, `# pass 39`, `# fail 0`) run 2026-08-08 on the v0.1.1 release
  checkout (merge commit `3d40fff`, release/v0.1.1). Quoted verbatim in Frame 4.

## Generated locally (offline)

- `assets/voice/01..05.wav` — Kokoro-82M TTS (`am_michael`, en-us) via
  `npx hyperframes@0.7.99 tts`, offline model. Narration text in `SCRIPT.md`;
  replaceable later with xAI TTS (lines are per-frame segments).
- `assets/sfx/*.wav` — synthesized with local ffmpeg (sine/noise only); see
  README.md for the exact commands. No samples, no libraries.
- `assets/audio/master-mix.wav` — deterministic 48 kHz stereo mix of the five
  narration segments and ten local SFX cues. Built by
  `scripts/build-master-audio.sh`; the composition references this single track
  so adjacent clips cannot be reordered or dropped during render extraction.
- `assets/audio/transcript.json` — `small.en` verification transcript generated
  from the master mix. It contains all 88 words, from the opening `Hermes` to
  the closing `contribute.`

## Copied scaffold (from media/youtube-v0.1.0, same repo)

- `package.json`, `hyperframes.json`, `AGENTS.md`, `frame.md`,
  `.hyperframes/caption-skin.html` — the Broadside brand/design system and the
  pinned HyperFrames toolchain. Content documents (BRIEF/STORYBOARD/SCRIPT),
  all frame HTML, and the assembled index are new for v2.

The project pin was advanced from HyperFrames 0.7.99 to 0.7.101 after the
creative pass; `npm run check` passed on the final source after that upgrade.
