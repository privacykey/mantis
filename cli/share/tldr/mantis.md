# mantis

> Self-hostable tripwires CLI — create trigger URLs that fire notifications when accessed.
> Stores API keys in the OS keychain and supports multiple profiles per server.
> More information: <https://github.com/privacykey/mantis>.

- Log in to a Mantis server (prompts for URL and API key):

`mantis login`

- Create a new tripwire key with a memo and copy the URL to the clipboard:

`mantis new "{{memo}}" --copy`

- List all keys, most recent first:

`mantis list`

- Tail hits live for the most-recently-created key:

`mantis hits last --follow`

- Generate a honey-PDF that fires when opened:

`mantis new "{{memo}}" --pdf {{path/to/decoy.pdf}}`

- Add a webhook destination to an existing key (fires an activation ping):

`mantis dest add {{key_id}} webhook {{https://example.com/hook}}`

- Run an offline self-audit for mantis-style installer artifacts on this machine:

`mantis detect --scope {{user|system|all}}`

- Print a shell completion script (already wired up by the Homebrew formula):

`mantis completion {{bash|zsh|fish}}`
