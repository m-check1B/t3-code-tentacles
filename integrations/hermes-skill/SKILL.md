---
name: t3-code-bridge
description: Operate local T3 Code from a Hermes chair through Tentacles, including install, doctor, explicit instance/model/budget origination, full-access continuation, observation, and stop.
---

# T3 Code Bridge

Use this compatibility skill when Hermes must operate the user's T3 Code through
Tentacles instead of driving the T3 GUI. The canonical full workflow is
[`../tentacles-operate-skill/SKILL.md`](../tentacles-operate-skill/SKILL.md).
Keep that skill with this compatibility entry when copying the integration.
A Hermes chair hires labs through Tentacles; the chair is not itself the lab.

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
models. Keep these two lab identities explicit:

| Lab | `--instance` | `--model` | Meaning |
| --- | --- | --- | --- |
| Grok Code | `grok` | `grok-4.6` | The Grok Code hire path. |
| Hermes-as-lab | `hermes` | A model advertised by doctor, when ready | Its own lab, never a route to another lab. |

- Hermes-as-lab is a real lab worker at the same layer as codex, grok, pi, and the rest. It is its own lab.
- It is not Grok. It is not a proxy for any other lab. Never hire `--instance hermes` when you meant grok, codex, claudeAgent, pi, kimi, or deepseek.
- Hiring `--instance hermes` only makes sense when the chair needs Hermes's GBrain and memory.
- In our setup the chair already has direct GBrain and memory, so do not hire Hermes-as-lab as a worker. Doctor not-ready is extra reason to skip it here, not a reason to route another lab through it.

If you want Grok Code and are about to type `--instance hermes`, stop. Originate
`--instance grok` instead.

Then originate with every selection explicit. This Grok Code example follows
the canonical workflow:

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
  --instance grok \
  --model grok-4.6 \
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
- Keep work in the same workspace tree serial. Do not originate a second worker
  into that tree while the first worker is active.
- Never print or read bearer, provider, OAuth, or OpenRouter tokens.
- Every originate and every non-empty continue is `full-access`; omitted mode
  fails closed under POL-036.
- Do not originate a thread in response to another bridge-originated message.
- `t3-hermes-bridge` and `~/.local/state/t3-hermes-bridge/` are Tentacles state,
  not a Grok Code hire path. Never substitute a `t3-hermes originate` command.
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
