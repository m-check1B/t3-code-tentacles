---
name: t3-code-bridge
description: Surface Hermes work in T3 Code or originate a user-visible T3 thread.
---

# T3 Code Bridge

Use this bridge when Hermes work should become visible or interactive in the
user's T3 Code cockpit.

Create a new Hermes-backed T3 thread:

```bash
t3-hermes originate \
  --workspace /absolute/workspace/path \
  --title "Short visible title" \
  --message "The opening message and requested outcome"
```

Rules:

- Treat T3 Code as the visible cockpit and Hermes as the execution runtime.
- Use an absolute workspace path.
- Never print or read the bridge bearer token.
- Do not originate a thread in response to another bridge-originated message.
- Preserve the user's existing orchestration authority and evidence system.
