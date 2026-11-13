# Managed installs: Podium installs a harness and keeps it current

Design proposal for POD-6880, the design task of the Managed installs phase
(POD-6865) of POD-6858. Revision 1, 2026-11-13. Not yet reviewed.

It builds on the harness access contract (`harness-access-contract.md`,
section 6) and on session posture (`harness-session-posture.md`, section 9).
Podium code is cited from `integrate/6858-harness-launch-configuration` at
`f82a179e4c`.

Evidence tags in this document: **script** = read in the vendor's own installer,
fetched 2026-11-13; **disk** = seen on this machine; **live** = run on this
machine; **doc** = vendor documentation or Podium's harness reference;
**unmeasured** = not yet checked, listed for the spike in section 7.

## 1. The problem

A person picks a machine and a harness in Podium. If that harness's CLI is not
on the machine, or is older than Podium can drive, the session cannot start, and
Podium can only say "install it yourself". On a fresh VPS that is the first
thing a new user meets.

Podium can already run a vendor's installer once, during machine setup. It
cannot say afterwards which installs are its own, it never updates them, and it
cannot remove them.

### What Podium does today

- **Finding a CLI.** The inventory looks each harness up on the machine's
  command path, plus a few known folders, runs `--version`, and reports
  installed, version, path and login (`inventory/build-inventory.ts`). It
  repeats that every minute and on request.
- **Installing a CLI.** Machine setup can run the adapter's install section
  once, through the installer's `--agents` option
  (`apps/cli/src/install-finish.ts`, `install-agents.ts`,
  `inventory/install.ts`). Three adapters have one: Claude Code, Codex and
  Grok. OpenCode, Pi and Cursor decline with a reason.
- **Where it lands.** In the person's own `~/.local/bin`, with whatever else
  the vendor's installer writes.
- **Afterwards.** Nothing. The install is indistinguishable from one the
  person made. Whether it updates depends on the vendor's own updater.

### What a vendor installer writes

Read from the six installers:

| Harness | Binary goes to | What else it writes |
|---|---|---|
| Claude Code | `~/.local/share/claude/versions/<version>`, a link at `~/.local/bin/claude` | `~/.claude/downloads`, shell setup (**script**) |
| Codex | `$CODEX_HOME/packages/standalone/releases/<version>-<platform>/`, a `current` link, a link in the bin folder | a `PATH` block in a shell profile, an `auto-update-version` file, and it deletes older releases it finds unused (**script**) |
| Grok | `~/.grok/bin/grok-<version>`, links | `[cli] installer` and `channel` in `~/.grok/config.toml`, shell completions, a `PATH` line in a shell rc file (**script**) |
| OpenCode | `~/.opencode/bin/opencode` | a `PATH` line in a shell rc file unless `--no-modify-path` (**script**) |
| Pi | under `~/.pi/agent`, or an npm prefix | may install Node; a marker file (**script**) |
| Cursor | `~/.local/share/cursor-agent/versions/<version>/`, links in `~/.local/bin` | nothing else seen (**script**) |

So "run the vendor installer" means edits to the person's shell profile and
harness config, in places Podium does not track.

### Vendors update on their own

On this machine, with no action from Podium (**disk**):

- Claude Code holds six versions, 2.1.301 to 2.1.323; the newest arrived last
  night.
- Codex holds three releases and moved from 0.167.1 to 0.167.2 during the
  posture research.
- Grok moved from 1.0.46 to 1.0.77.

A vendor's updater writes into the person's home and repoints the link that
every new process follows. If Podium owns an install, two updaters would be
changing it.

### Releases are frequent and large

- Claude Code's `latest` pointer reads 2.1.323 and its `stable` pointer
  2.1.311 (**live**, 2026-11-13). On this machine the installed version rose
  from 2.1.301 to 2.1.323 in four weeks (**disk**).
- One Claude Code binary is 362 MB, Grok 201 MB, OpenCode 185 MB (**disk**).

Following Claude Code's `latest` would download several gigabytes a month on
every machine.

### What the access contract already gives

- `HarnessInstallation` (executable, version) is built from the inventory and
  pinned on every session's context. Its comment leaves room for a
  `managed | external` field.
