# Fleet / MDM provisioning

Moved out of the top-level README. The content is unchanged.

`POST /api/keys` is idempotent when you pass an `external_id` (e.g. a machine
serial): the first call mints the key, every re-run returns the same one
(`200` + `"reused": true`), so MDM scripts can enroll on every check-in
without minting duplicates.

Pair it with an **enrollment-scoped API key** (`POST /api/api-keys` with
`"scope": "enroll"`) — a create-only credential that's safe to embed in fleet
scripts: if extracted from a device it cannot list, read, disable, or delete
keys, read hits, or log in to the dashboard.

[`deploy/kandji/`](../deploy/kandji/README.md) has a ready-made Kandji Custom
Script that gives every Mac its own canary and pings it whenever an interactive
terminal opens, plus a central pre-provisioning script driven by the Kandji API.
