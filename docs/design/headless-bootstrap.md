# Headless Podium bootstrap on a fresh VPS

Investigation for issue #213 (epic #211). Parallel to #212 (managed logins / environment) and
#214 (GitHub auth). Convergence point: **a freshly-bootstrapped daemon self-registers and then
pulls its environment from the server.**

---

## 1. Where we actually stand

The issue says "today daemon setup is manual". That is now only half true, and the half that is
false matters, because it changes what we should build.

`install.sh` already is a one-command headless daemon bootstrap:

- platform detect (`install.sh:29`), download a release tarball,
- **verify an Ed25519 signature and fail closed** (`install.sh:74-78`),
- atomic install into `~/.local/share/podium`, symlink `~/.local/bin/podium`,
- with `--join <TOKEN>` delegate to `podium setup --join`, which writes config, renders the
  systemd **user** unit, `loginctl enable-linger`, `systemctl --user enable --now`,
- install a daily self-update timer (opt out with `--no-auto-update`).

`packages/core/src/join.ts` already carries `{serverUrl, pairCode, name}` in one base64url token,
minted by the server's Add-machine UI. Pairing is single-use, ~10 min TTL.

So "bring up a daemon and pair it" is **solved**. What is missing is everything around it:

| Gap | Evidence |
|---|---|
| Installs zero agent CLIs and zero dev tooling | `install.sh` has no such step |
| No way to choose harnesses | `install.sh:18-25` accepts only `--join`, `--channel`, `--no-auto-update` |
| Daemon reports nothing about itself | `PairFrame`/`HelloFrame` = `{machineId, hostname, token/code}` — `packages/protocol/src/messages.ts:689-701` |
| Server cannot know what a machine can run | `machines(id, name, hostname, token_hash, created_at, last_seen_at)` — `apps/server/src/migrations/002-core-schema.ts:559` |
| No server→daemon config/credential push | none exists; managed accounts are "Coming soon" — `apps/server/src/accounts.ts:1-7` |
| Missing harness binary fails silently | see §2 |
| Unit PATH omits where agent CLIs land | see §2 |
| linux-x64 only | `install.sh:29`, `scripts/release.ts:35` |
| `curl \| sh` 404s (private repo) | `docs/install-on-vps-private-repo.md` |

### The private-repo blocker

`curl -fsSL .../install.sh | sh` cannot work today: the repo is private, there is no stable
release (only rolling `edge`), and GitHub's browser release URLs ignore bearer tokens, so
`GH_TOKEN` does not rescue it. The documented workaround is to `gh release download` on a machine
that has access and `scp` the assets over.