- Every harness process is started from that pinned value
  (`harnessCommand(context, argv, terms)`), never from a name on the path.
- "An update becomes 'publish a new installation generation; running sessions
  keep theirs'" (access contract, section 6).

So a managed install only has to become one more place the inventory finds an
executable. Nothing that starts a process has to change.

## 2. What "managed" has to mean

| # | Requirement |
|---|---|
| M1 | Podium installs a harness only when a person asked for it. |
| M2 | Everything Podium installs sits inside Podium's own folder. Nothing is written to the person's `~/.local/bin`, shell profile or harness config. |
| M3 | A managed install is marked as Podium's, and only Podium changes it. The vendor's own updater is off for it. |
| M4 | Podium keeps it at the vendor's newest stable release at or above the minimum version, in the background, without asking. |
| M5 | An update never touches a running harness process. |
| M6 | A failed update leaves the machine exactly as it was. A bad release can be left again, by Podium or by the person. |
| M7 | An install the person made is still found, used and left alone. |
| M8 | Podium can list what it put on a machine, and take it away again. |

## 3. The design

### 3.1 The idea

Podium keeps each release of a harness in its own folder, under Podium's state
folder. A folder is filled, checked, and from then on never changed. One small
record says which folder is the current one.

Installing and updating are the same act: fill a new folder, check it, move the
record. Rolling back is moving the record to the folder before. A running
process keeps the folder it started from, because nobody writes to it.

The inventory looks at that record first, then at the machine's command path.
Whichever it finds becomes the session's pinned installation, tagged `managed`
or `external`. Everything after that is the access contract, unchanged.

### 3.2 Where each part runs

| Part | Runs in | Crosses the network |
|---|---|---|
| Deciding to install, pause, go back or remove | a person, in a client or the CLI | one request to the machine's daemon |
| Asking the vendor for the newest release | daemon, on the harness's machine | one small request to the vendor |
| Downloading, checking, publishing | daemon | the download from the vendor |
| The record of what Podium owns | a file on that machine | never |
| Choosing the executable for a session | daemon (inventory) | never |
| Reporting state | daemon to server to clients | inside the inventory report that already exists |

The server stores what a machine reports and passes requests on. It makes no
version decision. Each machine updates itself, so two machines can be on
different releases for a few hours, as they can today.

### 3.3 Where the binaries live

```
<Podium state folder>/harnesses/
  ledger.json              what Podium owns on this machine (3.11)
  lock                     one installer at a time
  claude-code/
    7-2.1.311/             one release, complete; never changed after publishing
      receipt.json         harness, version, source, checksum, when
      …                    laid out as the adapter chose
    8-2.1.318/
    .staging-4f2a/         an install in progress; never selected
  codex/
    3-0.167.2/
```

- **The state folder** is the instance's own (`stateDir()`: `~/.podium`, or the
  named instance's folder). A named or test instance therefore has its own
  installs and cannot change another instance's. The cost is disk when two
  instances on one machine both manage the same harness; that is rare and each
  install is asked for.
- **One folder per install**, named `<number>-<version>`. The number counts up
  per harness. Installing the same version again (a repair) makes a new folder.
  That keeps the rule simple: a published folder is only ever read or deleted.
- **No link named `current`.** The current folder is a field in the ledger, and
  the inventory hands sessions the full path. This works the same on Windows,
  where making a link needs extra rights, and a process never follows a link
  that moved under it.
- **Not on anyone's command path.** Podium starts harnesses by full path, so it
  needs none. Typing `claude` in a login shell does not find a managed install.
  Section 6 has an open question about Podium's own sessions.

### 3.4 What an adapter says

Decided: the install procedure lives in the adapter and is called through the
shared contract. Today's section says "run this script into this bin folder".
It becomes:

