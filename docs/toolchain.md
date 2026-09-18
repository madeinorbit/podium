# Selecting the project toolchain

`mise.toml` selects the exact Bun version used to install, test and build this checkout.
`package.json#packageManager` mirrors that version for package tooling; `engines.bun`
is the supported compatibility range. Neither package field changes the executable on PATH.

Install [mise](https://mise.jdx.dev/installing-mise.html), then in the checkout:

```sh
mise trust
mise install bun
```

For interactive Bash, keep `eval "$(mise activate bash)"` at the end of `~/.bashrc`.
For login shells and applications launched from them, add this after other PATH changes
in `~/.profile` (or your existing `~/.bash_profile`, if present):

```sh
export PATH="$HOME/.local/share/mise/shims:$PATH"
```

The default shim directory must precede standalone Bun installations such as `~/.bun/bin`
and `~/.local/bin`. If using a custom `MISE_DATA_DIR`, use its `shims` directory instead.
Do not add a new `.bash_profile` that hides an existing `.profile`. Zsh users use
`~/.zprofile` for shims and `mise activate zsh` in `~/.zshrc`.

Continue to use ordinary commands:

```sh
bun --version
mise which bun
bun run setup:worktree
bun run test
```

Shell children inherit PATH. An IDE, scheduler or systemd service launched independently
needs its launcher environment configured too. Podium's generated Linux user units put
mise's default shim directory first, so agent and updater children resolve the version
for their working directory. Installing the updated unit affects subsequent service starts;
a running process retains its environment. Already running Bun processes retain their runtime.
Compiled Podium releases embed their build-time Bun runtime, independently of PATH.

CI uses `jdx/mise-action` to install Bun from the same `mise.toml`; subsequent commands remain
plain `bun`. Release jobs also install the other declared build tools. The platform experiment
workflow can explicitly override Bun to investigate compatibility with a different version.

The root preinstall hook and validation admission reject an off-pin runtime with setup guidance.
`--ignore-scripts` deliberately skips preinstall; CI selects the pinned runtime before installing.
A guard reports a bypass; mise provides the correct executable.

To upgrade, change the Bun pin in `mise.toml` and the mirror in `package.json` together, run
`mise install bun`, and validate the candidate. Do not float the project on `latest`. A personal
`mise use -g bun@<version>` supplies a default outside pinned projects; it does not override a
checkout's pin. Install versions before using their shims; do not rely on automatic installation
or fallback to another Bun on PATH. See [mise's shim guidance](https://mise.jdx.dev/dev-tools/shims.html).