**Any "one command on a fresh VPS" promise is blocked on this.** It is resolved by going public
(#12/#17/#18) or by hosting assets on our own origin. This is a dependency, not a detail.

---

## 2. Two live bugs found while mapping

Both are small, self-contained, and worth fixing independently of the bootstrap.

### 2a. A missing harness binary fails silently under abduco

The interactive spawn is wrapped in a try/catch that emits a `spawnError` control frame
(`apps/daemon/src/daemon.ts:1394-1400`). Under the **node-pty** backend a missing `claude` throws
ENOENT synchronously, hits that catch, and the user gets a real error.

Under the **abduco** backend — which is what we run — `abduco` itself exists and starts fine; the
missing agent binary fails inside `execvp`, so the session merely **exits nonzero**. There is no
`spawnError`. The user sees a dead black terminal.

It is made worse by the resolvers: `resolveOpencodeBin()` and `resolveCursorBin()` both fall back
to the bare name when no candidate validates (`packages/agent-bridge/src/opencode/cli.ts:40`,
`cursor/cli.ts:34`), turning a *knowable* "not installed" into a downstream ENOENT.

Availability probes already exist (`isOpencodeCliAvailable`, `isCursorCliAvailable`) but are used
only by the discovery provider to decide whether to enumerate conversations
(`discovery/providers/opencode.ts:56`). They are never consulted before spawn and never reported
to the server.

**Fix:** preflight the harness binary before spawn; emit a typed `harnessNotInstalled` error.
This is also the natural place to hang "…run `podium bootstrap --harnesses codex` to install it."

### 2b. The rendered systemd unit's PATH omits where agent CLIs land

`apps/cli/src/cli-systemd.ts:15-16` pins:

```
Environment=PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
```

But the official installers put binaries in `~/.bun/bin` (codex via npm/bun), `~/.opencode/bin`
(opencode), `~/.grok/bin` (grok). Only `claude` and `cursor-agent` land in `~/.local/bin`.

This is not theoretical. The daemon running on this dev box has a **hand-patched** unit:

```
Environment=PATH=/home/user/.local/bin:/home/user/.opencode/bin:/home/user/.bun/bin:/usr/local/bin:/usr/bin:/bin
```

Somebody already hit this and fixed it by hand. `codex` resolves to `~/.bun/bin/codex` here and
would be invisible to a stock unit. The bootstrap and the unit's PATH must be generated together.

---

## 3. Approach comparison

### 3.0 The distinction that decides everything

"Bring a server to a state and keep it there" is two problems, and every incumbent solves them
with two different mechanisms:

| | **Install once** (bootstrap) | **Converge continuously** (desired state) |
|---|---|---|
| Question | how do the bits arrive the first time? | how does the box stay correct, centrally? |
| Incumbent answer | signed `curl \| sh` + native package repo, or a baked image | **the product's own agent**, pulling policy from its own control plane |

Conflating them is what produces a "brittle shell script": a script that is *also* the tool
installer, *also* the version pinner, *also* the convergence loop. Each of those should be owned
by something else.

### 3.1 What the closest analogues actually ship

All four below are daemon + central-control-plane products — our exact shape. **None uses Ansible
or Nix.**

| Product | Bootstrap | Convergence |
|---|---|---|
| **Tailscale** | `curl -fsSL https://tailscale.com/install.sh \| sh` → detects distro, adds Tailscale's own apt/dnf repo, installs native pkg | **`tailscaled` pulls ACLs/routes/DNS/key-expiry from the coordination server, continuously** |
| **Docker** | `curl -fsSL https://get.docker.com \| sh` → wires the official repo, installs native pkg. Script self-warns "dev/test only" | none (native package manager) |
| **Coder** | Terraform template provisions compute | **`coder_agent` inside the workspace runs server-defined startup scripts**; reusable installs published as Terraform modules |
| **GitHub runners** | release tarball + `./config.sh --token` (1-hour token) + `svc.sh` | **re-image, don't converge** (`--ephemeral`, ARC recreates pods per job). Tool images built with **Packer + Bash**, no Ansible, no Nix |

Tailscale is the structural twin: signed daemon, central control plane, pairing step. It ships a
shell installer *and* a converging daemon. That is not a compromise, it is the pattern.

### 3.2 Options, judged against the column they actually serve

| Option | Serves | Root | Rootless `~/.local` | Verdict |
|---|---|---|---|---|
| **Signed install script** | install-once | no | ✅ | **Keep — but shrink its job** |
| **mise** | tool install + pinning | no | ✅ (`~/.local/share/mise`) | **Adopt for the tool layer** |
| **Our daemon** | converge | no | ✅ | **Adopt as the convergence engine** |
| `ansible-pull` | converge | mostly | ✗ awkward | Reject |
| Nix / home-manager / devbox | tool install + pinning | ⚠️ | ⚠️ fights | Reject (see §3.3) |
| chezmoi | config/dotfiles | no | ✅ | Maybe later, for config only |
| systemd sysext | atomic tool bundle | **yes** (`/usr`) | ✗ | Park; revisit for immutable bundles |
| asdf / proto / pkgx | tool install | no | ✅ | mise supersedes |
| cloud-init / image | install-once | ✅ | — | Generated wrapper over the script |

**`ansible-pull`** converges via a cron/systemd timer over a git repo of playbooks — but it needs
Python on every target, its useful modules assume system package managers and root, and doing
everything under `~/.local` degrades it to `shell:` tasks, i.e. a verbose YAML wrapper around the
shell we were trying to escape. Its one real win over us is the pull loop, which **our daemon
already has**.

### 3.3 Nix: a corrected assessment

An earlier draft of this doc claimed the agent CLIs are "effectively unpackaged in nixpkgs and all
ship self-updating vendor installers." **Both halves are false**, and the correction matters:

- `claude-code`, `codex`, `opencode`, `cursor-cli` and a community `grok-cli` are all in nixpkgs
  under `pkgs/by-name/`. On master when checked, `claude-code` was `2.1.204` vs upstream `2.1.205`
  — one patch behind. Only xAI's *official* Grok CLI is genuinely absent (third-party overlays
  such as `numtide/llm-agents.nix` cover it, updated daily with a binary cache).
