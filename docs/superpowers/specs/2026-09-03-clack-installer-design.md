# Linux installer: bootstrap in shell, everything else in the binary

Design for POD-3274. Supersedes the narrower "put clack in `podium setup`" framing this
issue started with.

## Problem

Two surfaces onboard a Linux machine, and both read like a teletype.

`install.sh` (511 lines) runs from `curl … | sh`, from the generated join command
(`buildJoinCommand`, apps/server/src/hub/machines-join.ts) and from the generated VPS
command (`buildVpsBootstrapCommand`, packages/runtime/src/vps-bootstrap.ts). It prints
`→` steps and `✓` lines. The commands an operator has to copy — `export PATH=…`,
`podium status`, `podium stop`, the `@reboot` crontab line — sit in the same undifferentiated
column as everything else.

`podium setup` (apps/cli/src/cli-setup.ts) is the interactive flow. Its whole I/O contract is
`{ prompt(q): Promise<string>; print(s): void }`, so every choice is a numbered list read back
as a string: `Choose 1-4:`, `[Y/n]`, `Type CHANGE to replace it`, `Type "open" to run without a
password`. The shape of the interface is the shape of `readline`.

## What comparable installers do

Sixteen `curl | sh` installers were downloaded and read: bun, claude, codex, deno,
determinate-nix, docker, fnm, grok, mise, nvm, ollama, pnpm, rustup, starship, tailscale, uv.

**Nobody makes shell pretty.** Zero of the sixteen use a box-drawing character. The most
decorated is starship at eleven ANSI escapes — coloured words, no layout. There is no
tradition of an attractive shell installer to copy, because the attractive ones are not shell
by the time you see them.

**Three hand off to their own binary.** rustup downloads `rustup-init` and runs it
(`ignore "$_file" … "$@" < /dev/tty`, rustup.sh:203). determinate-nix uses the identical idiom
(:113). Claude's installer downloads, checksums, then `"$binary_path" install` (:226). In each
case the shell script is a bootstrap and every decision, prompt and pixel belongs to the binary.
The others (bun, uv, pnpm, deno, fnm) install a self-contained tool with no install-time
decisions to make, so they have nothing to hand off.

**`< /dev/tty` is how an installer stays interactive.** Six of sixteen use it — rustup,
determinate-nix, uv, deno, starship, codex. Under `curl … | sh` stdin is the pipe, but
`/dev/tty` is still the controlling terminal, so a piped script can hand a real terminal to
the binary it just installed. rustup's confirmation UI runs this way.

**Installing prerequisites is ours alone.** None of the sixteen runs a package manager on the
user's behalf. Ollama — the closest analogue, since it also installs a daemon under systemd
with sudo — detects missing tools and *refuses*, printing the per-distro command
(ollama.sh:120-127, and :138-142 for zstd). Tailscale's sixteen apt/dnf calls install tailscale
itself as a distro package.

**Writing shell rc files is normal shell work.** uv has eight rc-file references, nvm seven,
bun and grok five, codex/fnm/mise three. Our PATH block is not unusual in kind, only in size.

## Diagnosis

Podium is a rustup-shaped product — a daemon, service supervision, pairing, real decisions —
running a bun-shaped installer. After the tarball is extracted and signature-verified,
`install.sh` still performs roughly 214 lines of work that the binary sitting next to it could
do better:

| what | install.sh | size |
| --- | --- | --- |
| PATH persistence across five shells | 294-382 | 89 |
| systemd probe, `XDG_RUNTIME_DIR` repair, linger | 384-428 | 45 |
| three vendor agent installers | 442-481 | 40 |
| Claude checksum fallback | 197-252 | 56 |
| join | 430-440 | 11 |
| closing report | 483-511 | 29 |

## Design

### The cut

**The signature-verified binary is both the trust boundary and the UI boundary.** Before it,
shell does the minimum to get a verified binary onto disk. After it, the binary owns every
decision and all presentation.

`install.sh` keeps exactly six jobs:

1. Parse args (`--join`, `--channel`, `--instance`, `--agents`, `--managed`/`--shared`).
2. Detect OS/arch, refuse anything but Linux x64/arm64, validate the instance id.
3. Ensure the **bootstrap** tool set: a downloader (curl or wget), `base64`, `openssl`, `tar`,
   `gzip`, CA certificates. That is precisely what fetching and verifying needs.
