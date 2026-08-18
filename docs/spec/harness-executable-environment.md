# Spec: Harness Executable Environment

Status: **reviewed; implementation approved** · 2026-08-17  
Living-spec component: `SP-58fa`

## 1. Problem

Podium currently answers two related questions through different mechanisms:

1. Inventory asks whether a harness is installed by trying adapter-owned candidate paths.
2. Login, interactive sessions, one-shot execution, headless turns, and model probes build their
   own commands, usually using a bare executable name inherited from the daemon's `PATH`.

That split is incorrect for a GUI-launched native application. On macOS, a process launched by
Finder inherits launchd's environment rather than the environment produced by the user's Terminal
login shell. Homebrew's Apple Silicon prefix (`/opt/homebrew/bin`), Homebrew's Intel prefix
(`/usr/local/bin`), version-manager shims, and user-configured command directories may therefore be
absent even though the commands work in Terminal. It also permits inventory to report a harness at
an absolute path that launch never uses.

## 2. Decision

Podium will construct one immutable command environment for a daemon generation and use it for
both discovery and execution. The environment is generic runtime infrastructure; harness adapters
declare software-specific executable facts but do not inspect or repair `PATH` themselves.

Ownership is split across three layers:

| Owner | Responsibility |
| --- | --- |
| `@podium/runtime/command-environment` | Recover the OS user's command environment and resolve runnable files with exec-style semantics. |
| `@podium/harness` | Declare harness executable names/fallbacks/verification and turn resolved executables into harness invocations. |
| `apps/daemon` | Own one environment generation, pass it to every probe and launch path, and refresh it deliberately. |

`apps/desktop` remains harness-agnostic. Its existing `PODIUM_DESKTOP_SUPERVISED=1` marker is enough
for the daemon composition root to request GUI environment recovery.

## 3. Generic command environment

### 3.1 API

The Node-only `@podium/runtime/command-environment` subpath exposes an immutable value:

```ts
interface CommandEnvironment {
  readonly env: Readonly<Record<string, string>>
  readonly pathEntries: readonly string[]
  readonly source: 'inherited' | 'login-shell' | 'fallback'
  readonly generation: number
  resolve(commandOrPath: string): string | undefined
}
```

Construction accepts explicit dependencies for hermetic tests: platform, machine home, login shell,
base environment, subprocess runner, timeout, and output limit. Production selects `machineHome`
from an explicit option, then `HOME`, then `os.userInfo().homedir`; it selects the login shell from
an explicit option, then `os.userInfo().shell`, then `SHELL`, then the platform default. Calls to
`os.userInfo()` are caught because minimal containers need not provide a resolvable account. Neither
default may come from a credential-isolation home.

### 3.2 Precedence

The effective path order is:

1. PATH captured from the account's login shell for a supervised POSIX desktop launch.
2. The inherited process PATH, retaining entries not already supplied by the shell.
3. Deterministic platform fallbacks, retaining entries not already present.

Fallbacks are recovery, not authority. They must never displace a command selected earlier by the
user's shell. POSIX fallbacks include `~/bin`, `~/.local/bin`, `~/.bun/bin`, `/usr/local/bin`,
`/usr/bin`, and `/bin`; macOS additionally includes `/opt/homebrew/bin` and the matching `sbin`
locations. Harness-specific locations such as `~/.opencode/bin` are not generic fallbacks.

### 3.3 Shell hydration

Only when `PODIUM_DESKTOP_SUPERVISED=1` is present on macOS or Linux, construction runs the OS
account's login shell once as login + interactive + command (`-ilc`) and prints `PATH` between fixed
sentinels. The probe:

- inherits the daemon's baseline environment;
- ignores stderr;
- has a five-second deadline;
- caps captured stdout;
- strips ANSI control sequences before parsing;
- rejects missing sentinels and an empty path;
- kills and reaps the child on timeout or output overflow.

Failure is data. Construction returns the inherited path plus fallbacks and records a classified
failure reason for diagnostics; it does not make daemon startup fail.

Unrelated process-manager markers such as systemd's `INVOCATION_ID` do not enable shell hydration.
Windows retains the current inherited-PATH and executable-resolution behavior in this phase; POSIX
executable-bit rules and shell probing are not applied to Windows.

### 3.4 Resolution

`resolve` implements process-execution semantics without invoking `which`:

- absolute candidates are accepted only when they are regular executable files;
- bare commands are searched in path order;
- symlink spellings are preserved so stable package-manager links are not replaced with a
  versioned Cellar path;
- duplicate candidates are removed without changing first-match precedence.

The returned path is absolute. Verification and launch receive `CommandEnvironment.env`, which is
required even with an absolute script path because `#!/usr/bin/env node` must resolve its interpreter
from the same environment.

## 4. Harness declarations and resolution

Every built-in manifest declares executable metadata:

```ts
interface HarnessExecutableDeclaration {
  readonly names: readonly string[]
  readonly fallbackCandidates?: (machineHome: string) => readonly string[]
  readonly versionArgs: readonly string[]
  readonly identityProbe?: {
    readonly args: readonly string[]
    accepts(output: string): boolean
  }
}
```

Generic install roots do not appear in manifests. Examples:

- Claude: `names: ['claude']`.
- Codex: `names: ['codex']`.
- OpenCode: `names: ['opencode']`, fallback `~/.opencode/bin/opencode`.
- Cursor: its supported names plus the existing identity check for ambiguous `agent` aliases.

