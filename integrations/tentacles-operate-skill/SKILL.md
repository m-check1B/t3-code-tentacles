---
name: tentacles-operate
description: "Install and operate local T3 Code through the Tentacles chair CLI: doctor, explicit instance/model/budget origination, full-access continuation, observation, and safe stop."
---

# Operate Tentacles

Use this skill when Grok, Claude, Codex, Agent Jack, Hermes, or another chair
must operate the user's local T3 Code through the `tentacles` command instead
of driving the T3 GUI.

## Safety contract

- Never read or print T3, provider, or OAuth tokens.
- Every originate uses `--runtime-mode full-access`.
- Every non-empty continue sends `"runtimeMode":"full-access"`.
- An omitted runtime mode is a POL-036 failure. Do not retry with a weaker mode.
- Use an absolute workspace path. Do not originate recursively in response to
  another Tentacles-originated instruction.
- Keep work in the same workspace tree serial. Do not originate a second worker
  into that tree while the first worker is active.
- Treat doctor `ready` as this-machine readiness, not universal compatibility.

## 1. Install or link Tentacles

Clone the public repository and link its command shims:

```bash
git clone https://github.com/m-check1B/t3-code-tentacles.git
cd t3-code-tentacles
npm link
command -v tentacles
```

This file is the canonical copyable chair skill. A chair that discovers skills
from the filesystem should link the whole
`integrations/tentacles-operate-skill` directory into its configured skill
directory under the name `tentacles-operate`. Refuse to replace an existing
skill path; inspect and reconcile it first. If the chair cannot load filesystem
skills, give it this file as its operating instructions.

Example after setting the chair's actual skill directory:

```bash
chair_skills_dir=/absolute/path/to/chair-skills
test -d "$chair_skills_dir"
test ! -e "$chair_skills_dir/tentacles-operate"
ln -s "$PWD/integrations/tentacles-operate-skill" "$chair_skills_dir/tentacles-operate"
```

## 2. Inspect this machine

```bash
tentacles doctor
```

Choose one ready instance and one model advertised for it by doctor.

Keep these two lab identities explicit:

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

T3-native instances are `codex` (Codex CLI), `claudeAgent` (Claude Code CLI),
`grok` (Grok Code), `opencode` (OpenCode CLI), and `cursor` (Cursor CLI). T3 also
owns `t3 pair` / `app.t3.codes`; those are not Tentacles instances.

Tentacles-additive instances are `kimi` (Kimi CLI), `deepseek` (DeepSeek CLI),
`hermes` (Hermes lab), and `pi` (Pi CLI). Cursor must already be enabled in T3
and always needs an explicit model.

Kimi CLI, DeepSeek CLI, and Claude Code CLI are independent products. Tentacles
names them as labs a chair may select. Do not configure, document, or invent
their settings, routing, tokens, or plans.

Claude Code is T3-native. If you want Claude, originate `--instance claudeAgent`.
Do not originate a second Claude path. Do not count Claude Code as proved until
a `claudeAgent` originate + continue answers.

## 3. Originate

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

For Grok Code, keep its lab identity explicit:

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

Set `--instance` and `--model` from doctor, preserving the lab identity in the
table above. Thought budget is one of `low`, `medium`, or `high`. Tentacles maps
it to `reasoningEffort` for Codex and for a Hermes `openai-codex:*` model, and to
`effort` for `claudeAgent`. For other instances, do not invent a provider
option; instance and model remain explicit.

Record the returned thread ID. If originate errors or produces no assistant
answer, report that result and do not claim a two-turn proof.

## 4. Continue

Send a non-empty message only after the thread exists:

```bash
tentacles act --intent '{"action":"thread.continue","threadId":"<thread-id>","text":"Continue with the next concrete step.","runtimeMode":"full-access"}'
```

The thread keeps its selected instance, model, and thought-budget options.
Record the returned command ID and verify the session settles without an error.

## 5. Observe

Inspect current T3 projects, threads, sessions, and pending work without
changing them:

```bash
tentacles observe
```

Use the returned thread and session state to confirm the turn completed or to
name the exact error. Do not infer success from command acceptance alone.

## 6. Stop

Stop the provider session for an existing thread when the user asks to stop it
or when continuing would be unsafe:

```bash
tentacles act --intent '{"action":"thread.stop","threadId":"<thread-id>"}'
```

Observe again and report the projected stopped state. Stop is not delete: do
not archive or delete the thread unless separately requested.
