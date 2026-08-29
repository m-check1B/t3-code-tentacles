# Independent tool-action audit

Tentacles can emit a fixed, secret-free Matrix event immediately before and
after every command it sends to T3 Code's orchestration dispatch endpoint. The
before write is fail-closed: Tentacles does not dispatch the command unless
Synapse accepts the audit event. A failed or successful dispatch receives a
terminal event with the same immutable `correlation_id`.

This control covers **Tentacles orchestration commands**. It does not claim to
cover provider-internal shell, filesystem, browser, or MCP calls made after a
turn starts. A tool-using seat or lab is covered only when its tool dispatcher
is behind the isolated broker that owns this emitter. Native T3 provider calls
and direct local CLI use remain outside the source-of-truth boundary.

## Event contract

The Matrix event type is `com.verduona.tentacles.tool_action`. Its content has
exactly these fields:

| field | value |
|---|---|
| `schema` | `com.verduona.tentacles.tool_action.v1` |
| `correlation_id` | bounded immutable Tentacles command ID |
| `actor_id` | bounded seat or lab identity configured by the broker operator |
| `service_name` | `Tentacles` |
| `tool_name` | bounded T3 command type |
| `phase` | `before` or `after` |
| `outcome` | `attempted`, `succeeded`, or `failed` |
| `recorded_at` | broker timestamp in ISO 8601 form |

Prompts, command arguments, outputs, response bodies, errors, credentials, and
filesystem paths are never fields in this event. Synapse response bodies are
not reflected in errors.

## Broker configuration

All four variables are required together; partial configuration fails closed:

- `TENTACLES_AUDIT_MATRIX_URL`
- `TENTACLES_AUDIT_MATRIX_ROOM_ID`
- `TENTACLES_AUDIT_MATRIX_TOKEN_FILE`
- `TENTACLES_AUDIT_ACTOR_ID`

The homeserver must be an HTTPS origin. The access token is read from a
non-symlink, current-user-owned regular file with mode `0600`; it is not accepted
inline and is never printed. These variables must be installed on the isolated
broker service by its operator, not supplied by the tool-using agent.

## Synapse writer boundary

The Synapse administrator provisions one private room and one logger identity:

- the logger identity has the minimum power needed to send only the custom
  audit event;
- redaction, room configuration, invites, and other event types require the
  room administrator's higher power level;
- reviewer identities can read but cannot send or redact;
- agent identities are not room members and do not receive the logger token;
- the logger credential is readable only by the isolated broker service
  identity, outside the agent's OS account and filesystem namespace.

With that configuration, new records can be written by the Tentacles logger
identity. Room administrators and Synapse administrators remain privileged and
must be named in review evidence because they can administer or directly alter
the record plane. The agent that caused a dispatch cannot write or redact it.

A same-user process on a MacBook is not an independent boundary: a full-access
agent could read the same user's credential or replace local code. The accepted
deployment is the isolated lab/broker host plus Synapse, not a production site
used as a lab plane.

## Acceptance proof

Use only a harmless internal command and record event IDs, timestamps, and
identities—not event bodies containing operational data:

1. Dispatch one harmless command through the isolated Tentacles broker.
2. Confirm matching `before` and `after` events in the audit room.
3. From the agent identity, confirm that sending the custom event and redacting
   either event are denied.
4. From the reviewer identity, confirm read succeeds while send and redaction
   are denied.
5. Name the logger, room administrator, and Synapse administrator roles that can
   write or administer the plane.

Synthetic tests prove schema confinement and fail-closed ordering. They do not
replace the live harmless canary and negative authorization proof.
