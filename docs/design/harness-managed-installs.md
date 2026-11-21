# Managed installs: Podium installs a harness and keeps it current

Design for POD-6880, the design task of the Managed installs phase (POD-6865)
of POD-6858. Written 2026-11-18. Not yet reviewed, and not agreed until the
operator says so.

It builds on three things that exist:

- the harness access contract (`harness-access-contract.md`, section 6);
- session posture (`harness-session-posture.md`, section 9), landed on
  `dev/mw`;
- credential management (POD-6857,
  `docs/superpowers/specs/2026-11-12-credential-management-design.md`),
  finished on its own branch and not yet landed.

Podium code is cited from `dev/mw` at `06e3f38c7c`, and for credential
management from `issue/6857-inference-credential-management` at `2aeb38768f`.

Evidence tags: **script** = read in the vendor's own installer, fetched
2026-11-13; **disk** = seen on the development machine; **live** = run there;
**doc** = vendor documentation or Podium's harness reference. **Lab** observations
are from the POD-7267 report and hash listings, recorded 2026-11-20 on disposable
Ubuntu 24.04.5 x86-64 boxes.

## 1. The design on one page

A machine can hold two sides for one harness.

| | The person's side | Podium's side |
|---|---|---|
| **Binary** | the install they made | a release Podium downloaded, in Podium's state folder |
| **Home** (settings, conversations, harness state) | the harness's own folder, `~/.claude`, `~/.codex` | one Podium home per harness |
| **Credential** | the login they made there | passed in by Podium at launch |
| **Updated by** | the vendor, as they set it up | Podium, in the background |
| **Removed by** | the person | Podium |

- **The person's side is used exactly as found.** It is the all-in-one local
  case: their install, settings, skills, plugins, MCP servers and login.
  Podium never updates, moves or adopts it.
- **Podium's side is for a machine that holds nothing of the person's**: a
  fresh VPS today, a short-lived cloud machine as the future default. Podium
  brings the binary, the home and the credential.
- **The two never mix.** A binary Podium installed never runs in the person's
  harness folder.
- **Each release sits in its own folder that is never changed.** Installing
  and updating are one act: fill a new folder, check it, point a record at it.
  A running process keeps the folder it started from.
- **Nothing finds a harness by name.** Podium starts every harness by full
  path through the access contract. A managed install is on nobody's command
  path.

## 2. The problem

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
  `inventory/install.ts`). Claude Code, Codex and Grok have one. OpenCode, Pi
  and Cursor decline with a reason.
- **Where it lands.** In the person's own `~/.local/bin`, with whatever else
  the vendor's installer writes.
- **Afterwards.** Nothing. The install is indistinguishable from one the
  person made. Whether it updates depends on the vendor's own updater.

### What a vendor installer writes

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

On the development machine, with no action from Podium (**disk**):

- Claude Code holds six versions, 2.1.301 to 2.1.323, risen in four weeks.
- Codex holds three releases and moved from 0.167.1 to 0.167.2 during the
  posture research.
- Grok moved from 1.0.46 to 1.0.77.

A vendor's updater writes into the person's home and repoints the link that
every new process follows. If Podium owned such an install, two updaters would
be changing it.

Two more facts about what a harness writes into its home:

- Claude Code records how it was installed and whether it updates itself
  (`installMethod`, `autoUpdates`) in its state file when it exits (**live**).
- From 0.169, Codex can copy its package into
  `<home>/packages/app-server-daemon/` and run a daemon with its own updater.
  Section 6.3 records which launches use that copy (**lab**).

### Releases are frequent and large

- Claude Code's `latest` pointer read 2.1.323 and its `stable` pointer 2.1.311
  (**live**, 2026-11-13).
- One Claude Code binary is 362 MB, Grok 201 MB, OpenCode 185 MB (**disk**).

Following Claude Code's `latest` would download several gigabytes a month on
every machine.

### What already exists to build on

- **The access contract.** `HarnessInstallation` (executable, version) is
  built from the inventory and pinned on every session's context. Every
  harness process is started from that pinned value
  (`harnessCommand(context, argv, terms)`), never from a name on the path. Its
  comment leaves room for a `managed | external` field.
- **Posture.** The adapter's posture section receives the session's context
  and decides launch flags, environment and a few edits to the harness home
  (`applyHomeEdits`). It deferred the record of those edits to this phase.
- **Credential management.** A session's context has a second field,
  `harnessHome`: a configuration folder Podium made, which the harness is
  pointed at with its own variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Homes
  live under `<state>/homes/`, are created and removed by the daemon
  (`apps/daemon/src/homes/`), and exist for Claude Code and Codex.

## 3. What "managed" has to mean

| # | Requirement |
|---|---|
| M1 | Podium installs a harness only when a person asked for it. |
| M2 | Everything Podium installs sits inside Podium's own folder. Nothing is written to the person's `~/.local/bin`, shell profile or harness config. |
| M3 | A managed install is marked as Podium's, and only Podium changes it. The vendor's own updater is off for it. |
| M4 | Podium keeps it at the vendor's newest stable release at or above the minimum version, in the background, without asking. |
| M5 | An update never touches a running harness process. |
| M6 | A failed update leaves the machine exactly as it was. A person can go back one release. |
| M7 | An install the person made is still found, used and left alone. |
| M8 | Podium can list what it put on a machine, and take it away again. |
| M9 | A managed binary never reads or writes the person's own harness folder. It runs only in a home Podium owns. |

## 4. Installs, homes and credentials

### 4.1 Why the managed binary stays out of the person's folder

- A harness upgrades its own state files. A newer managed binary running in
  the person's folder could leave files their older CLI cannot read.
- The harness records install and update state in its home, and Codex copies
  itself there (section 2). In the person's folder those would change how
  their own install updates.
- Podium's side can then be removed by deleting two folders, and nothing of
  the person's has changed.

The other direction is allowed and already built: the person's binary may run
in a home Podium made, for a second account on their own CLI.

### 4.2 Which side a session runs on

A machine uses Podium's side for a harness when a managed install of it
exists. Otherwise it uses the person's side, as today. The person's own login
always runs on the person's side.

| On the machine | A session on the person's own login | A session on a credential Podium holds |
|---|---|---|
| Only the person's install | their binary, their folder | their binary; a passed-in credential runs in their folder, a second sign-in in its own linked folder. As built by credential management. |
| No install | cannot start; the harness shows **Install** | cannot start; the harness shows **Install** |
| Only a managed install | there is no such login | managed binary, the Podium home |
| Both | their binary, their folder | managed binary, the Podium home |