- The self-update conflict is real but **already solved upstream**: nixpkgs' own derivation does
  `wrapProgram $out/bin/claude --set DISABLE_AUTOUPDATER 1`. opencode has
  `OPENCODE_DISABLE_AUTOUPDATE=1`. Codex does not auto-update in place at all — `codex update` is
  a manual command. `sadjow/claude-code-nix` fetches the prebuilt binary, `autoPatchelfHook`s it,
  disables the updater, and bumps multiple times a day from a Cachix cache.

So Nix is rejected on **operational** grounds, not packaging ones:

1. **Stable channels lag hard.** `release-25.05` pins `claude-code 1.0.85` — a full major behind.
   This only works if we commit the whole product to `nixpkgs-unstable` or a daily overlay, which
   `llm-agents.nix` itself warns "will break eventually" on a stable branch.
2. **Rootless Nix on an arbitrary VPS is a fight.** The Determinate installer needs root.
   `nix-user-chroot` needs unprivileged user namespaces, which Ubuntu 23.10+ gates behind AppArmor
   and many locked-down hosts disable. `nix-portable` works without root but falls back to PRoot,
   which is slow.
3. It buys reproducibility we can get from a **`mise.lock`** for a fraction of the adoption cost.

If we already loved Nix, the calculus would flip. We don't, and a small product team should not
take on a second runtime, store and GC model to install five CLIs.

### 3.4 Why not just use agent-flywheel (ACFS)?

**No — study it, don't adopt it.**

- It **takes over the whole host**: must start as root, creates an `ubuntu` user, and its default
  `--mode vibe` enables **passwordless sudo** and launches agents with
  `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`.
- It **auto-upgrades the host's Ubuntu release** to 25.10 across multiple reboots (~1.5–3 h, no
  rollback).
- Its default one-liner is `curl | bash` off `main` with a `?$(date +%s)` cache-buster — the
  *default* path is not the pinned one.
- It pins no downstream tool versions (Rust `nightly`, nvm `node`, "latest" installers).
- It is tightly coupled to ~16 bespoke tools (`ntm`, `am`, `ubs`, `bv`, `cass`, `dcg`, …).
- It installs claude/codex/gemini/antigravity — and **not** opencode, cursor or grok, i.e. three of
  our five harnesses.
- Its secrets story is a manual post-install `acfs services-setup`, exactly what #212 exists to
  eliminate.

Worth stealing (and we do, below): manifest→codegen as one source of truth,
checksum-verify-before-execute with a CI drift monitor, a resumable state machine, and
`doctor --json`.

### 3.5 Recommendation

Split the problem the way Tailscale does:

1. **Bootstrap** — keep the signed `install.sh`, and **shrink its job** to: install the podium
   daemon, install `mise`, pair to the server, exit. Caveat it as a convenience path exactly as
   Docker and Tailscale caveat theirs. Cloud-init and Docker become three-line wrappers.
2. **Tools** — **adopt `mise`.** Do not hand-roll a downloader/pinner/checksummer.
3. **Convergence** — **the daemon is the convergence engine**, driven by a desired-state document
   from the server. It writes `mise.toml` + `mise.lock` and shells out to `mise install`.
4. **Config + credentials** — over the daemon's existing authenticated channel (#212/#214).

The "brittle shell script" critique is fair, and it dies the moment the script stops being the
tool installer and the convergence loop.

Staying **rootless** remains a real differentiator versus ACFS. Every agent CLI and dev tool
installs fine into `$HOME`; root stays an opt-in (`--with-apt`) for `build-essential`, never a
precondition.

### What to take from ACFS (agent-flywheel)

Worth stealing:

- **Manifest → codegen as single source of truth.** `acfs.manifest.yaml` + Zod generates the
  installer scripts, the doctor checks, and the website. We already have the right shape for this
  (see §4).
- **Checksum-verify-before-execute.** Upstream installers are fetched to memory, SHA256'd against
  a committed `checksums.yaml`, executed only on match. A CI job auto-PRs on upstream drift. This
  is the correct posture for `curl | bash` of third-party code, and we already do the equivalent
  for our own tarball.