4. Download the tarball and its `.sig`; verify Ed25519; fail closed.
5. Extract to a staging dir on the target filesystem, atomic-rename into `$DEST`, create the
   `$BIN/$COMMAND` symlink or the instance wrapper.
6. Hand off: `exec "$BIN/$COMMAND" install-finish <flags> < /dev/tty`.

The prerequisite split is the one place we keep diverging from the corpus, and it narrows.
`git` and `bash` are needed by the *agent installers*, not by the bootstrap, so they move
behind the handoff where a failure can be reported properly instead of `apt-get` output
scrolling past. The justification for installing anything at all (install.sh:92 — "a copied
install.sh must work on a bare distro image") holds for the bootstrap set only. Ollama can
refuse because it is not trying to onboard a bare VPS in one paste; we are.

### `podium install-finish`

A new subcommand, absent from the user-facing help. Flags carry what only the shell knew:

```
--channel stable|edge     --instance <id>       --dest <path>     --bin <path>
--agents codex,claude-code,grok                 --managed|--shared
--vps                     --no-modify-path      --no-interactive
```

The join token travels in the environment (`PODIUM_JOIN_TOKEN`), not argv: `exec` preserves the
environment, and we now control both sides of the call, so there is no reason to leave a live
pairing token visible in `/proc/*/cmdline` to every other user on the box.

Its flow:

- Persist the channel, then run each step. Every step is idempotent; re-running
  `install-finish` after a failure is safe and is the documented recovery.
- **PATH** (`apps/cli/src/install-path.ts`) — a verbatim port of the current logic: the
  unexpanded self-guarding snippet, `~/.profile` always, the three shadowing files only when
  present, `.bashrc`/`.zshrc` when the shell exists, and fish's `conf.d` file.
- **Supervision** (`apps/cli/src/install-supervision.ts`) — mostly deletion. `cli-systemd.ts`
  already owns `hasSystemctl`, `installSystemd` and unit rendering; the shell block exists only
  to choose which `--persist` value to pass. What survives is the user-bus probe and the two
  repairs (`XDG_RUNTIME_DIR` recovery under `sudo -i`, `loginctl enable-linger`).
- **Agents** (`apps/cli/src/install-agents.ts`) — still shells out to the vendor scripts, but
  each runs under a spinner with its output captured and surfaced only on failure. The Claude
  standalone checksum fallback moves here intact.
- **Configure** — see below.
- **Report** — the closing report, drawn with clack.

### Interactivity

`install-finish` picks one of three paths:

| condition | behaviour |
| --- | --- |
| `--join` given | non-interactive pairing via the existing `runJoinSetup`, then the report |
| no `--join`, stdin is a TTY, no `--no-interactive` | run the interactive setup inline — one paste yields a configured Podium |
| otherwise | print the report and point at `podium setup`; today's behaviour |

`--no-interactive` forces the last row even on a terminal, for a scripted run that must not block.

`--vps` selects `runVpsSetup` (all-in-one, no mode menu) instead of the full `runCliSetup` menu.
`buildVpsBootstrapCommand` then drops its trailing `&& "$HOME/.local/bin/podium" setup --vps`
chain, because the handoff already does it.

Both generated commands already download to a file and run it with `sh "$tmp"`, so stdin is
already the SSH terminal for them; `< /dev/tty` is what rescues the raw `curl … | sh` form
documented in the README. When `/dev/tty` cannot be opened the redirect is omitted and the
no-TTY path runs.

### The UI module

`apps/cli/src/setup-ui.ts` (new) widens `SetupIO` from `{ prompt, print }` to intents that map
onto clack, with a real implementation and a scripted test double:

```
intro  outro  note  command  log.{step,success,warn,error}
select  text  password  confirm  spinner
```

`command(cmd, caption?)` is the copy-paste primitive: a `note()` box containing the command and
nothing else, so a drag-select is exactly what you run. It is the single implementation serving
`install-finish`, `podium setup` and `podium setup --vps`.

`cli-setup.ts` keeps its logic and its decision comments; only the I/O calls change.

| today | becomes |
| --- | --- |
| numbered mode menu, `Choose (blank to cancel)` | `select` with per-option hints |
| `Choose 1-4` over `NETWORK_OPTIONS` | `select` |
| `Run this, then come back:\n\n    tailscale funnel 18787` | `command()` box |
| paste-URL loop, ten attempts | `text` with inline `validatePublicUrl` |
| `Password (blank starts…)`, `Type "open"` | `password`, then a `confirm` defaulting to No |
| `Type CHANGE to replace it` | stays a typed word (`text` + validate) |
| `[Y/n]` systemd | `confirm`, default yes |
| telemetry example, two `[y/N]` | example as a `note`, two `confirm`s, both default No |
| join-code loop | `text` validating via `decodeJoin` |
| silent `waitForEnrollment` | `spinner` |

Cancellation improves for free: clack returns a cancel symbol on Ctrl-C, so every prompt checks
it and leaves through one "Nothing saved" path. That replaces the `MAX_ATTEMPTS` counters, which
exist only because readline resolves `''` forever on EOF.

SP-7f2c requires that "every setup surface must make the no-password option an explicit opt-in
with a confirmed warning". The `confirm` defaulting to No, behind a warning `note`, satisfies
it; the typed-word ceremony was never the requirement.

### Trust boundary

The `exec` happens only after Ed25519 verification, so the binary receiving control is the one
just verified. Moving install logic across that boundary does not weaken it — the logic now runs
from signed code rather than from a script the user piped into a shell.

### Failure

`install.sh` verifies the binary runs (`"$BIN/$COMMAND" --version`) before handing off, and
prints a plain-text fallback report if it does not. rustup faces the same case and reports it
explicitly (rustup.sh:177, noexec `/tmp`). Reporting failure is part of the installer's job, so
it cannot depend on the thing that failed.

## Testing

- `scripts/install-sh.test.sh` (366 lines) shrinks to the bootstrap contract: arch selection,
  prerequisite refusal, signature fail-closed, atomic install, and that the handoff is invoked
  with the right flags — with a stub binary standing in for the real one. Its real-shell PATH
  probe (`env -i` against actual bash/zsh/fish) stays: it is the only thing that proves a fresh
  login finds `podium`, and it should assert against the installed binary's behaviour regardless
  of which language wrote the snippet.
- New TS tests for `install-path.ts`, `install-supervision.ts`, `install-agents.ts` and
  `install-finish` — all currently reachable only through a 366-line shell test.
- `cli-setup.test.ts` (682 lines) is rewritten against the new double: answers become a typed
  per-widget queue rather than a positional string array.

## Open question: `--managed` / `--shared`

`PODIUM_MANAGED` is assigned at install.sh:13 and toggled by `--managed` / `--shared` at
:24-25. Nothing reads it — not later in install.sh, not anywhere in `apps/` or `packages/`.
Both flags are accepted and have no effect today.

Rewriting the arg parser forces a decision, and it is not mine to make silently:

- **Wire it up** if managed-vs-shared was meant to reach the install (it plausibly relates to
  the managed-session install shape in SP-d6e8), in which case what it should *do* needs
  stating.
- **Keep accepting and ignoring** them, so any script or docs passing `--managed` keeps working,
  without carrying a dead variable into TypeScript.
- **Reject them** as unknown args, which is honest but breaks anything that passes them.

Defaulting to the middle option unless told otherwise.

## Risks

1. **PATH persistence is the riskiest migration.** Five shells, shadowing files, an
   unexpanded snippet that must re-resolve `$HOME` on every source. Mitigation: port verbatim,
   keep the real-shell probe.
2. **A bigger single point of failure.** If `install-finish` dies the user has a binary on disk
   and nothing configured. Mitigation: idempotent steps, and the fallback report names the
   re-run.
3. **Bundle growth.** `@clack/prompts` pulls `@clack/core`, `sisteransi`, `fast-string-width`
   and `fast-wrap-ansi` into the headless binary.

## Staging

Each stage ships on its own.

1. `setup-ui.ts`, the `@clack/prompts` dependency, and `podium setup` / `setup --vps` moved onto
   it. The original bounded change; delivers the redesign of the interactive flow.
2. `install-finish`, the `exec` seam with `< /dev/tty`, and the migration of PATH, supervision,
   join and the closing report. Delivers the one-paste interactive install.
3. Agent installers and the Claude checksum fallback move behind the handoff.
