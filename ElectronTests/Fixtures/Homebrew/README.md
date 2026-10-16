# Homebrew launcher fixture

`brew` is the unmodified `bin/brew` from Homebrew commit
`cdc1ca503231b9a96da64526774915d913c3ec9f`.
SHA-256: `c9a27029eb72dab04f4595041f7670bb03b4cb467297abba817883afb23e0bf3`.
The upstream BSD 2-Clause license is retained beside it.

Tests copy the launcher to a disposable prefix and supply a harmless terminal
`Library/Homebrew/brew.sh`. They do not run Ruby, sudo, or package operations.
This proves launcher/configuration semantics only, not administrator credential
acceptance or native dialog behavior.
