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

| | Install script (sh) | Cloud-init / image | Nix | Devcontainer / Docker |
|---|---|---|---|---|
| Works on any existing VPS | ✅ | ⚠️ first boot only | ✅ (after nix install) | ⚠️ needs Docker |
| Works on a box you already own | ✅ | ❌ | ✅ | ⚠️ |
| Root required | ❌ (rootless) | ✅ | ⚠️ (multi-user) | ✅ |
| Reproducible pinning | ⚠️ manual (checksums) | ✅ (baked) | ✅✅ | ✅ |
| Idempotent re-run | ⚠️ must be engineered | ❌ (boot-once) | ✅✅ | ❌ (rebuild) |
| Agent CLIs available | ✅ (upstream installers) | ✅ | ❌ mostly unpackaged | ✅ |
| Cost to us | low | medium (per-cloud) | high | medium |
| Matches existing `install.sh` | ✅ | — | ❌ | ❌ |
| PTY / abduco / systemd fidelity | ✅ | ✅ | ✅ | ❌ (poor systemd) |

**Recommendation: extend the install script. Treat cloud-init and Docker as thin generated
wrappers over it, not as separate sources of truth.**

Reasoning:

- Nix is the only option with genuinely superior reproducibility, but the five agent CLIs are
  effectively unpackaged in nixpkgs and all ship their own self-updating native installers. We
  would be fighting both nixpkgs and the vendors. The cost is not repaid.
- Cloud-init only runs on first boot of a *new* instance. It cannot adopt the machine you already
  have, which is most of the real cases (a Hetzner box, a spare laptop, `vmi`). But a cloud-init
  `runcmd:` that invokes our script is three lines — so we get it for free.
- Docker/devcontainer models systemd and PTYs poorly, and our whole session model is abduco +
  systemd user units. ACFS learned this too: their Docker CI under-models systemd and they
  maintain a separate real-VPS QEMU test rig.
- Staying **rootless** is a real differentiator. ACFS demands root, creates an `ubuntu` user, and
  in its default `--mode vibe` enables passwordless sudo. Every agent CLI and every dev tool we
  need installs fine into `$HOME`. Root should be an opt-in (`--with-apt`) for `build-essential`
  and friends, never a precondition.

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

Add an `install` recipe to `HarnessAdapter`:

```ts
install: {
  /** Where the binary lands, for PATH assembly and preflight. */
  binName: string                 // 'claude' | 'codex' | 'grok' | 'opencode' | 'cursor-agent'
  binDirs: string[]               // ['~/.local/bin'] | ['~/.bun/bin'] | ['~/.opencode/bin']
  /** Non-interactive install, checksum-pinned. */
  recipe: { kind: 'curl-sh'; url: string; sha256?: string }
          | { kind: 'npm'; pkg: string; version?: string }
          | { kind: 'github-release'; repo: string; asset: (arch: Arch) => string }
  /** How to prove it works. */
  verify: string[]                // ['--version']
}
```

Then the bootstrap's harness list, the unit's `PATH`, the spawn preflight (§2a), and `podium
doctor` all derive from **one** table that already fails compilation when a harness is added
without it. That is the ACFS manifest idea, but we get it in TypeScript with real types instead of
YAML plus a codegen step.

The dev-tooling manifest (`bun`, `uv`, `rg`, `fd`, `jq`, `fzf`, `gh`) is a separate, simpler table
of the same recipe shape.

Verified install facts (2026-07):

| Harness | Recipe | Binary | Lands in |
|---|---|---|---|
| claude-code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude` | `~/.local/bin` |
| codex | `npm i -g @openai/codex` (node ≥22) **or** GitHub release musl binary | `codex` | npm bin / `~/.bun/bin` |
| grok | `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok` | `~/.grok/bin` → `~/.local/bin` |
| opencode | `curl -fsSL https://opencode.ai/install \| bash` | `opencode` | `~/.opencode/bin` |
| cursor | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent` (also symlinks `agent`) | `~/.local/bin` |

Prefer the **GitHub release musl binary** for codex so the bootstrap does not have to drag in a
Node ≥22 toolchain for one CLI.

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

1. **Fix the two bugs** (§2). Independent, small, immediately useful. Spawn preflight +
   generated unit PATH.
2. **Inventory in the handshake** (§4.4). Unblocks the server UI, routing, and #212.
3. **`install` recipes on `HarnessAdapter`** + `podium doctor --json` (§4.1).
4. **`podium bootstrap`** driven by that manifest, with the state file (§4.3) and the flags (§4.2).
   Ship `install.sh --harnesses …` as a thin front-end that installs podium then calls it.
5. **`JoinPayload` v2** with `harnesses[]` + Add-machine checkboxes (§4.2).
6. **Checksum pinning + CI drift monitor** for third-party installers.
7. arm64, cloud-init snippet, Dockerfile — all generated from the same manifest.

Steps 1–2 are worth doing even if the rest is deferred.

## 6. Open questions for the human

- **Codex via GitHub release binary vs npm?** The release binary avoids a Node ≥22 dependency for
  a single CLI. Recommend the binary; npm as fallback.
- **Should `podium bootstrap` block on first environment sync** (§4.5) before declaring success?
  Recommend yes — otherwise "one command and it works" is not true.
- **Rootless-only, or `--with-apt` escape hatch?** Recommend rootless default, apt opt-in.
- The private-repo blocker (§1) gates the headline `curl | sh` UX. Is going public (#12) the plan,
  or should we host assets on our own origin sooner?