```ts
/** One vendor release, as the vendor names it. */
export interface HarnessRelease {
  version: string
}

export interface HarnessInstall {
  /**
   * The newest release on the vendor's stable channel for this platform.
   * One small request. Never a pre-release.
   */
  latest(ports: HarnessInstallPorts): Promise<HarnessRelease>
  /**
   * Put `release` into the empty folder `dir`, and write nowhere else.
   * Throws with the vendor's own output on failure.
   */
  install(release: HarnessRelease, dir: string, ports: HarnessInstallPorts): Promise<InstalledRelease>
}

export interface InstalledRelease {
  /** The executable, relative to `dir`. */
  executable: string
  /** What proved the download. */
  integrity:
    | { kind: 'sha256'; digest: string; publishedAt: string }
    | { kind: 'none'; reason: string }
}
```

`HarnessInstallPorts` keeps what it has (`fetch`, `run` by full path, `runTool`,
`arch`, `isMusl`, `note`) and gains:

- `platform`, so one section covers Linux, macOS and Windows or declines one.
- `home`: an empty folder inside `dir`. An adapter that runs the vendor's
  installer runs it with `HOME` (and the harness's own home variable) set to
  this folder, so the profile edits and config writes in section 1 land inside
  the release folder and nowhere else.
- `env`: the machine's command environment with every credential variable
  removed. Never the daemon's own environment.

The ports are asynchronous. Today's are synchronous, which is fine in the CLI
and would freeze a daemon for the length of a 360 MB download.

The section stays `supported` or `unsupported` with a reason. A harness can be
managed only when all three hold:

1. A release can be placed completely inside a folder Podium picks.
2. Its own updater can be kept off for each launch (3.9).
3. `--version` prints the release's version.

**An adapter may download the vendor's published file itself or run the vendor's
installer in the contained home.** Where a vendor publishes a file with a
checksum, the adapter should download it directly: an installer script also
edits profiles, asks questions, links things and prunes old releases, and none
of that is wanted here. The Claude Code adapter already has this path
(`installClaudeStandalone`), written as a fallback.

### 3.5 Installing one release

The mechanism is the same for every harness and names none
(`inventory/install.ts`, extended). Steps, in order:

1. Take the install lock.
2. Make `.staging-<random>/` under the harness's folder.
3. Call the adapter's `install(release, staging, ports)`.
4. Check the result, from outside the adapter:
   - the executable exists inside the staging folder;
   - `<executable> --version`, run in the machine command environment, exits 0
     within the probe timeout;
   - the version it prints is the release asked for;
   - that version is at or above the harness's minimum
     (`gateHarnessVersion` is not `too-old`);
   - the adapter's identity probe accepts it, where one is declared.
5. Write `receipt.json`, flush to disk, rename the staging folder to
   `<number>-<version>/`.
6. Write the ledger: the new folder is `current`, the old current is
   `previous`.
7. Release the lock and ask the inventory to look again (`reprobe()`), so new
   sessions get the new installation.

Decided: there is no per-release verification by Podium. Step 4 checks that the
download is intact and starts; it does not check that the release behaves.

A crash at any step leaves either a staging folder or a numbered folder the
ledger does not name. Both are deleted by the sweep at daemon start (3.7).
Until step 6 completes, nothing reads the new folder.

### 3.6 Which install a session gets

The inventory asks, per harness, in this order, and takes the first that passes
its existing version and identity probe:

1. the managed `current`, if the ledger names one;
2. the managed `previous`, if the current one fails the probe;
3. the names on the machine command path, then the adapter's known folders, as
   today.

`HarnessInstallation` gains the field the access contract left room for:

```ts
export interface HarnessInstallation {
  readonly kind: BuiltinHarnessKind
  readonly executable: string
  readonly version: string
  readonly generation: number
  /** Podium installed it and updates it, or the person did. */
  readonly provenance: 'managed' | 'external'
}
```

What that means for a person:

| On the machine | Podium uses | Podium updates |
|---|---|---|
| Only the person's own install | theirs | nothing. It only quiets update menus, as posture does today. |
| No install | none. The harness shows "not installed" with an **Install** action. | n/a |
| Only a managed install | the managed one | yes |
| Both | the managed one | the managed one only. The person's own is never touched. |

- A managed install exists only because someone asked: at machine setup
  (the installer's `--agents` option), or with the Install action. So when one exists it
  is the one in use, and removing it returns the machine to the person's own
  install. No separate "which one" setting is needed.
- **Too old.** When the person's own install is below the minimum, Podium
  refuses to start it, as today. The refusal gains one action: "Install a
  current version for Podium". It is never done silently.
- **No takeover.** Podium does not adopt an install the person made and does
  not move or update it. "Let Podium manage this" installs Podium's own copy
  beside it.

The installer's `--agents` option at machine setup installs into this layout
instead of `~/.local/bin`.

### 3.7 When updates run

A check is one call to the adapter's `latest()`. It runs:

- shortly after the daemon starts, off the connection path, so a slow vendor
  host cannot delay a reconnect;
- every six hours while the daemon runs, with up to thirty minutes of random
  delay, so a fleet does not arrive at a vendor host together;
- when a person asks ("Check now").

A check leads to an install (3.5) when the version it returns is newer than the
current one, is at or above the minimum, is not on the rejected list (3.8), and
updates are not paused for that harness. Otherwise nothing happens.

**Updates do not wait for the machine to be idle.** An install fills a new
folder and moves a record. No running process reads either. So the sketch's
rule "never during a turn" holds by construction, and there is nothing to
schedule around.

**"Latest" means the vendor's stable channel.** Claude Code and Grok publish a
stable pointer next to faster channels (**live**, **script**); for Codex it is
the newest release that is not a pre-release. This is what the vendor's own
installer picks, it avoids releases the vendor has not promoted yet, and for
Claude Code it is roughly a weekly download instead of a daily one.

**Housekeeping** runs with every check and at daemon start. It deletes:

- every `.staging-*` folder;
- every numbered folder that is not `current`, not `previous`, and has no
  running process (3.8 says how that is known).

So a harness normally occupies two releases on disk.

### 3.8 Running sessions

**A process keeps the release it started from.** Its folder is not written to
and is not deleted while the process lives.

**The next process takes the current release.** When Podium starts a new
process for a session that already exists (a restart, a resume, an engine
waking, the next turn of a one-process-per-turn harness), that process is built
from the inventory as it stands then.

- For a spawn this is today's behaviour: every spawn, a restart or a resume
  included, builds a fresh context (`buildSessionHarnessContext`).
- For an engine waking it is a change. Today a waking engine reuses the context
  the session was first spawned with, for as long as the daemon lives
  (`engineSessionHarnessContext`, POD-6546). With that rule a session parked for
  a month would pin a release for a month, and fifty parked sessions could pin
  fifty releases of 360 MB each. So: when the session's pinned installation is
  managed and no longer the current one, a wake builds a new context.
- The guarantee POD-6533 was made for stays: within one launch, hook
  installation, posture and the process all read one context.

**Knowing which releases are in use.** The daemon forgets its sessions'
contexts when it restarts, while the harness processes live on in their hosts.
So "in use" cannot be kept in daemon memory. The ledger keeps it:

- when a process starts on a managed release, the daemon records
  `session → release`;
- when that process ends, the entry goes;
- at daemon start, entries for sessions that did not survive are dropped.

Two things use that record. Housekeeping never deletes a release with an entry.
And when the daemon re-attaches to a surviving session after a restart, it
rebuilds that session's context from the recorded release instead of from
whatever is current, so the context names the binary that is really running.
Today a rebuilt context names the current install even when the process is
older.

### 3.9 The vendor's own updater

Posture already receives the pinned context (`PostureRequest.context`). When
`context.installation.provenance` is `managed`, the adapter's posture section
adds that harness's updater switch to the launch, in every launch mode. This is
the second meeting point named in posture section 9.

| Harness | Switch | Evidence |
|---|---|---|
| Claude Code | `DISABLE_AUTOUPDATER=1` | **doc**; the name is in the installed binary (**disk**). Effect from a managed folder: **unmeasured**. |
| Codex | `-c check_for_update_on_startup=false` | removes the notice and the menu (**live**, posture spike). Codex's standalone build also updates itself in the background (the `auto-update-version` file, **script**); whether that runs for a binary outside `$CODEX_HOME/packages/standalone`: **unmeasured**. |
| Grok | `GROK_DISABLE_AUTOUPDATER`, or `auto_update = false` under `[cli]` | both in Grok's installed documentation (**disk**); effect **unmeasured**. |
| OpenCode | `OPENCODE_DISABLE_AUTOUPDATE=1` | already used by Podium's OpenCode engine. |
| Pi | none known to be needed: Pi shows a notice and updates on `pi update`. `PI_SKIP_VERSION_CHECK=1` hides the notice. | notice **live** (posture spike); that it never updates by itself: **unmeasured**. |
| Cursor | unknown | **unmeasured** |

For an external install nothing changes: Podium does not decide its update
policy and only stops update menus from blocking a session.

A harness whose updater cannot be kept off cannot be managed (3.4, condition
2). Its updater would write new binaries into the person's home.

### 3.10 The harness home stays where it is

Open question from the brief: does a managed install also get a harness home
that Podium owns?

**Proposed: no. The binary and the home stay two separate choices.**

- The access contract separates them on purpose: `HarnessInstallation` is a
  fact about the machine, the home belongs to the account. A managed install
  runs against the same home an external one would.
- The home holds the login, the settings and every past conversation. If
  switching to a managed binary also switched the home, a person whose own CLI
  was too old would click "Install a current version" and find themselves
  signed out, with an empty history.
- A person who lets Podium manage Codex and later installs their own for use in
  a shell expects both to show the same conversations.
- Podium already has a home it owns, for the cases that need one: the agent
  home of a named instance, or `PODIUM_AGENT_HOME`. Whether the default instance
  should use one is a question about accounts and credentials
  (`managed-accounts-and-environments.md`), with costs of its own: signing in
  again or copying credentials, a split history, and readers of quota and usage
  that must follow.

What this phase does for the home instead:

- **Installers never see it.** They run with the contained home of 3.4.
- **Podium's edits to it are recorded** (3.11), so the two edits posture makes
  can be listed and undone. Those edits still reach the person's own use of
  that harness, as posture 4.7 accepted.

One measurement could reopen this. Claude Code writes `installMethod` and
`autoUpdates` into `~/.claude.json` when it exits (**live**, posture spike). If
a managed binary running against a home shared with the person's own install
changes how that install updates, the two cannot share a home after all. It is
on the spike list.

### 3.11 The ownership ledger

Posture deferred this: "the ownership record belongs to the managed-installs
phase, where its second user appears." It is one file per instance per machine,
`<state folder>/harnesses/ledger.json`. It answers one question: what on this
machine exists because Podium put it there?

```ts
interface OwnershipLedger {
  schema: 1
  installs: Partial<Record<BuiltinHarnessKind, ManagedInstall>>
  inUse: Record<SessionId, { kind: BuiltinHarnessKind; release: number }>
  homeEdits: HomeEditRecord[]
}

interface ManagedInstall {
  nextNumber: number
  current: ManagedRelease | null
  previous: ManagedRelease | null
  /** Versions Podium will not install again, and why. */
  rejected: { version: string; reason: string; at: string }[]
  /** A person paused updates. */
  paused: boolean
  requested: { by: 'machine-setup' | 'person'; at: string }
  lastCheck:
    | { at: string; ok: true; latest: string }
    | { at: string; ok: false; error: string }
  lastInstallError?: { at: string; version: string; error: string }
}

interface ManagedRelease {
  number: number
  version: string
  /** Relative to the harness's folder. */
  dir: string
  /** Relative to `dir`. */
  executable: string
  integrity: InstalledRelease['integrity']
  installedAt: string
  /** A session has started on it (3.12). */
  proven: boolean
}

interface HomeEditRecord {
  harness: BuiltinHarnessKind
  home: string
  file: string
  edit:
    | { kind: 'json-key'; path: string[]; value: JsonValue }
    | { kind: 'owned-file'; sha256: string }
  /** What was there before Podium's first write: nothing, a key's value, or a file's text. */
  prior: { absent: true } | { value: JsonValue } | { contents: string }
  serves: PostureRequirement
  appliedAt: string
}
```

Rules:

- **One writer at a time.** Every write takes the lock, reads the file, changes
  it, writes beside it and renames over it. The daemon and the CLI (machine
  setup can run before a daemon exists) use the same code.
- **The daemon reads it on every inventory wave.** It is small, and that is how
  an install made by the CLI becomes visible without a restart.
- **Managed installs** are the `installs` entries. Every folder under
  `harnesses/<kind>/` is either named here or deleted by housekeeping.
- **Home edits** are recorded when Podium's write changed the file (the
  `applied` outcome of `applyHomeEdits`), with the value that was there before.
  When the home already held the value and the ledger has no record, the person
  put it there, and it is not Podium's. In steady state nothing is written, as
  today.
- **Undoing a home edit** restores the prior value, and only while the file
  still holds the value Podium wrote. A value the person changed since is left.
- **When undo runs.** On request ("Remove Podium's changes" for a harness, or
  `podium harness changes --undo`), and when Podium is removed from the machine.
  Not when a repository is removed from Podium: the person may rely on that
  trust in their own sessions by then.
- **A damaged ledger** is set aside under another name and rebuilt from the
  receipts in the release folders: the highest number per harness becomes
  current. Home-edit records are lost in that case; the edits themselves are
  re-derived at the next launch, and from then on count as not Podium's. The
  machine reports that the ledger was rebuilt.

### 3.12 Failure and rollback

| What goes wrong | What happens |
|---|---|
| The vendor cannot be reached for a check | Nothing changes. The error and time are recorded. The next check tries again. |
| The download breaks, the checksum is wrong, the installer fails, the disk is full | The staging folder is deleted. The current release stays. The error is recorded and reported; the next check tries the same version again. |
| The new binary does not run, prints another version, or is below the minimum | The staging folder is deleted and the version goes on the rejected list. It is not tried again. A later release is. |
| The new release passes the check but sessions will not start on it | Automatic rollback, below. |
| The person finds the new release worse | "Go back to `<previous>`": the record moves back and the version goes on the rejected list, so the updater does not bring it straight back. A newer release ends the hold. |
| The current release's files are damaged or deleted | The inventory's probe of it fails and it falls back to the previous release, then to the person's own install. The next check installs the current version again, as a new folder. |
| The daemon dies mid-install | Section 3.5: nothing was published. The leftovers are swept. |
| A person pauses updates | The harness stays on its release until they resume. Shown wherever the version is shown. |

**Automatic rollback.** A new release is *unproven* until one session has
started on it. Podium does not verify vendor releases, and a managed install
brings every new one to every machine without anyone choosing it. A flag the
vendor renamed would stop every session on every machine at once.

So, for an unproven release only:

1. A session start fails before the harness shows any sign of life (the process
   exits non-zero before its first hook event, engine handshake or first
   output).
2. The daemon builds the same launch once more on the previous release, which
   was proven.
3. If that starts: the new release is at fault. The record moves back, the
   version goes on the rejected list, and the machine reports "`<harness>`
   `<version>` would not start here; staying on `<previous>`".
4. If that fails too: the release is not the cause. The record stays, and the
   failure is shown as any start failure is today.

A release that has started one session is proven and is never rolled back
automatically.

### 3.13 What a person sees

The inventory report gains, per harness: `provenance`, and for a managed
install its version, previous version, the vendor's newest version as last
seen, the time of the last check, whether updates are paused, and the last
error. All optional on the wire, so an older server or daemon ignores them.

On a machine's harness list:

| State | Shown | Actions |
|---|---|---|
| Not installed | "Not installed" | Install |
| The person's own | "2.1.300 · your install" | Let Podium manage |
| The person's own, too old | "2.1.100 · your install · too old for Podium" | Install a current version |
| Managed | "2.1.311 · managed by Podium · checked 2 h ago" | Check now, Go back to 2.1.305, Pause updates, Remove |
| Managed, installing | "Installing 2.1.318…" | none |

Podium says nothing when an update succeeds. It raises one notice per harness
and machine when an update was rolled back, when updates have failed for three
days, or when the ledger was rebuilt.

The CLI gets the same verbs for a machine: list, install, check, go back,
pause, resume, remove, and "show what Podium changed here".

**Remove** deletes the harness's releases once no process uses them, deletes
its ledger entry, and offers to undo the home edits recorded for that harness.
It does not touch the home's login or history.

### 3.14 What each harness needs

The target. Cells marked unmeasured are filled by the spike before any adapter
work starts.

| Harness | Newest stable release | File and integrity | Kept inside Podium's folder by | Managed in this phase |
|---|---|---|---|---|
| **Claude Code** | `downloads.claude.ai/claude-code-releases/stable` (**live**) | `<version>/<platform>/claude`, SHA-256 in `manifest.json` (**script**); Windows platform name **unmeasured** | direct download; no installer runs | yes |
| **Codex** | `releases.openai.com/codex`, GitHub Releases as fallback (**script**) | a package archive, SHA-256 in `codex-package_SHA256SUMS` (**script**) | direct download, or the installer with `CODEX_RELEASE`, `CODEX_INSTALL_DIR` and a contained `CODEX_HOME` and `HOME` | yes |
| **Grok** | `x.ai/cli/stable` (**script**) | `grok-<version>-<platform>`; the installer checks no checksum, only that the binary runs (**script**) | direct download | yes, with integrity `none` recorded |
| **OpenCode** | newest GitHub release of `anomalyco/opencode` (**script**) | a release archive; the installer checks no checksum (**script**) | direct download | yes, once the release list and archive layout are measured |
| **Pi** | `pi.dev/api/installer/releases` (**script**) | standalone binaries with `SHA256SUMS` (**doc**) | direct download; its installer may install Node and is avoided | yes, once measured |
| **Cursor** | only inside the installer script, which names one version (**script**) | a package archive, no checksum seen (**script**) | direct download | no: no way to keep its updater off is known |

## 4. How robust it is

- **Nothing shared is written during an update.** A release folder is written
  once, before anything reads it. The only thing that changes afterwards is one
  small file, replaced by rename.
- **Every step can stop.** Section 3.12 has an outcome for each failure, and in
  each the previous release is still there and still selected.
- **The person's own install is a safety net.** If every managed release fails
  its probe, the inventory finds theirs.
- **A vendor outage costs nothing.** No check, no change.
- **Two checks back the design**, as in posture:
  1. *Conformance, every build.* For every adapter with an install section,
     against a fake vendor host: `latest` and `install` write only inside the
     folder they were given (a decoy home and decoy profile files stay
     untouched), and the mechanism's steps hold under injected failure at each
     step. For every harness and launch mode, a managed installation's posture
     includes the updater switch.
  2. *One acceptance run.* On a fresh machine in the VPS lab with no harness
     installed: install each managed harness, start a session, publish a newer
     release from a stand-in vendor host, see new sessions move while a running
     one stays, break a release and see the rollback, remove everything and
     find the home and the profile files as they were.

## 5. What changes for existing code

| Today | After |
|---|---|
| `HarnessInstall { binary, url, runInstaller }`, synchronous | `latest` and `install` into a given folder, asynchronous (3.4) |
| `runInstallTarget(target, binDir)` writes into `~/.local/bin` | the mechanism of 3.5, into `<state>/harnesses/` |
| The installer's `--agents` option installs once and forgets | installs a managed release and records it |
| The inventory looks on the command path | the ledger first, then the command path (3.6) |
| `HarnessInstallation` has no provenance | `provenance: 'managed' \| 'external'` |
| Posture only quiets update menus | it also turns the vendor's updater off for a managed install (3.9) |
| A waking engine reuses the first context while the daemon lives | it takes the current release when its own is managed and no longer current (3.8) |
| A re-attached session's context names the current install | for a managed release it names the recorded one (3.8) |
| `applyHomeEdits` keeps no record | `applied` outcomes are recorded with the prior value (3.11) |
| The inventory report has installed, version, path | plus provenance and the managed state (3.13) |

Unchanged: `harnessCommand`, `harnessChildEnv`, the spawn sites, how an external
install is found, the minimum-version policy, and posture for external installs.

## 6. Decisions

### Made by the operator before this design

1. The install procedure lives in the harness adapter and is called through
   the shared contract.
2. An install Podium made is marked managed, and Podium is responsible for
   updating it.
3. A harness has a minimum version only. A managed install takes the vendor's
   latest release at or above it, with no per-release verification.
4. An existing install must still be detected and used.

### Calls I made, for review

1. **Binaries live under the instance's state folder**, one folder per install,
   never changed after publishing, with the current one named in a record
   instead of a link (3.3).
2. **Adapters download the vendor's file directly where it has a checksum**,
   and otherwise run the installer inside a contained home (3.4).
3. **"Latest" is the vendor's stable channel** (3.7).
4. **A managed install, when present, is the one used.** No separate setting
   (3.6).
5. **Podium never installs silently and never takes over the person's own
   install** (3.6).
6. **Checks run at daemon start and every six hours; an update runs as soon as
   one is found**, without waiting for idle (3.7).
7. **A process keeps its release; a session's next process takes the current
   one.** This changes what a waking engine does (3.8).
8. **The ledger records which sessions run on which release**, so housekeeping
   and re-attach after a daemon restart are exact (3.8).
9. **Two releases stay on disk**: current and previous, plus any in use (3.7).
10. **Automatic rollback for an unproven release**, by starting the same launch
    once on the previous release (3.12).
11. **No Podium-owned harness home comes with a managed install** (3.10).
12. **One ledger file per instance per machine** holds managed installs, in-use
    records and home edits; home edits are undone only on request or when
    Podium leaves the machine (3.11).
13. **Cursor is not managed in this phase**; Claude Code, Codex and Grok are
    first, OpenCode and Pi follow (3.14).

### Open questions for the operator

1. **Should Podium's own sessions find a managed harness by name?** An agent in
   a Claude session that runs `codex exec` for a second opinion finds nothing
   on a machine where Codex is only managed. Podium could add one folder of
   links to current releases at the end of the path it gives its own sessions,
   after everything the person has. Proposed: yes, in a follow-up task, because
   it works without it and it is the only place a link would exist.
2. **Is automatic rollback (call 10) wanted in the first version?** Without it,
   a release that breaks session start stays until a person clicks "Go back".
   With it, the first failed start on a new release costs one extra launch.
   Proposed: yes.
3. **Is the stable channel right (call 3)?** For Claude Code it is about twelve
   versions behind `latest` today. The alternative is a per-harness channel
   setting. Proposed: stable only, no setting.

## 7. Order of work

To be split into tasks once the design is agreed. Proposed tasks, in order:

1. **Spike: measure the open cells.** No product code. For each harness, in a
   fresh folder and against a fresh home and against a home shared with a
   vendor-made install: does the binary run from a Podium folder; does the
   updater switch of 3.9 keep it from writing anywhere; what Codex's background
   updater does for a binary outside its own package folder; whether a managed
   Claude Code changes `installMethod` or `autoUpdates` for the person's own
   install; the stable pointer and file layout for OpenCode, Pi and Windows
   builds. Fills 3.9 and 3.14.
2. **Ledger.** The file, the lock, read-change-write, rebuild from receipts.
3. **Install contract and mechanism.** The new section shape, the steps of
   3.5, housekeeping, the conformance test with a fake vendor host.
4. **Inventory and provenance.** The ledger as first candidate,
   `provenance` on `HarnessInstallation`, the wire fields.
5. **One task per harness**: Claude Code, Codex, Grok; then OpenCode and Pi.
   Each is the install section plus the updater switch in its posture section.
6. **Updater.** The schedule, the checks, pause, the rejected list.
7. **Sessions.** In-use records, the engine-wake change, re-attach from the
   record.
8. **Rollback.** Manual "go back"; automatic rollback for an unproven release.
9. **Home-edit records and undo.**
10. **Requests and display.** The daemon requests, the harness list, the
    notices, the CLI verbs, the installer's `--agents` option on the new
    mechanism.
11. **Acceptance run** in the VPS lab (section 4).

Tasks 2 to 4 have no visible effect and can land first. Task 1 gates task 5.

## 8. Related

- POD-6520: the harness access contract. Section 6 names this work.
- POD-6858, `harness-session-posture.md` section 9: the three meeting points.
- POD-6876: harness home edits, whose record this design adds.
- POD-4478: the install section every adapter has today.
- POD-6533, POD-6546: session-pinned contexts and the engine-wake rule that
  3.8 amends.
- `managed-accounts-and-environments.md`: where a Podium-owned home is decided.
