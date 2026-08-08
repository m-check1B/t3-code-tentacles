# 35-second Launch Film

This directory is the reproducible HyperFrames source for the first Hermes for
T3 Code launch film. It contains the exact storyboard, script, narration WAVs,
word timings, thumbnail, five frame compositions, captions, and assembled root
timeline used for the public render.

## Toolchain

- Node.js 22
- HyperFrames 0.7.99 (pinned in `package.json`)
- 1920×1080, 30 fps
- Kokoro `am_michael` offline narration
- no background music or sound effects

## Verify

```bash
npm run check
```

The accepted source passes HyperFrames lint, browser runtime, layout, motion,
and WCAG contrast checks. Two overlap warnings at frame transitions are
intentional cross-frame transition compositing; the station-world overflow is
the bounded virtual-camera canvas.

## Render

```bash
npx hyperframes@0.7.99 render \
  --skill=product-launch-video \
  --quality high \
  --output renders/video.mp4
```

Expected artifact characteristics:

- H.264 video, 1920×1080 at 30 fps
- AAC stereo audio at 48 kHz
- approximately 35.03 seconds

The MP4 is intentionally excluded from Git history and attached to the GitHub
release. The narration WAVs remain in source control so the public render does
not depend on recreating a particular TTS performance.