The harness package resolves declarations through `CommandEnvironment`, probes the resulting
absolute path with `versionArgs`, applies any identity probe, and returns a
`ResolvedHarnessExecutable`. Probe execution is bounded and never throws into inventory.

Adapters continue to own provider-specific arguments, stdin, configuration files, and environment
overlays. They do not own PATH lookup, executable caching, Homebrew knowledge, or subprocess probing.

To enforce that boundary, adapter launch/login/exec/headless builders produce commandless invocation
specs. A central harness invocation function attaches the resolved executable and effective PATH.
Unknown or unresolved harnesses fail explicitly rather than falling back to another adapter or a
bare command.

The existing module-level OpenCode and Cursor binary caches, the 60-second availability cache, and
the `HarnessBins` callback mechanism are removed. Inventory stores the complete
`ResolvedHarnessExecutable` for its generation. Launch consumes that stored value directly and does
not resolve the command again; if the file disappears between verification and spawn, the spawn
fails with that exact path rather than selecting a different executable.

## 5. Daemon lifecycle

The daemon starts command-environment construction as early as possible and overlaps it with other
boot work. The authenticated handshake and UI connection do not wait for shell startup. The first
authoritative inventory report and the first process launch await the environment generation.

`DaemonContext` carries a harness runtime service rather than independent command resolvers. The
service is used by:

- machine inventory and non-harness tool inventory;
- native harness login;
- interactive PTY launch and reattach;
- one-shot harness execution;
- durable and non-durable headless turns;
- model probes, including provider-specific model listing;
- any quota or account probe that executes a harness command;
- the durable-headless runner environment at its process boundary;
- child shell environments, so manually typed commands see the recovered PATH.

Periodic inventory refresh reuses the current command-environment generation. An explicit refresh
rehydrates the login shell, increments the generation, atomically swaps the environment, and evicts
inventory derived from the old generation. Concurrent launches retain the immutable generation they
started with. Every inventory promise is tagged with its generation; completion from generation N
is discarded if generation N+1 has become current, even when the older subprocess finishes last.

## 6. Home separation

Executable resolution uses `machineHome`, the OS account home associated with the daemon process.
Credential and transcript access use `credentialHome`, represented today by `ctx.accountHome` and
some legacy `homeDir` call sites, which may be an isolated managed-account home. Those call sites
must be made explicit during this change. Supplying an alternate credential home must never redirect
binary discovery into that home or replace the machine command environment. A mixed operation such
as Claude model discovery launches the machine-resolved Claude executable while reading OAuth state
from `credentialHome`.

## 7. Invariants

1. A harness reported as installed is launched through the same resolved executable and command
   environment that passed verification.
2. No built-in adapter performs PATH lookup or carries generic platform install roots.
3. Homebrew fallback paths never outrank the user's shell PATH.
4. A login, interactive launch, one-shot execution, headless turn, and model probe cannot silently
   fall back to a bare command after resolution fails.
5. Credential-home selection does not affect executable discovery.
6. Shell hydration failure degrades to inherited PATH plus fallbacks and remains observable.
7. A refresh swaps whole immutable generations; a single process launch never mixes generations.

## 8. Testing and acceptance

Hermetic unit coverage must prove:

- shell PATH ordering, deduplication, sentinel parsing, ANSI stripping, timeout, and fallback;
- Apple Silicon and Intel Homebrew fallback discovery;
- executable-bit and regular-file rejection;
- adapter-specific fallback behavior and ambiguous-command identity checks;
- the same absolute executable and PATH reach inventory, login, interactive, one-shot, and headless
  launch builders;
- credential-home isolation does not change executable resolution;
- refresh generation and inventory invalidation semantics;
- a generation race where an older inventory promise finishes after a refresh;
- systemd `INVOCATION_ID` alone does not trigger login-shell hydration;
- removed OpenCode/Cursor/availability caches cannot bypass the generation;
- a superseded session retains the immutable `spawnEnv` and executable with which it began;
- durable-headless, model, and quota command paths receive the resolved executable and environment.

The checked-in, opt-in runtime acceptance check uses generic Linux Docker images with a deliberately
stripped parent PATH. Each image has a real passwd-backed user. It installs fake `claude`, `codex`,
`grok`, and `opencode` executables only in directories exported by that user's login shell, starts
the Podium probe in supervised-desktop mode, and asserts that all four are inventoried at absolute
paths and can be launched using the same effective PATH. Two materially different login shells must
pass so the proof is not specific to one distribution's profile behavior. The script exits cleanly
with an explicit skip when Docker is unavailable; hermetic unit tests remain the routine gate.

Release acceptance also includes one manual Finder launch on macOS: a Homebrew-installed Claude or
Codex that is absent from launchd's PATH must appear in inventory and successfully start. Linux
containers prove shell recovery and launch identity, not the launchd/Finder boundary itself.

## 9. Review disposition

The Fable 5 low review found no directional architecture issue. Its requested clarifications were
accepted: generation-tagged cache invalidation, verified-path reuse without launch-time lookup,
precise account fallbacks, desktop-marker scoping, model/durable/quota coverage, Windows preservation,
and a Docker proof backed by a separate macOS release check.

## 10. Non-goals

- Searching the entire filesystem.
- Running package-manager commands such as `brew --prefix` during discovery.
- Interpreting shell aliases or functions as executable harnesses.
- Moving provider login or transcript rules out of harness manifests.
- Adding harness knowledge to the Rust desktop shell.
- Changing Windows command discovery in this phase beyond preserving existing behavior.
