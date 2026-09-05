# mantis

> Client for a self-hostable canary and tripwire service.
> Mint trigger URLs that fire a notification when someone accesses them.
> More information: <https://github.com/privacykey/mantis>.

- Run the guided first-time setup and create a first key:

`mantis init`

- Create a new key with a memo and copy its trigger URL to the clipboard:

`mantis new "{{memo}}" --copy`

- Tail hits live for the most recently created key:

`mantis hits last --follow`

- Create a key with a decoy PDF that fires when the file is opened:

`mantis new "{{memo}}" --pdf {{path/to/decoy.pdf}}`

- Arm a whole machine — one key per host alarm — and write an install bundle:

`mantis device new --os {{macos|linux|windows}} --name {{hostname}} --bundle {{path/to/bundle.zip}}`

- Arm a machine with stateless edge URLs instead, writing the bundle as a directory:

`mantis edge device --os {{macos|linux|windows}} --name {{hostname}} --webhook {{https://example.com/hook}} --bundle {{path/to/directory}}`

- Bulk-create keys from a CSV and write an output CSV with the generated URLs:

`mantis bulk-create --csv {{path/to/input.csv}} --out {{path/to/output.csv}}`

- Add a webhook notification destination to an existing key:

`mantis destinations add {{key_id}} webhook {{https://example.com/hook}}`
