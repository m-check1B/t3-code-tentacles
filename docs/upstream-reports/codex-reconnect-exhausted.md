# Draft upstream issue (T3 Code): Codex turn hangs "running" after reconnects are exhausted

Status: draft, not filed (KRA-9494).

## Summary

When the Codex app-server stream disconnects with HTTP 429 and its reconnect
budget runs out, T3 Code keeps the turn `running` forever. No terminal event
follows, so the UI and API clients see a turn that is still generating. An
exhausted reconnect after 429 should fail the turn (`runtime.error`, session
`error`, turn `failed`) so clients can retry or report it.

## Observed provider log shape (sanitized: no ids, no secrets)

```text
[<iso>] NTIVE: {"method":"error","message":"Reconnecting... 4/5","payload":{"willRetry":true,"error":{"message":"Reconnecting... 4/5","additionalDetails":"exceeded retry limit, last status: 429 Too Many Requests","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":429}}}}}
[<iso>] NTIVE: {"method":"error","message":"Reconnecting... 5/5","payload":{"willRetry":true,"error":{"message":"Reconnecting... 5/5","additionalDetails":"exceeded retry limit, last status: 429 Too Many Requests","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":429}}}}}
[<iso>] CANON: {"type":"runtime.warning","payload":{"message":"Reconnecting... 5/5"}}
<no further events for this thread>
```

## Where

`apps/server/src/provider/Layers/CodexAdapter.ts` maps the Codex `error`
notification to `runtime.warning` when `willRetry` is true and to
`runtime.error` otherwise. The final `Reconnecting... 5/5` notification still
has `willRetry: true` and `additionalDetails` already says the retry limit is
exceeded, so it becomes a warning and the turn is never ended.

## Expected

The last reconnect attempt (attempt N of N, or `additionalDetails` reporting an
exceeded retry limit) ends the turn as failed with a provider error. A
fallback idle timeout on a `running` turn with no events after a
`responseStreamDisconnected` warning would also work.

## Actual

The thread session stays `running` with an active turn and no further events
until someone sends a new message or stops the session.

## Workaround in Tentacles

`tentacles report` returns `stalled` for this shape after an idle window, and a
no-AI watcher (`scripts/stall-watcher.mjs`) sends a bounded resume nudge.
