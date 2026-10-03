# Command acceptance receipts
`act` and `orchestrate` include `accepted`, `commandId`, `status`, and
`executionStatus` in their JSON receipts. `--no-wait` confirms acceptance only;
`executionStatus: "unverified"` makes no delivery or completion claim. A T3
rejection emits `accepted: false`, `status: "rejected"` and exits nonzero.
A transport failure emits `accepted: false`, `status: "unconfirmed"`: this means
acceptance was not confirmed, so retry only with the same commandId. Commands
already accepted earlier in a batch remain in the output when a later command
is rejected.
