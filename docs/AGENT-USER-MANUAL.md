# Orchestrate from one chair. Watch it. Jump in.

Grok Bot is the chair. Tentacles is how it hires. T3 Code is the cockpit you
can still fly.

You talk in one place. Labs work in T3. You see every thread. You can type into
any of them, stop one, or take the keyboard while a lab is mid-turn. It is not
a dashboard you babysit. It is a chair with a visible shop floor.

![T3-native capabilities and Tentacles-additive chair and lab paths](tentacles-vertical.png)

## Three pieces

Grok Bot is a chair. You talk to it. It decides what to hire, watches the seats,
and comes back with results. It does not replace T3. It is not Codex or Grok
Code.

T3 Code is the visible cockpit. Every originated job is a real T3 thread:
instance, model, runtime mode, live turns, files, and diffs. Open T3 and work in
that thread like you started it yourself.

Tentacles is the chair CLI between them. Its public command is `tentacles`. It
originates and continues T3 work without the T3 GUI. It also adds labs T3 does
not ship.

Repository: <https://github.com/m-check1B/t3-code-tentacles>

Chairs are not labs. Grok Bot the chair is not Grok Code CLI the lab. Hermes as
a chair is not Hermes the additive instance. Mix those and you hire the wrong
worker.

## What you can hire

T3 already orchestrates Codex CLI, Claude Code CLI, Grok Code CLI, OpenCode CLI,
Cursor CLI, and `t3 pair` / [app.t3.codes](https://app.t3.codes).

Tentacles adds, when `tentacles doctor` marks them ready on your machine: Kimi
CLI, DeepSeek CLI, Hermes, and Pi CLI.

Tentacles names those CLIs. It does not own their settings. Claude Code is
T3-native: `--instance claudeAgent`. Doctor is this-machine truth. Advertised
is not proved.

## One-time setup

Start with T3 Code running locally, Node.js 22 or newer, and at least one lab
you can already use in the T3 UI.

```bash
git clone https://github.com/m-check1B/t3-code-tentacles.git
cd t3-code-tentacles
npm link
tentacles doctor
```

Give the chair the copyable skill at
[`integrations/tentacles-operate-skill/SKILL.md`](../integrations/tentacles-operate-skill/SKILL.md).
If the chair loads skills from a folder, link that directory as
`tentacles-operate`. Then tell it to operate Tentacles.

Issue a local T3 token into a `0600` file. Do not print it. The
[README](../README.md#five-minute-setup) has the exact `t3 auth session issue`
command.

## The loop

Talk to the chair. Give it the job and picture of done. It originates a T3
thread with `--runtime-mode full-access`. Omit that and Tentacles fails closed.

The chair records the thread ID. T3 shows the same thread. You can watch it
stream, type a correction in T3, tell the chair to continue or stop, edit files
on disk by hand, walk away, and come back. The thread is still the thread.

Continue with `tentacles act --no-wait` and `runtimeMode: full-access` when the
chair should return after dispatch. Observe with `tentacles observe`. Stop is
not delete.

Independent trees can run in parallel. Work in the same tree stays serial.

## Observability

There are two views of the same work. T3 is the human cockpit. `tentacles
observe` is the chair snapshot. Do not infer success from “command accepted.”
Running without an assistant delta is not generating.

## Manual, on the go

Let the chair hire. Interrupt from the chair or by typing in T3. Take over
mid-flight: write the next message in T3, save a file, then tell the chair to
continue from what you just did. Away from the desk, the chair still talks.
When you sit down, T3 is the full log. You stay the operator.

## Do not mix

Do not start `codex`, `grok`, `claude`, or a browser CLI from Grok Bot.
Tentacles is the hire path. Do not hire `--instance hermes` when you meant Grok
Code (`--instance grok --model grok-4.6`). Do not treat doctor `ready` as a
worldwide guarantee.

Tentacles: <https://github.com/m-check1B/t3-code-tentacles>

T3 Code: <https://github.com/pingdotgg/t3code>
