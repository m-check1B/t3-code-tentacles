# v0.1.0 Demo Recipe

The strongest demo is a real run, not a generated product simulation. Use a
fresh public-safe workspace and keep tokens, logs, private paths, and unrelated
T3 threads off-screen.

## 35-second capture

1. **0–4s — thesis**
   Show the repository title: “Put Hermes Agent in T3 Code—without forking
   either project.”
2. **4–14s — T3 → Hermes**
   In T3 Code, select Hermes and ask: “Reply with `T3_TO_HERMES_OK` and one
   sentence explaining ACP.” Show the actual assistant response.
3. **14–23s — Hermes → T3**
   Run a prepared `t3-hermes originate` command. Show the new T3 thread appear
   with `HERMES_TO_T3_OK`.
4. **23–31s — any thread → Hermes**
   In a non-Hermes thread, send `@hermes reply with MENTION_BRIDGE_OK`. Show the
   linked `[Hermes]` thread and the response.
5. **31–35s — close**
   Show the GitHub URL and: “Idea → AI execution → adversarial review → open
   source. Try it, break it, contribute.”

## YouTube package

**Title**

`I Connected Hermes Agent to T3 Code — Bidirectionally, Without Forking Either`

**Description**

```text
Hermes for T3 Code is an open-source, source-independent bridge between T3 Code
and Hermes Agent.

In this real demo:
• T3 Code talks to Hermes over ACP
• Hermes originates visible T3 threads
• any T3 thread can route @hermes into a linked Hermes conversation

The project began as one founder idea and was implemented, attacked, corrected,
tested, and shipped through an AI orchestration workflow.

Source: https://github.com/m-check1B/t3-agent-bridge
Release: https://github.com/m-check1B/t3-agent-bridge/releases/tag/v0.1.0

Tested setup: T3 Code 0.0.31, Hermes Agent 0.20.0, Node.js 22, macOS.
Independent community project; not affiliated with T3 Code, Ping Labs, Hermes
Agent, Nous Research, or the Agent Client Protocol project.
```

**Chapters**

```text
00:00 The idea
00:04 T3 Code → Hermes
00:14 Hermes → T3 Code
00:23 @hermes from any thread
00:31 Source and build story
```

**Thumbnail text**

`HERMES ↔ T3 CODE`

Secondary line: `NO FORKS. BOTH DIRECTIONS.`
