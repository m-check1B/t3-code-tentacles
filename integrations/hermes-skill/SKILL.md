---
name: t3-code-bridge
description: Operate local T3 Code from a Hermes chair through Tentacles, including install, doctor, explicit instance/model/budget origination, full-access continuation, observation, and stop.
---

# T3 Code Bridge

Use this compatibility skill when Hermes must operate the user's T3 Code through
Tentacles instead of driving the T3 GUI. The canonical full workflow is
[`../tentacles-operate-skill/SKILL.md`](../tentacles-operate-skill/SKILL.md).
Keep that skill with this compatibility entry when copying the integration.

Clone and link the public command if it is not installed:

```bash
git clone https://github.com/m-check1B/t3-code-tentacles.git
cd t3-code-tentacles
npm link
```

Inspect this machine first:

```bash
tentacles doctor
```

Choose a ready instance from `codex`, `grok`, `claudeAgent`, `pi`, `kimi`,
`deepseek`, `hermes`, `opencode`, or `cursor`, plus one of its advertised
models. Then originate with every selection explicit:

The T3-native instance IDs are `codex`, `claudeAgent`, `grok`, `opencode`, and
`cursor`. Tentacles-additive instance IDs are `claude-openrouter`, `kimi`,
`deepseek`, `hermes`, and `pi`.

Keep lab identity separate from credential routing: `kimi` is Kimi CLI and
`deepseek` is DeepSeek CLI. OpenRouter may be one route configured in their
settings; it is not either lab's name. `claude-openrouter` is the distinct
Claude-via-OpenRouter extra path.

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

Inspect projected state and stop an existing thread when requested:

```bash
tentacles observe
tentacles act --intent '{"action":"thread.stop","threadId":"<thread-id>"}'
tentacles observe
```

Stopping is not deleting or archiving. Do not perform either without a separate
request.
