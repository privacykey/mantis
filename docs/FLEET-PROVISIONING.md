# Fleet / MDM provisioning

Moved out of the top-level README. The content is unchanged.

`POST /api/keys` is idempotent when you pass an `external_id` (e.g. a machine
serial): the first call mints the key, every re-run returns the same one
(`200` + `"reused": true`), so MDM scripts can enroll on every check-in
without minting duplicates. A reused response also carries
`created_by_caller`, so a script can tell its own key from one it adopted.

External ids are guessable and unique across the whole instance, so a claim
only resolves inside the claimer's **fleet**:

- the key's creator — the key as it could read it anyway;
- an **enrollment-scoped** key of the same fleet that did not create it — the
  trigger URL and identity only (`memo` is `null`, no alert routing). This is
  what lets a re-imaged machine, or a rotated enroll key, recover its canary
  by serial. The claim is written to the audit log as `key.claimed` with
  `cross_key: true`, so an extracted enroll key being used to walk serials
  is visible;
- an admin — keys of the operators' own fleet. Adopting a key another fleet
  created needs an explicit `"adopt": true` (audited with `adopted: true`);
- anyone else — `409 conflict` with nothing disclosed (audited with
  `denied: true`). A device is never armed with a key that somebody outside
  its fleet created first.

A fleet is: all admin keys and the enroll keys they own; or one non-admin
full key and the enroll keys bound to it. An enroll key's owner is set when
it is minted (below) and defaults to the minting admin. Enroll keys minted
before owners were recorded belong to the operators' fleet.

A claim never returns a dead tripwire: if the existing key is disabled or
expired the answer is `409`, so the device's enrollment fails visibly instead
of installing a URL that will never alert. Enable or delete the key to
resolve it.

Pair it with an **enrollment-scoped API key** (an admin runs
`POST /api/api-keys` with `"scope": "enroll"`; minting API keys is admin-only)
— a create-only credential that's safe to embed in fleet scripts: if extracted
from a device it cannot list, read, disable, or delete keys, read hits, or log
in to the dashboard. To enroll for a fleet that a non-admin full key
provisions and reads, pass that key's id as `"owner_api_key_id"`.

An enroll key can only mint a plain tripwire. `POST /api/keys` accepts from it
`memo`, `external_id`, `response_kind` (`gif` or `empty`) and
`dedupe_window_seconds` (at most 600); anything else — an expiry, monitor
settings, redirect/HTML/JSON trigger responses, the `mantis:device:` external
id namespace — is refused with `403`. Alert routing is an operator decision:

- by default an enroll key cannot attach `destinations`. Route fleet alerts
  with global destinations (dashboard → settings → notifications);
- to let enrollment attach a specific destination, approve it on the server:
  `MANTIS_ENROLL_DESTINATIONS` is a whitespace-separated list of
  `channel:target` pairs, e.g.
  `MANTIS_ENROLL_DESTINATIONS="slack:https://hooks.slack.com/services/T000/B000/XXX"`.
  Any other destination from an enroll key is refused with `403` before
  anything is stored or sent.

One enroll key can create at most `MANTIS_ENROLL_KEYS_PER_HOUR` new keys per
hour (default 1000, `0` disables the cap); beyond that it gets `429`.
Re-claims of an existing `external_id` are not counted.

[`deploy/kandji/`](../deploy/kandji/README.md) has a ready-made Kandji Custom
Script that gives every Mac its own canary and pings it whenever an interactive
terminal opens, plus a central pre-provisioning script driven by the Kandji API.
