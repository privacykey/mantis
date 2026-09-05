# Fleet / MDM provisioning

Moved out of the top-level README. The content is unchanged.

`POST /api/keys` is idempotent when you pass an `external_id` (e.g. a machine
serial): the first call mints the key, every re-run returns the same one
(`200` + `"reused": true`), so MDM scripts can enroll on every check-in
without minting duplicates. What a re-run sees depends on who asks:

- the key's creator, or an admin — the key as they could read it anyway;
- an **enrollment-scoped** key that did not create it — the trigger URL and
  identity only (`memo` is `null`, no alert routing). This is what lets a
  re-imaged machine, or a rotated enroll key, recover its canary by serial.
  The claim is written to the audit log as `key.claimed` with
  `cross_key: true`, so an extracted enroll key being used to walk serials
  is visible;
- any other full-scope key — `409 conflict` with nothing disclosed (audited
  with `denied: true`). External ids are guessable, and a full key that owns
  nothing here has no fleet role.

Pair it with an **enrollment-scoped API key** (an admin runs
`POST /api/api-keys` with `"scope": "enroll"`; minting API keys is admin-only)
— a create-only credential that's safe to embed in fleet scripts: if extracted
from a device it cannot list, read, disable, or delete keys, read hits, or log
in to the dashboard.

[`deploy/kandji/`](../deploy/kandji/README.md) has a ready-made Kandji Custom
Script that gives every Mac its own canary and pings it whenever an interactive
terminal opens, plus a central pre-provisioning script driven by the Kandji API.
