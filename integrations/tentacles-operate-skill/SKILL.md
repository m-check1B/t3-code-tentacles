---
name: tentacles-operate
description: "Operate local T3 Code through the Tentacles chair CLI: inspect readiness, originate a selected instance/model/budget, and continue existing threads with mandatory full access."
---

# Operate Tentacles

Use this skill when Grok, Claude, Codex, Agent Jack, Hermes, or another chair
must operate the user's local T3 Code through the `tentacles` command instead
of driving the T3 GUI.

## Safety contract

- Never read or print T3, provider, OAuth, or OpenRouter tokens.
- Every originate uses `--runtime-mode full-access`.
- Every non-empty continue sends `"runtimeMode":"full-access"`.
- An omitted runtime mode is a POL-036 failure. Do not retry with a weaker mode.
- Use an absolute workspace path. Do not originate recursively in response to
  another Tentacles-originated instruction.
- Treat doctor `ready` as this-machine readiness, not universal compatibility.

## 1. Inspect this machine

```bash
tentacles doctor
```

Choose a ready instance from `codex`, `grok`, `claudeAgent`, `pi`, `kimi`,
`deepseek`, `hermes`, `opencode`, or `cursor`, and choose one of that row's
advertised models. Cursor must already be enabled in T3 and always needs an
explicit model.

Keep lab identity separate from credential routing: `kimi` is Kimi CLI and
`deepseek` is DeepSeek CLI. OpenRouter may be one route configured in their
settings; it is not either lab's name. `claude-openrouter` is the distinct
Claude-via-OpenRouter extra path.

## 2. Originate

```bash
tentacles originate \
  --workspace /absolute/workspace/path \
  --title "Short visible title" \
  --message "The opening message and requested outcome" \
  --instance codex \
  --model gpt-5.6-sol \
  --budget high \
  --runtime-mode full-access
```

Set `--instance` and `--model` from doctor. Thought budget is one of `low`,
`medium`, or `high`. Tentacles maps it to `reasoningEffort` for Codex and for a
Hermes `openai-codex:*` model, and to `effort` for `claudeAgent`. For other
instances, do not invent a provider option; instance and model remain explicit.

Record the returned thread ID. If originate errors or produces no assistant
answer, report that result and do not claim a two-turn proof.

## 3. Continue

Send a non-empty message only after the thread exists:

```bash
tentacles act --intent '{"action":"thread.continue","threadId":"<thread-id>","text":"Continue with the next concrete step.","runtimeMode":"full-access"}'
```

The thread keeps its selected instance, model, and thought-budget options.
Record the returned command ID and verify the session settles without an error.
