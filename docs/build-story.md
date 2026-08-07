# Build Story

## The idea

Matej Havlin proposed using T3 Code as the polished multi-agent UI for an
already-installed Hermes Agent: one app with multiple CLIs and mobile access,
Hermes orchestrating behind the scenes, `@hermes` callable from any thread, and
Hermes able to originate threads when work needs attention.

The key constraint was practical: build a standalone bridge by “gluing both
ends,” not by maintaining forks of either upstream project.

## The execution loop

1. The founder described the product and approved public execution.
2. Hermes/Orbit held the outcome and launch priority.
3. Codex inspected the local T3 and Hermes contracts and implemented the bridge.
4. Independent adversarial review found concrete security and reliability
   defects.
5. The implementation was corrected and retested after each finding.
6. Real local canaries proved both directions and the background mention route.

## What review changed

Early review rejected the prototype until it:

- prevented bearer forwarding through redirects or non-loopback origins;
- validated token ownership, file type, permissions, and size;
- waited for T3's asynchronous command projections;
- persisted pending intent before dispatch and locked concurrent watchers;
- replaced an evicting 10,000-message dedupe window with durable per-thread
  cursors and bounded fallback retention;
- refused provider instance collisions and ownership ambiguity;
- bounded HTTP responses, WebSocket frames, and request time;
- throttled the background service.

The released design includes those corrections. This document is not a claim
that AI execution is infallible; it is evidence that orchestration plus
independent verification can turn a rough idea into a stronger public artifact.
