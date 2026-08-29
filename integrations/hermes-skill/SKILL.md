---
name: t3-code-bridge
description: Operate local T3 Code from a Hermes chair through Tentacles, including doctor, explicit instance/model/budget origination, and full-access continuation.
---

# T3 Code Bridge

Use this compatibility skill when Hermes must operate the user's T3 Code through
Tentacles instead of driving the T3 GUI.

Inspect this machine first:

```bash
tentacles doctor
```

Choose a ready instance from `codex`, `grok`, `claudeAgent`, `pi`, `kimi`,
`deepseek`, `hermes`, `opencode`, or `cursor`, plus one of its advertised
models. Then originate with every selection explicit:

```bash
tentacles originate \
  --workspace /absolute/workspace/path \
  --title "Short visible title" \
  --message "The opening message and requested outcome" \
  --instance hermes \
  --model openai-codex:gpt-5.6-sol \
  --budget high \
  --runtime-mode full-access
```

Thought budget is `low`, `medium`, or `high`. Tentacles maps it to
`reasoningEffort` for Codex and Hermes `openai-codex:*`, and to `effort` for
`claudeAgent`. Do not invent option IDs for other instances.

Continue only an existing successful thread, with non-empty text:

```bash
tentacles act --intent '{"action":"thread.continue","threadId":"<thread-id>","text":"Continue with the next concrete step.","runtimeMode":"full-access"}'
```

Rules:

- Treat T3 Code as the visible cockpit and Hermes as the chair.
- Use an absolute workspace path.
- Never print or read bearer, provider, OAuth, or OpenRouter tokens.
- Every originate and every non-empty continue is `full-access`; omitted mode
  fails closed under POL-036.
- Do not originate a thread in response to another bridge-originated message.
- Record thread and command IDs. Do not claim a continue proof after a failed or
  unanswered originate.