So the binary follows the home: the person's folder gets the person's binary,
and a Podium home gets the managed binary when there is one.

### 4.3 One Podium home per harness; the credential is passed in

A folder per credential is needed only where the login is a file the harness
renews in its folder. Most credentials are not that:

| Credential | How it reaches the harness | Needs its own folder |
|---|---|---|
| API key | environment variable | no |
| Claude long-lived token (`claude setup-token`) | environment variable | no |
| ChatGPT plan signed in to Podium (Codex server driver) | a one-hour token, environment variable | no |
| A subscription signed in with the vendor's own sign-in | the login file in the harness's folder, renewed there | yes: one folder per login |

So Podium's side has one home per harness,
`<state>/homes/podium/<harness>/`, and every passed-in credential runs in it.
Conversations and settings stay in one place, and changing a session's
credential copies nothing. The Podium home is prepared for a launch the way
credential management prepares its homes (`prepareHomeLaunch`: onboarding
done, the session's folder trusted), so the first turn is never a setup
screen. Passing in is also the only form that works on a
short-lived machine: nobody signs in on a machine that lives for an hour.

A vendor sign-in on Podium's side still gets its own folder, as credential
management built it, because the login cannot live anywhere else. That folder
links its settings from the Podium home of the same harness, so Podium's side
has one set of settings.

### 4.4 The person's login is not carried over

Podium does not move or copy the person's login into its own home. Credential
management measured why (its S7): a subscription login holds a renewal token
that is replaced at each use. Signing a second folder in from the first
folder's token signs the first one out at its next request.

What the person does instead, once:

| They have | For Podium's side they | Effect on their own CLI |
|---|---|---|
| a Claude subscription | create a long-lived token once; Podium stores it and passes it in on any machine | none |
| a ChatGPT plan | sign in to Podium once; Podium passes a short token in | none |
| either, and want the vendor's full sign-in | sign in through Podium on that machine, in a Podium terminal | none; two separate sign-ins that do not collide |
| an API key | paste it into Podium once | none |
| only their own login, and their own install is new enough | nothing. Sessions run on their side. | shared, as today |

Amp handles a Claude plan the same way: the person links the subscription to
Amp once, Amp runs Claude Code in its own environment, and the person's
`~/.claude` settings are not loaded (Amp documentation, read 2026-11-18).

### 4.5 What fills the Podium home

There is one Podium home per harness and it has one source, so nothing has to
be kept in step between homes.

- **On a machine that also has the person's folder**, the Podium home is
  filled from it once, when the managed install is made, and again on request
  ("Take my settings"): instructions, skills, agents, commands, plugins and MCP
  servers are copied. Permissions, folder trust, hooks and update settings are
  not copied. Posture supplies them.
- **On a machine with nothing of the person's**, the same content has to come
  from Podium: the person's harness setup, held by the server and placed in
  the Podium home when the machine is prepared. That is its own piece of work
  and not part of this phase. This design gives it the place to land. Until it
  exists, such a machine starts with the repository's own instruction files
  and whatever the machine image holds.

### 4.6 Changes to credential management as built

Only on Podium's side. The person's side, with its linked second-account
homes, stays as built.

1. A passed-in credential runs in the Podium home instead of the person's
   folder (one rule in `control/access.ts`, where a session's home is read).
2. A sign-in folder links from the Podium home (`homes/share.ts` takes the
   folder to link from; today it is always the person's).
3. When a managed install is made on a machine that already has sign-in
   folders, their links are pointed at the Podium home. They are plain links,
   so this replaces them and nothing else.
4. A session that already ran in the person's folder on a passed-in
   credential moves to the Podium home when a managed install appears. Its
   next process continues the conversation through credential management's
   existing copy into the target home (the same path as switching a session's
   credential).

### 4.7 Harnesses with no folder variable

Podium homes exist for Claude Code, Codex, Grok and Pi. OpenCode's XDG
directory variables work together, and
Cursor's dedicated variables leave some writes in the person's home. Section 9
records the measured paths.

Grok's home is `GROK_HOME`, which moves `auth.json`, `config.toml`, logs,
hooks and sessions together. Its login reaches a home only as a sign-in folder
(the `xai.grok-login` credential type: signed in through Podium, or found on
the machine). Grok has no passed-in line yet, because starting it in a home
with `XAI_API_KEY` was not measured. A sign-in folder links `config.toml`,
`AGENTS.md`, `skills`, `agents` and `plugins` from its source. Grok 1.0.89
writes through a linked `config.toml` and keeps the link. The fill copies the
same entries, and of `config.toml` only the `[mcp_servers.*]` tables. A
daemon offers Grok homes with its own capability (`harness.homes.grok.v1`), so
an older daemon is never asked for one. Three limits remain:

- Grok also reads Claude Code's user folder from `HOME` (`~/.claude/skills`,
  `agents`, `plugins` and the servers in `~/.claude.json`), and no switch is
  documented. A Grok in a Podium home still reads them. It does not write
  there.
- A credential switch does not move a Grok conversation into another home:
  Grok declares no conversation file, so the switch continues in a new
  session with a handoff.
- A real login refresh inside a Podium-made Grok home was not measured.

Pi's home is `PI_CODING_AGENT_DIR`, which moves `auth.json`, `settings.json`,
the model store and the sessions together (POD-7267). Pi has only its Podium
home and no sign-in folders. Its login is several providers' keys and tokens
in one `auth.json`, signed in only through `/login` inside the TUI, and its
login identity is a hash of those tokens, so it would change at every refresh.
The provider keys Pi accepts (Anthropic, OpenAI, OpenRouter) are passed in
and run in the Podium home. The person's own login keeps running their own
binary in `~/.pi/agent`. The fill copies `AGENTS.md`, `SYSTEM.md`,
`APPEND_SYSTEM.md`, `skills`, `prompts`, `extensions`, `themes`, and of
`mcp.json` only `mcpServers`. It never copies `auth.json`, `trust.json`
(folder trust), `mcp-auth.json` (MCP sign-ins), `models-store.json`,
`sessions`, `settings.json` (it holds the folder-trust default, update and
telemetry settings and a device id) or `models.json` (a custom provider there
can hold an API key). Posture supplies trust at launch (`--approve`). A
daemon offers Pi homes with `harness.homes.pi.v1`. A Pi conversation is one
file, so a session that ran in the person's folder on a passed-in key is
copied into the Podium home before its next process (4.6 item 4); Pi's
`--session-id` would otherwise start an empty conversation there. The
adapter declares this as its conversation file, apart from cross-machine
handoff, which Pi still does not support. Two limits remain:

- Pi also reads `~/.agents/skills` from `HOME`, and no switch is documented.
  A Pi in a Podium home still reads it. It does not write there.
- A Pi login made in the Podium home's TUI (`/login`) stays in that home's
  `auth.json` and is not a credential Podium knows about. Pi prefers a stored
  entry to a provider key from the environment, so later sessions there on a
  passed-in key for the same provider run on that login.

Until an adapter uses the measured overrides for its harness, Podium can
manage it only on a machine where the person has no install of their own.
The install action and machine setup both enforce this rule.

A managed install that runs with the default home shares that home if the
person installs their own copy later. The harness row shows both installs
sharing one folder and offers to remove Podium's copy.

## 5. Installing and updating

### 5.1 Where each part runs

| Part | Runs in | Crosses the network |
|---|---|---|
| Deciding to install, pause, go back or remove | a person, in a client or the CLI | one request to the machine's daemon |
| Asking the vendor for the newest release | daemon, on the harness's machine | one small request to the vendor |
| Downloading, checking, publishing | daemon | the download from the vendor |
| The record of what Podium owns | folders and a small database on that machine (section 7) | never |
| Choosing the executable for a session | daemon | never |
| Reporting state | daemon to server to clients | inside the inventory report that already exists |

The server stores what a machine reports and passes requests on. It makes no
version decision. Each machine updates itself, so two machines can be on
different releases for a few hours, as they can today.

### 5.2 Where the binaries live

```
<Podium state folder>/
  homes/
    podium/<harness>/        the Podium home (4.3)
    <credential>/<harness>/  a sign-in folder, as credential management built it
  harnesses/
    ledger.db                which release is current, and what else Podium owns (section 7)
    claude-code/
      7-2.1.311/             one release, complete; never changed after publishing
        receipt.json         harness, version, executable, source, checksum, when
        …                    laid out as the adapter chose
      8-2.1.318/
      .staging-4f2a/         an install in progress; never selected
    codex/
      3-0.167.2/
```

- **The state folder** is the instance's own (`stateDir()`: `~/.podium`, or the
  named instance's folder). A named or test instance has its own installs and
  cannot change another instance's.
- **One folder per install**, named `<number>-<version>`. The number counts up
  per harness. Installing the same version again (a repair) makes a new folder.
  A published folder is only ever read or deleted.
- **The folder is the record of the release**, as a home's folder is the
  record of the home (`homes/registry.ts`). A folder with a receipt is a
  release, and nothing else lists them.
- **No link named `current`.** The current folder is a field in the ledger, and
  sessions are handed the full path. This works the same on Windows, where
  making a link needs extra rights, and a process never follows a link that
  moved under it.
- **Not on anyone's command path.** Typing `claude` in a shell does not find a
  managed install, and neither does an agent that types it. One agent starts
  another harness through Podium (`podium agent spawn`).

### 5.3 What an adapter says

The install procedure lives in the adapter and is called through the shared
contract. Today's section says "run this script into this bin folder". It
becomes:

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
    | { kind: 'sha256'; digest: string; publishedAt?: string }
    | { kind: 'none'; reason: string }
}
```

`HarnessInstallPorts` keeps what it has (`fetch`, `run` by full path, `runTool`,
`arch`, `isMusl`, `note`) and gains:

- `platform`, so one section covers Linux, macOS and Windows or declines one.
- `home`: an empty folder inside `dir`. An adapter that runs the vendor's
  installer runs it with `HOME` (and the harness's own folder variable) set to
  this folder, so the profile edits and config writes of section 2 land inside
  the release folder and nowhere else.
- `env`: the machine's command environment with every credential variable
  removed. Never the daemon's own environment.

The ports are asynchronous. Today's are synchronous, which is fine in the CLI
and would freeze a daemon for the length of a 360 MB download.

The section stays `supported` or `unsupported` with a reason. A harness can be
managed only when all three hold:

1. A release can be placed completely inside a folder Podium picks.
2. Its own updater changes nothing outside Podium's folders: it can be
   switched off for each launch, or it writes only into the home (6.3).
3. `--version` prints the release's version.

Where a vendor publishes a file with a checksum, the adapter downloads it
directly. An installer script also edits profiles, asks questions, links things
and prunes old releases, and none of that is wanted here. The Claude Code
adapter already has this path (`installClaudeStandalone`), written as a
fallback.

### 5.4 Installing one release

The mechanism is the same for every harness and names none
(`inventory/install.ts`, extended). Steps, in order:

1. Take the install lock (section 7).
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

There is no per-release verification by Podium. Step 4 checks that the
download is intact and starts. It does not check that the release behaves.

A crash at any step leaves either a staging folder or a numbered folder the
ledger does not name. Both are deleted by housekeeping (5.5). Until step 6
completes, nothing reads the new folder.

### 5.5 When updates run

A check is one call to the adapter's `latest()`. It runs:

- shortly after the daemon starts, off the connection path, so a slow vendor
  host cannot delay a reconnect;
- every six hours while the daemon runs, with up to thirty minutes of random
  delay, so a fleet does not arrive at a vendor host together;
- when a person asks ("Check now").

A check leads to an install when the version it returns is newer than the
current one, is at or above the minimum, is not on the rejected list (5.6), and
updates are not paused for that harness. Otherwise nothing happens.

**Updates do not wait for the machine to be idle.** An install fills a new
folder and moves a record. No running process reads either.

**"Latest" means the vendor's stable channel, for now.** Claude Code and Grok
publish a stable pointer next to faster channels (**live**, **script**); for
Codex it is the newest release that is not a pre-release. For Claude Code that
is roughly a weekly download instead of a daily one.

**Housekeeping** runs with every check and at daemon start. It deletes every
`.staging-*` folder, and every numbered folder that is not `current`, not
`previous`, and has no running session (6.2). So a harness normally occupies
two releases on disk.

### 5.6 Failure and going back

| What goes wrong | What happens |
|---|---|
| The vendor cannot be reached for a check | Nothing changes. The error and time are recorded. The next check tries again. |
| The download breaks, the checksum is wrong, the installer fails, the disk is full | The staging folder is deleted. The current release stays. The error is recorded and reported; the next check tries the same version again. |
| The new binary does not run, prints another version, or is below the minimum | The staging folder is deleted and the version goes on the rejected list, so 360 MB are not fetched again every six hours. A later release is tried. |
| The current release's files are damaged or deleted | Its probe fails and Podium's side falls back to the previous release. The next check installs the current version again, as a new folder. |
| The daemon dies mid-install | Nothing was published. The leftovers are swept. |
| A person pauses updates | The harness stays on its release until they resume. Shown wherever the version is shown. |

**There is no automatic rollback.** If a vendor ships a release that runs but
misbehaves, that is the vendor's release, and Podium does not judge it. A
session that will not start on it shows the CLI's own message in the
start-failure banner, as with any install.

**A person can go back.** The previous release is on disk anyway. "Go back to
`<previous>`" moves the record to it and puts the newer version on the
rejected list, so the next check does not bring it straight back. A release
newer than the rejected one is installed as usual.

## 6. Sessions

### 6.1 Which binary a session gets

The inventory keeps up to two installs per harness instead of one:

1. the managed `current` from the ledger, or the managed `previous` if the
   current one fails the probe;
2. the names on the machine command path, then the adapter's known folders, as
   today.

Each passes the existing version and identity probe on its own.
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

The choice between the two (4.2) is made where the session's context is
built, the one place that knows the session's home (`inSessionHome` in
`session-harness-context.ts`). Everything after that is the access contract,
unchanged.

Everything else that runs a harness for a home asks the same way: the sign-in
terminal, the per-home login, model and quota reads, the sign-out command, and
the Codex daemon stop before a home is removed (`homes/probes.ts`,
`homes/stop.ts`). They ask for the install of that home instead of "the"
executable of the harness.

- **Too old.** When the person's own install is below the minimum, Podium
  refuses to start it, as today. The refusal gains one action: "Install a
  current version for Podium". It is never done silently. The person then adds
  a credential for Podium's side (4.4). Their earlier conversations stay
  readable and can be continued, because Podium already reads every home and
  copies a conversation into the home that continues it.
- **No takeover.** Podium does not adopt an install the person made and does
  not move or update it.

### 6.2 Running sessions

**A process keeps the release it started from.** Its folder is not written to
and is not deleted while the process lives.

**The next process takes the current release.** When Podium starts a new
process for a session that already exists (a restart, a resume, an engine
waking, the next turn of a one-process-per-turn harness), that process is built
from the inventory as it stands then.

- For a spawn this is today's behaviour: every spawn builds a fresh context
  (`buildSessionHarnessContext`).
- For an engine waking it is a change. Today a waking engine reuses the context
  the session was first spawned with, for as long as the daemon lives
  (`engineSessionHarnessContext`, POD-6546). With that rule a session parked for
  a month would pin a release for a month, and fifty parked sessions could pin
  fifty releases of 360 MB each. So: when the session's pinned installation is
  managed and no longer the current one, a wake builds a new context. The
  rebuild takes the session id, so the session stays in its home.
- Within one launch, hook installation, posture and the process still all read
  one context (POD-6533).

**Knowing which releases are in use.** The daemon forgets its sessions'
contexts when it restarts, while the harness processes live on in their hosts.
So "in use" cannot be kept in daemon memory. It is a table in the ledger, one
row per session:

- when a process starts, the daemon records the session's installation;
- when the session ends, the row goes;
- at daemon start, rows for sessions that did not survive are dropped.

It is a table because "which releases have a session" is one query, and
deleting an unused release can then never interleave with a session starting
on it. Posture and credential access keep their per-session facts as one small
file each; they are read by session id only, and stay as they are.

Two things use the rows. Housekeeping never deletes a release a row names. And
when the daemon re-attaches to a surviving session after a restart, it rebuilds
that session's context from the recorded installation instead of from whatever
is current, so the context names the binary that is really running. Today a
rebuilt context names the current install even when the process is older.

### 6.3 The vendor's own updater

For a managed installation, posture supplies the update control for the launch
mode. The six published Linux releases started from paths outside the vendor
install trees. Codex, Pi and Cursor ran with the other files in their published
packages alongside the entry point. The observed writes below come from the
bounded lab runs in POD-7267.

| Harness | Update control | Measured behavior |
|---|---|---|
| Claude Code 2.1.311 | `DISABLE_AUTOUPDATER=1` | A turn with `CLAUDE_CONFIG_DIR` set wrote settings, backups and conversation state in that folder and used temporary files. The vendor-installed binary, the test user's Claude home, caches and shell profiles were byte-identical. |
| Codex 0.169.0 and 0.171.0 | `-c check_for_update_on_startup=false` for startup UI. `updater.autoUpdateEnabled: false` in `$CODEX_HOME/app-server-daemon/settings.json` for the copied daemon. | The startup flag leaves the daemon updater active. Direct stdio ran the published executable. The copied daemon updated itself and restarted. The daemon setting kept the copy and suppressed the loop. An arbitrary-path release refused `codex update` even with a valid `packages/standalone/auto-update-version` in the selected home. |
| Grok 1.0.89 | `GROK_DISABLE_AUTOUPDATER=1`, or `[cli] auto_update = false` in `config.toml` | The switched launch wrote config, logs and the session index under `GROK_HOME`. The older 1.0.77 runs with the environment switch, the config switch and defaults left the release bytes unchanged during the observation. The default control did not produce a replacement release. |
| OpenCode 1.19.6 | `OPENCODE_DISABLE_AUTOUPDATE=1` | The loopback turn wrote its database, cache, logs, config and state under the supplied XDG roots. It also created `~/.opencode/.gitignore` and temporary files. Both executables stayed byte-identical. |
| Pi 1.6.0 | `PI_SKIP_VERSION_CHECK=1` | The flag skips the version request. A loopback turn wrote the model store and transcript under `PI_CODING_AGENT_DIR`. The release and vendor install stayed byte-identical. Pi's explicit updater is `pi update`. |
| Cursor 2026.11.19-f005e9d | `--disable-auto-update` on agent launch, or `"channel":"static"` in `cli-config.json` | The released CLI accepts the hidden flag and its updater guard recognizes both controls. Normal startup still writes the compile cache and `~/.cursor/agent-cli-state.json`. An explicit update of the July build installed the November release under `~/.local/share/cursor-agent/versions/`, repointed the `agent` and `cursor-agent` links and wrote a `cursor` shim under `~/.local/bin`. |

For the person's own install, posture takes care of update menus while the
person retains their update policy.

**Codex's copy in the home.** On both versions, `codex app-server` over stdio
served a complete turn from the invoking release and created no daemon
package. On 0.171.0, explicit `codex app-server --stdio` gave the same result.
The terminal flag `codex --no-daemon` selected the embedded server. Explicit
`codex app-server daemon bootstrap` instead copied the package into
`$CODEX_HOME/packages/app-server-daemon/`. The socket peer's
`/proc/<pid>/exe` pointed into the copied release. With default updater
settings, the 0.169.0 daemon selected 0.171.0 and restarted at the five-minute
scheduled check. A launch-scoped update notice flag does not affect that loop.
A shared daemon also keeps the environment it was started with, which matters
when Podium passes credentials at launch. [Codex daemon lifecycle for 0.171.0](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server-daemon/README.md)

**One cost per Codex update.** In a home Podium made, Codex gets Podium's hooks
as launch flags with a trust hash, read once per Codex version from a throwaway
`codex app-server` and cached (`homes/codex-hook-trust.ts`). The first launch
after a Podium update pays for that read.

### 6.4 Posture's edits to a home

On Podium's side they land in files the home owns: Claude Code's state file
there is the home's own, and the Codex rule file is written inside the home.
They go when the home is deleted and need no record. On the person's side they
land in the person's files. Those are recorded (section 7).

## 7. The record of what Podium owns

Posture deferred this: "the ownership record belongs to the managed-installs
phase, where its second user appears." It answers one question: what on this
machine exists because Podium put it there?

| What | Its record |
|---|---|
| Podium homes and sign-in folders | the folders under `<state>/homes/` |
| Managed releases | the folders under `<state>/harnesses/`, each with a receipt |
| Which release is current, what was rejected, which session runs on which install, and Podium's edits to the person's own harness folder | **the ledger** |

**The ledger is a small SQLite database on the machine**,
`<state folder>/harnesses/ledger.db`, opened through `@podium/runtime/sqlite`.
The daemon side already keeps one local database this way (`discovery.db`).

- **Why a database.** Two programs write it: the daemon, and the CLI at
  machine setup, which can run before a daemon exists. A database gives
  one-writer-at-a-time and all-or-nothing writes without a lock file that a
  crash can leave behind. `installation-lease.ts` uses SQLite for the same
  reason.
- **Why on the machine and not in the server's database.** The daemon chooses
  the executable when a session starts, and it must be able to do that while
  the server is unreachable, and at machine setup before the machine is paired.
  The server still gets the state in the inventory report.

The rows, as types:

```ts
/** One row per managed harness. */
interface ManagedInstall {
  kind: BuiltinHarnessKind
  nextNumber: number
  current: number | null      // a release folder's number
  previous: number | null
  /** A person paused updates. */
  paused: boolean
  requested: { by: 'machine-setup' | 'person'; at: string }
  lastCheck:
    | { at: string; ok: true; latest: string }
    | { at: string; ok: false; error: string }
  lastInstallError?: { at: string; version: string; error: string }
  /** First failure of the current run of failed checks or installs; cleared on success. */
  failingSince?: string
}

/** Versions Podium will not install again, and why. */
interface RejectedRelease {
  kind: BuiltinHarnessKind
  version: string
  reason: string
  at: string
}

/** One row per session with a running harness process. */
interface SessionInstall {
  sessionId: SessionId
  kind: BuiltinHarnessKind
  executable: string
  version: string
  provenance: 'managed' | 'external'
  /** The release folder's number, when managed. */
  release: number | null
}

/** One row per edit Podium made in the person's own harness folder. */
interface HomeEditRecord {
  harness: BuiltinHarnessKind
  /** The real path written, after following links. */
  file: string
  edit:
    | { kind: 'json-key'; path: string[]; value: JsonValue }
    | { kind: 'toml-array-entry'; path: string[]; value: string }
    | { kind: 'owned-file'; sha256: string }
  /** What was there before Podium's first write. */
  prior: { absent: true } | { value: JsonValue } | { contents: string }
  serves: PostureRequirement
  appliedAt: string
}
```

Rules:

- **Publishing a release is one transaction**: `current` and `previous` move
  together.
- **The install lock** is held in the same database for the length of one
  install, so the daemon and the CLI cannot install at once, and a crashed
  installer leaves no lock behind.
- **The daemon reads it on every inventory wave**, then reads the current
  folder's receipt for the executable. That is how an install made by the CLI
  becomes visible without a restart.
- **Every folder under `harnesses/<kind>/`** is `current`, `previous`, named by
  a session's row, or deleted by housekeeping.
- **Home edits** are recorded only for a session in the person's own folder,
  and only when Podium's write changed the file (the `applied` outcome of
  `applyHomeEdits`), with the value that was there before. Today that is three
  edits: Claude Code's folder-trust key, the Codex rule file, and Grok's allow
  entry. When the folder already held the value and there is no record, the
  person put it there, and it is not Podium's.
- **Undoing a home edit** restores the prior value, and only while the file
  still holds the value Podium wrote. A value the person changed since is left.
- **When undo runs.** On request ("Remove Podium's changes" for a harness), and
  when Podium is removed from the machine. Not when a repository is removed
  from Podium: the person may rely on that trust in their own sessions by then.
- **A lost or damaged database** is set aside and rebuilt from the release
  folders: the highest-numbered folder with a receipt becomes current.
  Home-edit records are lost in that case; the edits are re-derived at the next
  launch, and from then on count as not Podium's. The machine reports that the
  ledger was rebuilt.

## 8. What a person sees

The inventory report gains, per harness, one optional `install` object beside
the optional `logins` list credential management added: for each of the two
installs its version, and for the managed one its previous version, the
vendor's newest version as last seen, the time of the last check, whether
updates are paused, the last error, since when it has been failing, and
whether the ledger was rebuilt. The daemon reports; the server raises the
notices. An older server or daemon ignores it.

Requests to the daemon follow the pattern homes set (`messages/homes.ts`,
`control/homes.ts`): a capability the daemon offers (`harness.installs.v1`), so
an older daemon is not asked, and one request and result pair per action. The
daemon code sits in `apps/daemon/src/installs/`, beside `homes/`.

On a machine's harness list:

| State | Shown | Actions |
|---|---|---|
| Not installed | "Not installed" | Install |
| The person's own | "2.1.300 · your install" | Install for Podium |
| The person's own, too old | "2.1.100 · your install · too old for Podium" | Install a current version |
| Managed | "2.1.311 · managed by Podium · checked 2 h ago" | Check now, Go back to 2.1.305, Pause updates, Take my settings, Remove |
| Both | both lines | the actions of each |
| Both, sharing one folder (no folder variable, 4.7) | both lines and "sharing one folder" | Remove Podium's copy |
| Managed, installing | "Installing 2.1.318…" | none |

Podium says nothing when an update succeeds. It raises one notice per harness
and machine when updates have failed for three days, or when the ledger was
rebuilt.

The CLI gets the same verbs for a machine: list, install, check, go back,
pause, resume, remove, and "show what Podium changed here".

**Remove** deletes the harness's releases once no session uses them and
deletes its ledger rows. It leaves the Podium home and any sign-in folder in
place; those go through credential management, or with a second confirmation
that names the conversations stored there.

## 9. What each harness needs

These are the stable release and archive observations on 2026-11-20. The
POD-7267 report has the exact fetch commands, hashes and launch results.

| Harness | Stable pointer | File and integrity | Home and managed install implications |
|---|---|---|---|
| **Claude Code** | `downloads.claude.ai/claude-code-releases/stable` → 2.1.311 | `<version>/<platform>/claude` and `manifest.json` SHA-256. Windows entries are `win32-x64/claude.exe` and `win32-arm64/claude.exe`. | Direct download. `CLAUDE_CONFIG_DIR` contains state and sessions. Managed posture sets `disableDeepLinkRegistration: "disable"` in the Podium home's settings so the copy does not register an OS URL handler. A terminal start still creates `~/.claude/ssh` and `~/.config/anthropic`; see below. On Linux a passed-in key or token goes in on an inherited pipe (POD-7378): Claude reads `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` or `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, the secret is in no environment, argument or file, and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is not set, so Linux needs no `bwrap` and no empty mount points are created. Claude reads the descriptor through `/proc/self/fd`, so macOS and Windows keep the variable and the scrub switch, which needs no `bwrap` there. See below. |
| **Codex** | `releases.openai.com/codex/channels/latest` → 0.171.0, with [GitHub Releases](https://github.com/openai/codex/releases/latest) as installer fallback | `codex-package-<target>.tar.gz` or `.tar.zst`, with `bin/codex` plus helpers and resources. SHA-256 in `codex-package_SHA256SUMS`. | Keep the complete release package. `CODEX_HOME` contains session state and any daemon copy. See 6.3 for the version pin. |
| **Grok** | `x.ai/cli/stable` → 1.0.89 | `grok-<version>-<platform>`, direct binary. The installer checks the binary runs. No published checksum was found in the installer or at the asset's `.sha256` URL. | `GROK_HOME` directs `auth.json`, config, logs and session storage into the same folder. A live login refresh was outside the lab's available credentials. Grok's Podium home and sign-in folders use it (4.7). |
| **OpenCode** | [GitHub releases/latest](https://api.github.com/repos/anomalyco/opencode/releases/latest) → v1.19.6 | `opencode-linux-x64.tar.gz` opens to a top-level `opencode`. The GitHub API asset `digest` matches the archive SHA-256. | One override for all state was not found. `OPENCODE_CONFIG_DIR` is config only. Together the XDG config, data, state and cache variables redirected the session database and file-backed key. The personal `~/.opencode/.gitignore` write remained. The `--version` probe alone creates empty default XDG config, data, state and cache folders (POD-7277). |
| **Pi** | `pi.dev/api/installer/releases/latest` → 1.6.0, also present in [GitHub Releases](https://github.com/earendil-works/pi/releases/tag/v1.6.0) | `pi-linux-x64.tar.gz` contains `pi/pi` and its assets. GitHub publishes `SHA256SUMS` and per-asset digests. The installer API separately publishes npm package integrity. | Direct download of the complete standalone bundle. `PI_CODING_AGENT_DIR` moves `auth.json`, settings, model state and sessions. The managed install's version and identity probes create empty `auth.json` and `models-store.json` under the default `~/.pi/agent` when absent (POD-7278); they run in a throwaway home. Pi's Podium home uses the variable (4.7). |
| **Cursor** | `DashboardService/GetCliDownloadUrl` at `api2.cursor.sh`, with `channel=prod`, returned 2026.11.19-f005e9d and its download prefix. | `linux/x64/agent-cli-package.tar.gz` strips one `dist-package/` directory. Keep the launcher, Node and its assets together. The adjacent `agent-cli-package.tar.gz.sha256` matched the archive. | No single variable found. `CURSOR_CONFIG_DIR` moved config, `CURSOR_DATA_DIR` directed project storage, and Linux file auth uses XDG config. Agent CLI state still used `~/.cursor` with both dedicated variables. See 4.7. |

The POD-7274 terminal check of Claude Code 2.1.311 found writes the bounded
turn in 6.3 did not: the two empty directories in the Claude Code row, and
an OS URL-handler registration unless the
[documented registration setting](https://code.claude.com/docs/en/settings-reference#disabledeeplinkregistration)
is disabled. The direct install left the person's home byte-identical, and
the terminal turn left existing files, profiles and both binaries unchanged;
the whole home was not byte-identical. The POD-7274 evidence contains the
complete before/after hash lists, including new entries.

On a passed-in credential, Podium's earlier
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` did more on Linux than scrub the
environment (POD-7375, measured on 2.1.311 and 2.1.329). This is why Linux now
uses the pipe described after the list:

- **It needs bubblewrap.** Claude looks for `sandbox.bwrapPath` in managed
  settings, then `bwrap` on PATH, and exits with status 1 before the composer
  when neither is found. That check runs before any file is written. Podium
  does not install OS packages: the Claude adapter declares `bwrap` as a Linux
  prerequisite of its hide-from-commands switch. Since the pipe, no Linux start
  sets the switch, so the prerequisite is never checked or reported there.
- **It creates mount points on every start.** Each missing bind target is
  created empty (opened for append, or `mkdir -p`); existing files keep their
  bytes. In HOME: `.gitconfig`, `.bash_profile`, `.bashrc`, `.bash_aliases`,
  `.profile`, `.zshrc`, `.bunfig.toml`, `.netrc`, `.npmrc`, `.yarnrc`,
  `.yarnrc.yml`, the folders `.config/gh`, `.config/glab-cli`, `.config/git`,
  `.config/pip`, `.pip`, and every PATH folder under the home or `/tmp`,
  `/opt` and similar (so `.bun/bin` and `.opencode/bin`). In the working
  directory, which is the person's repository: `.npmrc`, `.yarnrc`,
  `.yarnrc.yml`, `bunfig.toml`, `package.json`, `.gitmodules`, the npm, yarn
  and pnpm lockfiles, eight `.env*` files, `.claude/commands`,
  `.claude/agents`, `node_modules/.bin`, and under `.git` the `modules`,
  `worktrees`, `glab-cli`, `config.worktree` and `commondir` entries. It also
  appends a `# claude-code scrub-mode stubs` block to `.git/info/exclude` on
  every start, so that file grows without limit.
- **No setting avoids the files while scrubbing stays on.** The only skip is
  an internal launch option a CLI start cannot reach. Turning the switch off
  avoids all of it, but then every command Claude runs inherits the key.
- **Decision (operator, 2026-11-20), done (POD-7378):** pass the key over a
  pipe instead of setting the switch.

**The pipe (POD-7378, proven on 2.1.323 and 2.1.330).** Claude reads
`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` or
`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, reads that descriptor to the end of
the stream once at start, and keeps the variable and the descriptor out of the
commands it runs. Both variables are undocumented.

- **How it is delivered.** The daemon writes the secret to podium-host's stdin
  and closes it. The host (`create --pipe-env <VARIABLE>`, feature level 3)
  reads stdin to its end before it forks, puts the bytes on a new pipe whose
  writer is closed before Claude starts, and sets the variable to the pipe's
  descriptor in Claude's environment only. The descriptor is 10 or above, out
  of the range a shell script names, because the turn wrapper uses 4 and 5.
- **Every launch path.** The terminal PTY, the stream engine, each one-shot
  headless turn and each `--resume` respawn get a pipe of their own. A process
  the daemon adopts after a restart needs none: Claude read its copy at start.
  The `auth status` probe gets its own descriptor too, on its stdin.
- **Fail closed.** An empty or blank secret is refused before any process
  starts, by the daemon and again by the host. With an empty token Claude would
  fall back to a login stored in its home.
- **What else changes.** The line's own variable (`ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN`) is stripped from the child, so no inherited copy
  competes with the pipe. `CLAUDE_CODE_REMOTE` is stripped from every Claude
  child: with it set, Claude writes a key it read from a descriptor to a file
  for its commands.
- **Linux only.** Claude reads a pipe through `/proc/self/fd`. On macOS and
  Windows the secret stays in the variable with the scrub switch, which needs
  no `bwrap` there. A socket would work on macOS (Claude reads a socket
  directly), which is left for later.

With an empty Podium home, Claude Code accepted the API-key header and the
`CLAUDE_CODE_OAUTH_TOKEN` bearer header on completed loopback turns. Its
terminal showed the theme picker and workspace trust. An environment API key
also triggered a separate approval prompt after the setup and trust fields
were seeded. The terminal started at the prompt after the key approval was
also seeded in `customApiKeyResponses.approved`. Codex 0.171.0 with the bare
`OPENAI_API_KEY` showed its sign-in
menu. A custom model provider with `env_key="OPENAI_API_KEY"` completed the
loopback turn with a bearer header. Provider acceptance of live credentials
and isolation against vendor subscription logins remain open because the lab
had no disposable vendor sign-ins or valid keys.

## 10. How robust it is

- **Nothing shared is written during an update.** A release folder is written
  once, before anything reads it. The only thing that changes afterwards is one
  row in the ledger, in one transaction.
- **Every step can stop.** Section 5.6 has an outcome for each failure, and in
  each the previous release is still there and still selected.
- **A vendor outage costs nothing.** No check, no change.
- **The person's side cannot be damaged by Podium's side**, because the
  managed binary never runs there (M9).
- **Two checks back the design**, as in posture:
  1. *Conformance, every build.* For every adapter with an install section,
     against a fake vendor host: `latest` and `install` write only inside the
     folder they were given (a decoy home and decoy profile files stay
     untouched), and the mechanism's steps hold under injected failure at each
     step. For every harness and launch mode, a managed installation's posture
     includes the updater switch. No context pairs a managed installation with
     the person's folder.
  2. *One acceptance run.* In the VPS lab, once on a machine with no harness
     and once on a machine with the vendor's own install and a signed-in home:
     install each managed harness, start a session, publish a newer release
     from a stand-in vendor host, see new sessions move while a running one
     stays, go back to the previous release, remove everything, and find the
     person's folder, install and profile files exactly as they were.

## 11. What changes for existing code

| Today | After |
|---|---|
| `HarnessInstall { binary, url, runInstaller }`, synchronous | `latest` and `install` into a given folder, asynchronous (5.3) |
| `runInstallTarget(target, binDir)` writes into `~/.local/bin` | the mechanism of 5.4, into `<state>/harnesses/` |
| The installer's `--agents` option installs once and forgets | installs a managed release and records it |
| The inventory keeps one executable per harness, from the command path | up to two: the managed one from the ledger and the person's own (6.1) |
| `HarnessInstallation` has no provenance | `provenance: 'managed' \| 'external'` |
| A session's binary is "the" executable of its harness | it follows the session's home (4.2) |
| A passed-in credential runs in the person's harness folder | on Podium's side it runs in the Podium home (4.3) |
| A sign-in folder links the person's settings | on Podium's side it links the Podium home's (4.6) |
| Posture only quiets update menus | it also turns the vendor's updater off for a managed install (6.3) |
| A waking engine reuses the first context while the daemon lives | it takes the current release when its own is managed and no longer current (6.2) |
| A re-attached session's context names the current install | it names the install recorded for the session (6.2) |
| `applyHomeEdits` keeps no record | `applied` outcomes in the person's own folder are recorded with the prior value (section 7) |
| No record of what Podium put on a machine | `harnesses/ledger.db` (section 7) |
| Daemon requests for homes behind `harness.homes.v1` | the same pattern for installs behind `harness.installs.v1` (section 8) |
| The inventory report has installed, version, path, logins | plus the `install` object (section 8) |

Unchanged: `harnessCommand`, `harnessChildEnv`, the spawn sites, how the
person's install is found, the minimum-version policy, posture for the
person's install, and the rest of credential management: the home registry,
`harnessHome`, sign-in, the per-home reads, the conversation copy and home
removal.

## 12. Decisions

### Made by the operator

1. The install procedure lives in the harness adapter and is called through
   the shared contract.
2. An install Podium made is marked managed, and Podium is responsible for
   updating it.
3. A harness has a minimum version only. A managed install takes the vendor's
   latest release at or above it, with no per-release verification.
4. An existing install must still be detected and used.
5. "Latest" is the vendor's stable channel, for now.
6. No automatic rollback. A release a vendor broke is not Podium's to fix.
7. Nothing finds a harness by name. Everything goes through the access
   contract.
8. Podium's side has a home of its own, separate from the person's.
9. The credential is passed in where it can be, instead of a home per
   credential.
10. The person's full local setup stays supported as it is. A machine that
    holds nothing of the person's is the future default and Podium has to
    provide for it.
11. The record of installs is a database, not a file.
12. **Codex keeps its own daemon copy** (6.3, decided 2026-11-20). Codex
    launches the way it does by default; its copied daemon may update itself.
    A newer Codex is welcome, so Podium does not hold Codex to the release it
    installed. Podium installs the release, the harness row says that Codex
    updates its own server, and a running session may move to the newer
    server.
13. **A harness whose own updater cannot be stopped is installed once and its
    updates are left to the vendor** (6.3, decided 2026-11-20). Podium
    installs it, then no longer updates it and says so on the harness row.
    Today this applies to no harness: Cursor's `--disable-auto-update` works
    and is checked before each install.
14. **Leaving a machine is a `podium uninstall` command, also offered in the
    machine menu** (section 7, decided 2026-11-20). It undoes Podium's home
    edits, stops and removes Podium's services, and removes Podium's state.
15. **A passed-in Claude credential reaches Claude over a pipe, not the
    environment** (decided 2026-11-20; done, POD-7378). Claude reads
    `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` or
    `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, so the secret is in no
    environment and subprocess scrubbing (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`,
    which needs bubblewrap and leaves empty files in the home and repository)
    is off on Linux. Every launch path gets its own pipe, and an empty secret
    is refused. macOS and Windows keep the variable and scrubbing (section 9).

### Calls I made, for review

1. **Binaries live under the instance's state folder**, one folder per install,
   never changed after publishing, with the current one named in a record
   instead of a link (5.2).
2. **Adapters download the vendor's file directly where it has a checksum**,
   and otherwise run the installer inside a contained home (5.3).
3. **A machine uses Podium's side for a harness when a managed install of it
   exists**, and the person's own login always stays on the person's side. No
   separate setting (4.2).
4. **Podium never installs silently and never takes over the person's own
   install** (6.1).
5. **Checks run at daemon start and every six hours; an update runs as soon as
   one is found**, without waiting for idle (5.5).
6. **A process keeps its release; a session's next process takes the current
   one.** This changes what a waking engine does (6.2).
7. **Two releases stay on disk**: current and previous, plus any in use (5.5).
8. **A person can go back one release**, by hand (5.6).
9. **A vendor sign-in on Podium's side keeps its own folder, linked to the
   Podium home** (4.3).
10. **The Podium home is filled by copying from the person's folder where there
    is one, once and on request.** Permissions, trust and hooks are never
    copied (4.5).
11. **A harness with no folder variable is managed only where the person has no
    install of their own**, until a variable is measured. If the person installs
    their own copy later, the row says so and offers to remove Podium's (4.7).
12. **Posture's and credential access's per-session files stay files.** Only
    the install record, which is queried across sessions, is a table (6.2).
13. **Home edits are recorded only in the person's folder, and undone only on
    request or when Podium leaves the machine** (section 7).
14. **All six harnesses are targets.** Claude Code, Codex and Grok first, then
    OpenCode, Pi and Cursor (section 9).

### Not in this phase

- **The person's harness setup held by Podium**, for machines that hold
  nothing of the person's (4.5). The Podium home is where it lands.

## 13. Order of work

To be split into tasks once the design is agreed. Proposed tasks, in order:

1. **Spike: measure the open cells.** No product code. For each harness, in a
   fresh folder and a Podium home, on a machine that also has a vendor-made
   install:
   - does the binary run from a Podium folder;
   - does the updater switch of 6.3 keep it from writing anywhere;
   - for Codex from 0.169, which binary serves a session once the app-server
     daemon has copied itself into the home, and whether that copy and its
     update loop can be switched off;
   - what Codex's standalone updater does for a binary outside its own package
     folder;
   - a folder variable for Grok, OpenCode, Pi and Cursor that moves login,
     conversations and state together;
   - that a managed binary in a Podium home leaves the person's own folder and
     install untouched;
   - what Cursor's updater does and where it writes;
   - the stable pointer and file layout for OpenCode, Pi, Cursor and Windows
     builds.
2. **Ledger.** The database, the install lock, rebuild from the release
   folders.
3. **Install contract and mechanism.** The new section shape, the steps of
   5.4, housekeeping, the conformance test with a fake vendor host.
4. **Inventory and provenance.** Two installs per harness, `provenance` on
   `HarnessInstallation`, the binary chosen by the session's home, the wire
   fields.
5. **The Podium home.** One per harness, used by passed-in credentials and
   linked from sign-in folders on Podium's side; filled from the person's
   folder where there is one. Changes credential management's code.
6. **One task per harness**: Claude Code, Codex, Grok; then OpenCode, Pi and
   Cursor. Each is the install section plus the updater switch in its posture
   section.
7. **Updater.** The schedule, the checks, pause, the rejected list.
8. **Sessions.** The per-session install row, the engine-wake change,
   re-attach from the row.
9. **Going back.** The manual action and the rejected list.
10. **Home-edit records and undo**, for the person's own folder.
11. **Requests and display.** The capability and the daemon requests, the
    harness list, the notices, the CLI verbs, the installer's `--agents` option
    on the new mechanism.
12. **Acceptance run** in the VPS lab (section 10).

Tasks 2 to 4 have no visible effect and can land first. Task 1 gates task 6.

Filed as POD-7265 to POD-7285 under POD-6865: four phases (Install foundation,
Harness installs, Updates and controls, Managed installs acceptance), with task
6 split into one task per harness and tasks 7 and 9 merged into the updater
task.

**Base.** Posture is on `dev/mw` and credential management lands there next.
This phase is built on `dev/mw` once credential management has landed: tasks
4, 5, 8, 10 and 11 change files credential management also changed
(`session-harness-context.ts`, `control/access.ts`, `control/inventory.ts`,
`homes/share.ts`, the `AgentInventory` shape, `host-runtime.ts`).

## 14. Related

- POD-6520: the harness access contract. Section 6 names this work.
- POD-6858, `harness-session-posture.md` section 9: the meeting points with
  posture.
- POD-6876: harness home edits, whose record this design adds.
- POD-4478: the install section every adapter has today.
- POD-6533, POD-6546: session-pinned contexts and the engine-wake rule that
  6.2 amends.
- POD-6857: credential management. Section 10 of its specification covers
  homes; the code is in `apps/daemon/src/homes/`.
- POD-6893: the measurements behind homes, including the login that cannot be
  copied and Codex's own copy in the home.
