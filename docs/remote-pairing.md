# Outbound remote pairing

Status: component protocol v1; synthetic proof only

Tentacles can opt into one outbound WSS connection from a user's computer to a
Sphere-authenticated Jack pair endpoint. T3 remains on `127.0.0.1`; the pairer
does not listen on a port and does not expose T3 HTTP or WebSocket transport.
Colocated Jack continues to use its loopback runtime without a pair offer.

## Trust and entitlement

The Jack endpoint owns customer authentication and must fail closed unless the
Sphere session has the existing Jack 1 entitlement:

- `product_id: agentjack-desktop`
- `ability: desktop.use`

The host bind carries the existing Sphere `machine_id`. A pair token must be
single-use, expire at its advertised time, bind at most one Tentacles host, and
be invalidated by Sphere machine or license revocation. Extra computers are
extra activations on that same product, not another product or ability.

The endpoint must return `computer.unavailable` with `data: null` whenever no
currently authorized pair is bound. Tentacles emits the same error envelope if
a bound host cannot complete a supported local operation. Neither side may
substitute synthetic computer data.

## Host command

The browser/Jack side delivers an owner-only JSON offer out of band. It is not
accepted as a command-line value:

```json
{
  "version": 1,
  "endpoint": "wss://jack.example.invalid/api/tentacles/pair",
  "pairToken": "<one-shot secret>",
  "expiresAt": "2030-01-01T00:00:00.000Z"
}
```

The file must be a current-user-owned `0600` regular file. The endpoint must use
`wss:` and cannot contain credentials, a query, or a fragment. Start the opt-in
pairer with the Sphere machine identity already used by Jack 1:

```bash
tentacles pair \
  --pair-file /private/path/pair-offer.json \
  --machine-id '<sphere-machine-id>'
```

Tentacles sends the token only in the initial `pair.bind` frame. It removes the
exact file inode only after the endpoint acknowledges `pair.bound`. Expired or
rejected offers remain available for operator audit and replacement; they are
never printed. After a transient socket loss, the same process reconnects with
capped exponential backoff plus jitter and re-announces the host contract. The
one-shot credential remains memory-only after the offer file is consumed. A
relay that accepts the re-announcement restores the pair in place; a v1 relay
that rejects the consumed credential returns `pair.unpaired`, which is treated
as unrecoverable authorization so a launchd `KeepAlive` wrapper can mint a fresh
offer. `pair.expired` and `pair.revoked` are terminal authorization results too.
The advertised `expiresAt` gates only the initial bind. Once `pair.bound` consumes
the offer, Tentacles retires that local expiry timer: it does not tear down a
healthy socket, and a later reconnect may re-announce the memory-only credential
after the original offer timestamp. The relay remains authoritative and can end
that attempt with an explicit terminal `pair.expired`, `pair.revoked`, or
`pair.unpaired` result.

## Wire surface

Every frame has `version: 1`. The host begins with `pair.bind`, including only
the pair token and this non-secret host contract:

```json
{
  "machineId": "<sphere-machine-id>",
  "productId": "agentjack-desktop",
  "ability": "desktop.use",
  "runtime": "tentacles",
  "rpc": ["seats", "originate", "continue", "doctor-status"]
}
```

After `pair.bound`, the endpoint may send bounded `rpc.request` frames for only
those four methods. Tentacles returns `rpc.result`, or this fail-closed envelope
without reflecting local error text:

```json
{
  "error": {
    "code": "computer.unavailable",
    "message": "Computer unavailable",
    "data": null
  }
}
```

Across reconnect generations, accepted request IDs are checked against every
pending operation and a bounded history of the 1,000 most recently accepted IDs.
The 16-operation capacity is also pairer-wide: socket loss does not release a
locally running operation, and over-cap refusals do not enter or churn the replay
window. A pending ID stays replay-protected until its local operation settles.
`originate` and `continue` always execute locally with `runtimeMode: full-access`;
any conflicting requested mode fails closed. Remote parameters are allowlisted
per method and cannot select local state or token file paths.

`tentacles doctor` reports only `paired`, `unpaired`, or `expired`. Its presence
lease contains no token, endpoint, machine identity, prompt, or RPC payload.
`pair-presence.json` is refreshed by valid relay traffic, including every
application-level `ping`, instead of by an independent local timer. Socket loss
or a missed relay heartbeat immediately writes `unpaired` with a closed
`staleReason` value before retrying; a later `pair.bound` clears that reason and
restores the lease.