- **Resumable phase state machine** (`~/.acfs/state.json`) giving honest `--resume`,
  `--force-reinstall`, `--reset-state` — rather than hoping every step is naturally re-runnable.
- **`--list-modules` / `--print-plan` / `--dry-run`**, and a `doctor` with `--json` and `--fix`.
  The `--json` shape is directly interesting to us: it is exactly the inventory a daemon should
  report upward.

Explicitly **not** worth copying:

- Default `--mode vibe`: passwordless sudo plus agents launched with
  `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`.
- Default `curl | bash` off `main` with a `?$(date +%s)` cache-buster — the *default* command is
  not the pinned one; checksums cover upstream installers, not the ACFS script itself.
- Auto `do-release-upgrade` of the host to Ubuntu 25.10 across multiple reboots (~1.5–3 h, no
  rollback).
- No downstream version pinning (Rust `nightly`, nvm `node`, "latest" everywhere).
- Secrets as a manual post-install `acfs services-setup` step — precisely what #212 exists to
  avoid.

Also: ACFS installs Claude Code, Codex, Gemini and Antigravity. It does **not** install opencode,
cursor or grok, so there is no prior art to borrow for three of our five harnesses.

---

## 4. Recommended design

### 4.1 The manifest is the harness registry we already have

`packages/agent-bridge/src/harness/registry.ts` is an exhaustive, type-checked
`Record<HarnessAgent, HarnessAdapter>` whose stated contract is "new harness = one adapter file +
one entry here — a missing kind fails compilation."

Add an `install` descriptor to `HarnessAdapter` — but note what it is **not**: it is not a shell
recipe. It is a **mise tool spec** plus the facts our own code needs (PATH assembly, spawn
preflight, doctor).

```ts
install: {
  /** Where the binary lands, for PATH assembly and preflight (§2a, §2b). */
  binName: string          // 'claude' | 'codex' | 'grok' | 'opencode' | 'cursor-agent'
  /** A mise tool spec: npm:… | github:… | aqua:… | http:… */
  mise: string             // e.g. 'npm:@anthropic-ai/claude-code'
  /** Env this tool needs so it does not fight the version-owner (§4.1.1). */
  env?: Record<string,string>   // { DISABLE_AUTOUPDATER: '1' }
  /** How to prove it works. */
  verify: string[]         // ['--version']
}
```

The bootstrap's harness list, the unit's `PATH`, the spawn preflight (§2a), the generated
`mise.toml`, and `podium doctor` then all derive from **one** table that already fails compilation
when a harness is added without it. That is ACFS's manifest idea, in TypeScript with real types
instead of YAML plus a codegen step — and the actual *installing* is delegated to mise.

