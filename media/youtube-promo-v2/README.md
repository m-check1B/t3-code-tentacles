# Hermes for T3 Code — proof-first promo v2

This is the reproducible HyperFrames source for the 41.6-second v0.1.1 launch
film. It leads with the real public product page, explains the three live bridge
flows, shows the release proof, and closes on the MIT repository.

The initial creative pass was authored through Kimi CLI. Codex performed the
integration and visual QA, repaired the render-audio boundary, upgraded the
pinned HyperFrames version, and independently verified the final artifact.
Every product claim traces to a public capture or real repository output in
[`assets/PROVENANCE.md`](assets/PROVENANCE.md).

## Reproduce

Requirements: Node.js 22+, FFmpeg, and network access for the pinned GSAP file
that HyperFrames compiles into the render bundle.

```bash
./scripts/build-master-audio.sh
npm run check
npm run render -- --quality high --output renders/promo-v2.mp4
npx --yes hyperframes@0.7.101 transcribe \
  renders/promo-v2.mp4 --model small.en --language en --json
./scripts/build-thumbnail.sh renders/promo-v2.mp4
```

The render is intentionally excluded from Git; source media, the deterministic
master mix, composition, captions, thumbnail, and proof transcript are tracked.
The final MP4 is distributed as a GitHub release asset and on YouTube.

## Why the audio is pre-mixed

The first high-quality render used fifteen adjacent `<audio>` elements. The
renderer accepted the composition but dropped the opening narration segment in
the encoded MP4. The source segments remain separately replaceable, while
`scripts/build-master-audio.sh` combines them into one 48 kHz stereo asset. The
composition now exposes exactly one audio element, eliminating extraction-order
ambiguity.

## Accepted artifact proof

- HyperFrames 0.7.101 check: 0 errors, 0 warnings; runtime, motion, and all
  50/50 WCAG contrast samples passed.
- MP4: H.264 + AAC stereo, 1920×1080, 30 fps, 41.633333 seconds.
- Audio: no silence of at least one second at −48 dB; integrated loudness
  −19.83 LUFS and true peak −1.64 dBTP.
- Transcript: 88 words; starts with `Hermes` at 0.1s and ends with
  `contribute.` after 41s.
- Master-mix SHA-256:
  `cd625d914b8fdd80b81ea0745414d64e7c3b5b796886fe2c0ed543ba9c3a101b`
  (identical across two consecutive builds).
- Final MP4 SHA-256:
  `bcf5aca4aa3bcfda77831bd6754d31a35962dd05ff789283c426fa06d142d676`.
- Thumbnail SHA-256:
  `f7d0c060d543cabc61008d7396492234fd66d173864525eac9750c795ee731b4`.

The previous render is not accepted because it omitted the first narration
segment even though the visual composition completed successfully. The
transcript gate is therefore part of release proof, not optional polish.