`mise` (https://mise.jdx.dev) is a rootless single static binary living in
`~/.local/share/mise`. Its backends cover everything we need: `npm:` (any npm CLI), `github:` /
`aqua:` (checksummed GitHub-release binaries), `http:` (arbitrary URL escape hatch), plus
first-class `bun`, `uv`, `node`. `mise.toml` pins versions; `mise.lock` pins exact versions,
checksums, sizes and URLs — reproducibility equivalent to a `package-lock.json`, which is the
piece Nix was going to buy us at far higher cost.

The dev-tooling set (`bun`, `uv`, `rg`, `fd`, `jq`, `fzf`, `gh`) becomes a handful of lines in the
same generated `mise.toml`.

> **Spike required before committing.** Verify against a real `mise`: that
> `npm:@anthropic-ai/claude-code` yields a working `claude`; that the official xAI `grok` (absent
> from every registry) needs the `http:` backend; and that `cursor-agent` can be pinned at all
> (§4.1.1). The `mise.lock` lockfile is still marked experimental upstream.

### 4.1.1 The sharpest edge: agent CLIs that self-update in place

This is the single hardest constraint in the whole plan, and it is **independent of which tool we
pick** — it bites Nix, mise, and sysext identically. A CLI that rewrites its own binary fights
whatever owns its version.

| Harness | Self-updates? | Opt-out |
|---|---|---|
| claude-code | yes, aggressively | `DISABLE_AUTOUPDATER=1` (+ `DISABLE_INSTALLATION_CHECKS=1`) — nixpkgs already wires this |
| opencode | yes, by default | `OPENCODE_DISABLE_AUTOUPDATE=1`, or `"autoupdate": false` |
| codex | **no** — `codex update` is manual | n/a |
| grok | unverified | unverified |
| cursor-agent | yes | **no clean documented opt-out** — the real sore spot |

Decision needed per harness: does the **server pin** the version (and we set the opt-out env), or
does the version **float** (and mise re-pins on the next convergence tick)? Pinning is the right
default for a fleet; floating is right for a single dev box that wants the newest Claude Code the
hour it ships. This wants to be a field on the desired-state document, not a global.

Note the opt-out envs must reach the **spawned agent's** environment, which is the same injection
seam #212 is building (`apps/daemon/src/daemon.ts:1350-1370`).

### 4.2 Controllability

Two surfaces, one source of truth.

**CLI (local intent):**

```
podium bootstrap --harnesses claude-code,codex   # closed enum from AgentKind; 'all' | 'none'
                 --tools rg,jq                    # closed enum; 'all' (default) | 'none'
                 --with-apt                       # allow sudo apt for build-essential &c
                 --list-modules --print-plan --dry-run
                 --force-reinstall | --reset-state
                 --inventory                      # emit the Inventory JSON of §4.4
```

Because both sets are closed enums, the flags validate up front and *name the valid set* rather
than failing later inside a vendor's installer — nicer than ACFS's `--only`/`--skip` module
composition. The spike demonstrates this:

```
$ ./scripts/bootstrap-spike.sh --harnesses claude-cod
xx unknown harness 'claude-cod' (known: claude-code,codex,grok,opencode,cursor)
```

**Join token (remote intent) — the convergence with #212:**

`JoinPayload` is already `{v, serverUrl, pairCode, name?}` and is minted by the server's
Add-machine UI. Extend it:

```ts
JoinPayload = { v: 2, serverUrl, pairCode, name?, harnesses?: HarnessAgent[], tools?: boolean }
```

Now the Add-machine dialog has checkboxes, and the pasted one-liner installs exactly the harnesses
the operator ticked. Bump `v` and keep `v:1` decoding for existing codes. This is the cheap,
correct place to make the agent set controllable *centrally*, and it needs nothing from #212.

### 4.3 Idempotence

A state file, `~/.podium/bootstrap.state`, one line per step:

```
<step-name>\t<fingerprint>
```

where fingerprint = hash of (recipe kind, url/pkg, pinned version, sha256). A step is skipped when
its fingerprint matches **and its binary is still present** — that second clause matters, because
state files lie after someone `rm`s a binary by hand. Changing a pin re-runs exactly that step.
`--force-reinstall` ignores the file; `--reset-state` deletes it. This gives honest resumability
without pretending each upstream installer is idempotent (several are not).

Verified in the spike against a stubbed step (no network):

| Situation | Behaviour |
|---|---|
| fingerprint matches, binary present | `skip fd (up to date)` |
| pin bumped (`v10.1.0` → `v10.2.0`) | re-runs `fd` only |
| binary deleted, state still says installed | re-runs `fd` |

One deliberate non-behaviour: a *fresh* state file with binaries already present re-installs them.
The fingerprint records which recipe we ran, not which version happens to be on disk, so an
externally-installed `claude` is not silently adopted. Reinstalling is how the bootstrap earns the
right to claim a known state. `--dry-run` shows this before it happens.

### 4.4 Self-registration and inventory — the prerequisite for everything else

Today the daemon tells the server `{machineId, hostname}` and nothing more. The server therefore
cannot render "this machine can run claude-code and codex but not grok", cannot route a session to
a machine that can actually run it, and cannot tell #212 which credentials a machine needs.

Extend the handshake (`packages/protocol/src/messages.ts:689-701`):

```ts
PairFrame  = { type:'pair',  code, machineId, hostname, name?, inventory: Inventory }
HelloFrame = { type:'hello', machineId, token, hostname,        inventory: Inventory }

Inventory = {
  os: 'linux' | 'darwin'
  arch: 'x64' | 'arm64'
  podiumVersion: string
  agents: { kind: HarnessAgent; version: string; path: string }[]
  tools:  { name: string; version: string }[]
}
```

Make `inventory` optional on the wire so an old daemon still pairs. Add the corresponding columns
(or a single `inventory_json`) to `machines`. Re-send inventory on every `hello`, i.e. on every
reconnect, so it self-heals after someone installs a CLI by hand.

`podium doctor --json` emits exactly this `Inventory`, so the bootstrap, the daemon, and the
operator all see one shape.

### 4.5 Where credentials do *not* go

**The bootstrap script must never handle a credential.** Its job ends at "daemon is running and
paired." Everything credential-shaped arrives afterwards over the already-authenticated daemon
channel, owned by #212 (harness logins, env, plugins) and #214 (GitHub).

This is not fastidiousness. The bootstrap is the one artifact users will paste into a terminal
from a `curl | sh`, often out of a chat window, sometimes into a shared box. Keeping secrets out of
its argv and its environment is the whole reason the pairing-code indirection exists.

Research turned up that all five agents' credentials are copyable 0600 files, and Codex even
documents `scp ~/.codex/auth.json`. That is tempting and should be resisted at *this* layer: a
subscription OAuth token carries the user's entire Max/Plus/SuperGrok plan quota, is not scopable
and not cheaply revocable. For a single-user VPS the user controls, copying is defensible; for
anything shared, API keys are the defensible choice. Either way that decision belongs to #212,
which can push the credential over an authenticated channel to a *known* machine — not to a shell
script holding a bearer token in `$@`.

The one thing the bootstrap owes #212: pair first, then **block until first environment sync**, so
that a user who runs the one-liner gets a machine that is actually ready, not one that is merely
connected.

### 4.6 OS/arch matrix

| Target | Status | Blocker |
|---|---|---|
| linux-x64 | shipping | — |
| linux-arm64 | wanted (Ampere, Pi, Graviton) | `bun build --compile --target=bun-linux-arm64` + an arm64 prebuilt `abduco` (`scripts/embedded-abduco.ts` embeds one arch) |
| darwin-arm64 | out of scope | desktop app covers it |
| Windows | out of scope | #14 decided desktop-only |

The abduco embed is the only real obstacle to arm64: `scripts/build-bun.ts` currently emits one
target and `dist-bun/abduco.bin` is a single prebuilt. Both need an arch dimension. All five agent
CLIs already ship arm64 builds.

---

## 5. Recommended sequencing

0. **Spike mise** (§4.1) against the five real harnesses. If `npm:@anthropic-ai/claude-code` and
   an `http:` grok do not work, the tool-layer decision reopens. Cheap, do it first.
1. **Fix the two bugs** (§2) — spawn preflight (#219) + generated unit PATH (#220). Independent,
   small, immediately useful.
2. **Inventory in the handshake** (#222, §4.4). Unblocks the server UI, routing, #212 and #214
   (which needs `gh` presence to decide whether a machine can receive a credential).
3. **`install` descriptors on `HarnessAdapter`** + **`podium doctor --json`** (#231, §4.1).
4. **Desired-state document + daemon convergence loop** (§3.5). Daemon writes `mise.toml`/`.lock`
   from the doc, runs `mise install`, reports actual state back via inventory. Reconcile on
   connect, on a timer, and on server push. Co-design the document with #212.
5. **Shrink `install.sh`** to: install daemon + mise, pair, exit. `--harnesses` becomes a hint
   written into the first desired-state request rather than shell that installs things.
6. **`JoinPayload` v2** with `harnesses[]` + Add-machine checkboxes (§4.2).
7. arm64, cloud-init snippet, Dockerfile — all generated from the same manifest.

Steps 1–2 are worth doing even if everything else is deferred, and they are already in flight.

`scripts/bootstrap-spike.sh` remains useful as the **fallback** if the mise spike fails, and as
the reference implementation of the fingerprint state machine and the `Inventory` JSON.

## 6. Open questions for the human

- **Does the mise spike pass?** (§4.1, step 0). Everything downstream keys off it.
- **Pin or float agent-CLI versions?** (§4.1.1). Recommend: server pins, with the vendor's
  auto-update opt-out env injected at spawn. Cursor has no clean opt-out — accept float there.
- **Should `podium bootstrap` block on first convergence** before declaring success? Recommend
  yes; otherwise "one command and it works" is not true.
- **Rootless-only, or `--with-apt` escape hatch?** Recommend rootless default, apt opt-in.
- The private-repo blocker (§1) gates the headline `curl | sh` UX. Is going public (#12) the plan,
  or should we host assets on our own origin sooner?
