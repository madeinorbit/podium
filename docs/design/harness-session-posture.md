# Session posture: one launch policy for every harness

Design for POD-6858. Revision 3, 2026-11-12. Revision 3 applies the design
review (`harness-session-posture-review.md` on POD-6858) and the operator's
corrections to it.

Harness behaviour was measured on Claude Code 2.1.322, Codex 0.167.1/0.167.2,
OpenCode 1.18.35, Grok 1.0.46 and Pi 1.5.2 as installed on this machine. Cursor
is not installed here, so its rows come from documentation only.

Podium code is cited from `dev/mw` at `760a7b1007`. Revision 1 cited `main`,
which is 828 commits behind. The facts in section 1 were re-checked on `dev/mw`
and hold; the design in section 4 was rebuilt on the harness access contract
that `dev/mw` already has (`docs/design/harness-access-contract.md`, POD-6520).

## 1. The problem

A person adds a repository to Podium and starts an agent. Three things can go wrong
before the agent does any work, and none of them is visible in chat view:

1. The CLI stops at "do you trust this folder?". The prompt is drawn in the terminal.
   A message sent from chat is swallowed by it.
2. The agent runs `podium issue prime` and the CLI asks permission for the command.
   An agent that cannot use the Podium CLI cannot work inside Podium.
3. Some other startup menu is up: an update offer, a first-run notice, a survey.

Each harness has its own way to prevent each of these, and Podium launches each
harness in up to four ways. Today that knowledge is partial and scattered, and the
product code that starts sessions speaks one vendor's vocabulary.

### What Podium does today

| Harness | Terminal (stock TUI in a PTY) | Headless |
|---|---|---|
| Claude Code | No trust handling, no allow rule, no permission mode. Starts in whatever the user's own settings say. | Stream child defaults to `--permission-mode auto`. Product code passes `allowedTools` in Claude's rule syntax. |
| Codex | `-c sandbox_workspace_write.network_access=true` so the CLI can reach the daemon. Nothing for trust or the update menu. | App-server forces `sandbox_mode="workspace-write"`. Network is opened only when an MCP server is mounted. |
| OpenCode | Always `--auto` (approve everything not denied). | Server routes permission asks to chat. |
| Grok | Nothing. | `--permission-mode auto` only when the caller passed the word `auto`. |
| Pi | Nothing. | `--approve` when the caller passed one of four Claude mode names. |
| Cursor | Nothing. | `--auto-review` only when the caller passed the word `auto`. |

Four defects follow from this table:

- **The same harness behaves differently by driver.** A Codex terminal session
  can reach the daemon; a Codex app-server session without an MCP mount appears
  not to be able to (`driver/families/codex/engine-host.ts:183`). OpenCode
  approves everything in the terminal and asks in chat view. A Claude session in
  chat view is told to run in auto mode; in the terminal it runs in whatever the
  person's own settings choose, which since 2.1.283 is also auto unless they
  changed it.
- **Product code names vendor concepts.** `apps/server/src/modules/superagent/service.ts:1126`
  passes `permissionMode: 'auto'`. `adapters/pi/index.ts:62` maps Claude's mode names
  onto a Pi flag. `allowedTools` is a Claude rule list that the Codex adapter
  documents ignoring.
- **Nothing handles trust.** It is only detected, by reading the screen, and the
  session then waits for a person to open the terminal (POD-4632, POD-4650, POD-109).
- **Detection drifts.** The Codex detector (`adapters/codex/state.ts:36`) matches
  "Do you trust the contents of this directory?" and "1. Yes, continue". Codex 0.167
  draws "Trust this folder?" and "1. Trust and continue", so it no longer fires.

### What `dev/mw` already has

The harness access contract answers "which binary, which environment, which
folders" once per session:

- `HarnessContext` (`packages/harness/src/harness-context-types.ts`): the pinned
  installation (executable, version), the account home, the account environment
  and the harness's folders (`roots`). Required on every `SessionSpec`.
- Adapters declare argv without a command. `harnessCommand(context, argv)` is the
  only constructor of a `BoundCommand`, and every harness spawn site accepts only
  a `BoundCommand` (`packages/harness/src/bound-command.ts`).
- `harnessChildEnv` builds the one child environment.

It does not answer "on what terms does the process run". That is this design.

## 2. Research: what each harness offers

Evidence tags: **live** = run on this machine in a never-seen folder;
**doc** = vendor documentation; **ref** = Podium's own notes in
`docs/agent-harness-reference/`, not re-checked; **?** = to be measured.

### Folder trust

| Harness | Is there a prompt? | How to pre-answer it |
|---|---|---|
| Claude Code | Yes, in the terminal only. The selected row is "No, exit", so a stray Enter ends the session (**live**). `-p` and stream sessions never show it, but an untrusted folder's own allow rules are then ignored (**doc**). | Only one way: set `projects["<repo root>"].hasTrustDialogAccepted = true` in `~/.claude.json`. The vendor documents this as "trust it by hand". No flag, no environment variable, and `--settings` cannot set it (**doc**). Trust is keyed on the main checkout's root, so one entry covers every worktree (**doc**). |
| Codex | Yes (**live**). | Per launch, nothing written: `-c 'projects={"<root>"={trust_level="trusted"}}'` (**live**). The obvious dotted form `-c 'projects."<root>".trust_level="trusted"'` is accepted and silently does nothing (**live**). Whether a `resume --remote` client accepts it: **?** |
| OpenCode | No (**live**). | Nothing needed. |
| Grok | No folder prompt known. Project trust gates only project hooks and plugins (**ref**). Not observable here: this home is signed out. | Nothing known. **?** |
| Pi | Only when the folder has project-local Pi files (**live**: none in an empty folder). | `--approve` for this run (**live** in `--help`). |
| Cursor | Yes in the terminal (**ref**). | Headless: `--trust`. Terminal: a marker file `~/.cursor/projects/<slug>/.workspace-trusted`, which is vendor-private state (**ref**). |

### Running the Podium CLI without a prompt

| Harness | Mechanism | Per-launch channel? |
|---|---|---|
| Claude Code | An allow rule `Bash(podium *)`. Allow rules merge across sources, so this adds to the user's rules and replaces none. Narrow rules stay in force in auto mode (**doc**). | Yes: `--allowedTools`. |
| Codex | A rules file: `prefix_rule(pattern=["podium"], decision="allow")`. Evaluates to allow (**live**, `codex execpolicy check`). An allowed command runs outside the sandbox with no prompt (**doc**), which also gives it the loopback access it needs. | No. Rules load from a `rules/` folder beside a config layer, such as `~/.codex/rules/` (**doc**). |
| OpenCode | A shell allow rule in config. The default policy already allows shell (**doc**). Rule syntax differs between 1.x and current docs (**?**). | Yes: `OPENCODE_CONFIG_CONTENT`, already used for instructions. |
| Grok | `--allow <rule>`; rule grammar **?**. | Yes for the terminal. ACP engine: **?** |
| Pi | Pi has no approval gate (adapter note). | Nothing needed. |
| Cursor | `permissions.allow: ["Shell(podium)"]` in `~/.cursor/cli-config.json` (**doc**). | No. |

### Startup menus that can swallow input

| Harness | Found | Suppression |
|---|---|---|
| Codex | "Update available" menu. The selected row runs the updater on Enter (**live**). | `-c check_for_update_on_startup=false` (**live**). |
| Claude Code | One-time auto-mode notice; bypass-mode confirmation; "How is Claude doing?" survey; theme picker; `/auto-mode-setup` wizard seen on 2.1.231. | `skipAutoPermissionPrompt`, `skipDangerousModePermissionPrompt` (settings keys), `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` (**doc**). Theme is already seeded. Wizard: **?** |
| Others | None observed in a fresh folder with an existing home. A fresh home was not tested. | **?** |

### Other facts that shaped the design

- Claude Code accepts `--permission-mode default` on every version; `manual` is
  a newer alias for it (**doc**). When auto mode is not available to a session,
  Claude Code starts it in Manual without an error (**doc**), so the mode Podium
  asks for is not always the mode in force.
- A non-interactive Claude Code session connects a repository's declared MCP
  servers without asking; an interactive one asks first, in a dialog (**doc**).
- Codex removed `approval_policy="untrusted"` in 0.149 and added `--approve-for-me`.
  Mode names are not stable across releases.
- Codex changed version from 0.167.1 to 0.167.2 on this machine while this
  research ran. Harness versions move under running sessions.
- Podium stages attachments outside the working folder
  (`apps/daemon/src/session-uploads.ts`). A harness that confines reads to the
  folder will prompt for them.
- An issue worktree's git metadata lives in the main checkout's `.git`. A sandbox
  that confines writes to the working folder may block `git commit`. **?**

## 3. What "set up right" means

| # | Requirement | Name in code |
|---|---|---|
| R1 | The folder is trusted. No harness asks about a folder the user chose in Podium. | `workspace-trust` |
| R2 | The Podium CLI runs without a prompt and can reach the daemon. | `podium-cli` |
| R3 | The same harness runs in the same mode in every driver, and the mode shown in the UI is the mode in force. | `autonomy` |
| R4 | Startup is quiet: no update, onboarding, notice or survey menu. | `quiet-start` |
| R5 | Podium's own material is usable without a prompt: the files a person attached in chat, and Podium's MCP tools. | `podium-material` |
| R6 | All of it is re-applied on resume, restart, adoption and for a terminal attached to a running engine. | by construction (4.5) |
| R7 | A requirement a harness cannot meet is reported, never dropped silently. | `unmet` |

Everything Podium adds is additive and scoped to the launch where the harness
allows it. Where it is not (two settings edits, section 4.7), the design says
what else it affects. In a Podium session, Podium's mode decides, over a default
in the person's own harness settings. For an install the user owns, Podium does
not decide the update policy; it only stops update menus from blocking a session.

## 4. The design

### 4.1 The idea

Product code states **what Podium needs to be true** of a session, in Podium's
words. Each adapter states **how its harness makes that true**, for each way
Podium launches it. One function per harness, and the type system makes it
impossible to start a harness process that skipped it.

Everything is decided before the process starts: flags, inline config, and at
most one settings edit. Nothing in this design reads a terminal screen, waits
for a harness to become ready, polls, or types a key.

### 4.2 Where each part runs

| Part | Runs in | Crosses the network |
|---|---|---|
| Choosing the session's mode | server | once, inside the frame that already starts the session or the turn |
| Podium's standing facts (CLI path, uploads folder) | daemon, on the harness's machine | never |
| Turning terms into flags and config | daemon (adapter code) | never |
| Editing a harness settings file | daemon, on the machine that holds that file | never |
| Starting the process | daemon | never |
| Reporting what could not be met | daemon to server to clients | once, with the spawn report |

The server sends one small value and receives one report. It takes no part in a
launch after that: no loop, no measuring, no second round trip. A session that
resumes while the server is unreachable uses the terms stored with it in the
daemon. On several machines, each daemon applies the same terms to its own
harness home, so nothing has to be synchronised between machines.

### 4.3 What product code says

```ts
/** How far the agent goes without asking a person. No harness words. */
export interface SessionPosture {
  mode: 'supervised' | 'autonomous' | { native: string }
}
```

- `supervised`: asks before it edits or runs a command.
- `autonomous`: works without asking inside the harness's own safety net.
- `{ native }`: a mode the person picked from that harness's own served list.
  Opaque to product code.

The default, decided: `{ mode: 'autonomous' }`. In a Podium session, Podium's
mode decides: it is passed at launch and takes precedence over a default mode
in the person's own harness settings.

`SessionSpec.posture` replaces `permissionMode`, `allowedTools` and
`structuredPermissions` on the session spec and on the wire. `toolPolicy: 'none'`
stays: turning every tool off is a different axis.

Folder trust is not a field. Every folder a Podium session runs in was chosen in
Podium, so it is always trusted (decision 1).

### 4.4 What the daemon adds

Three facts are the same for every session. The daemon builds them once per
session, the way it builds the harness context:

```ts
export interface PodiumGrants {
  /** The Podium CLI: runs without asking and may reach the daemon. */
  podiumCli: { name: string; path: string }
  /** Where this session's chat attachments are saved. Read-only for the agent. */
  uploadsDir: string
  /** Podium's own MCP servers; their tools need no approval. */
  mcpServers: readonly string[]
}
```

The uploads folder is not about trust. When a person attaches a file or an image
in chat, the daemon saves it in Podium's own state folder, outside the
repository, and the message gives the agent its path. A harness that only reads
inside its working folder would ask before opening it. The repository folder
itself needs nothing here: it is the working folder, and R1 covers it.

Product code never lists these. That removes the Claude-syntax `allowedTools`
list in `apps/server/src/modules/superagent/tools.ts`.

### 4.5 What an adapter says

One new adapter section, owned by the Driver mechanism:

```ts
export type LaunchMode =
  | 'terminal'  // the stock TUI in a PTY
  | 'engine'    // a persistent headless process Podium speaks a protocol to
  | 'turn'      // one process per turn, one-shot exec included
  | 'client'    // a stock TUI attached to a running engine

export interface PostureRequest {
  mode: LaunchMode
  posture: SessionPosture
  grants: PodiumGrants
  workdir: string
  /** The main checkout when `workdir` is a worktree. */
  repoRoot?: string
  /** Session-scoped folder for generated config files. */
  runtimeDir: string
  /** Home, environment, folders and installed version: the pinned context. */
  context: HarnessContext
}

/** The part of a launch posture may add to. */
export interface PostureLaunch {
  args: readonly string[]
  env: Readonly<Record<string, string>>
  files: readonly LaunchFile[]
}

export interface PostureResult {
  launch: PostureLaunch
  /** Edits to the harness home, for facts with no per-launch channel. */
  homeEdits: readonly HomeEdit[]
  /** The harness mode Podium asked for. Not proof of the mode in force. */
  requestedMode: string | null
  /** What this harness cannot do in this launch mode, and why. */
  unmet: readonly { requirement: PostureRequirement; reason: string }[]
}

// On the adapter:
posture(launch: PostureLaunch, request: PostureRequest): PostureResult
```

The section is a pure function. It receives the args, env and files the
adapter's existing builders produced and returns them with its own added. The
adapter places its flags where its own command line allows them.

It can only add. Where the terms are applied, Podium checks that the builder's
args are all still there in the same order, that every generated file is inside
`runtimeDir`, and that every home edit is inside the context's home or roots.
It cannot change the executable or the working folder.

### 4.6 One way in

The access contract has one constructor for a launchable harness command:
`harnessCommand(context, argv)`. It gains a required third argument:

```ts
harnessCommand(context, argv, terms)

type LaunchTerms =
  | { posture: AgentManifest['posture']; request: PostureRequest }
  | { noAgent: string }   // a native login pane, a chat-id allocation: the reason, in words
```

A command cannot be built without saying on what terms it runs, so the compiler
lists every launch path. There are twelve. Resume, restart and a terminal
attached to an engine all pass through one of them, which is how R6 holds. A
tool-less turn passes `{ noAgent }`: it has no tools to govern and must not gain
a tool flag.

The bound command carries what the function returned. The daemon functions that
create a harness process (the session PTY spawn, the engine start, the buffered
exec) then do three generic things, once each, none of which names a harness:
write the files, apply the home edits, and report `requestedMode` and `unmet`
with the spawn.

### 4.7 Writing in the harness home

Where a harness has a per-launch channel, the adapter uses it and writes nothing
outside the session's runtime folder. Two cells have no such channel:

- **Claude Code's trust key.** One documented key in `~/.claude.json`.
- **Codex's rule for the Podium CLI.** A file Podium owns, `rules/podium.rules`,
  in the Codex home. Decided by the operator: Codex needs it, because without it
  Codex's reviewer often flags Podium's CLI as overstepping.

```ts
export type HomeEdit =
  /** A file Podium owns outright and names as its own. */
  | { kind: 'owned-file'; file: string; contents: string; serves: PostureRequirement }
  /** One key in a file the harness owns. Nothing else in the file changes. */
  | { kind: 'json-key'; file: string; path: readonly string[]; value: JsonValue; serves: PostureRequirement }
```

`serves` names the requirement that becomes unmet when the edit cannot be made.

Rules for the one daemon mechanism that applies them:

- Skip when the home already holds the value. In steady state it writes nothing.
- One edit at a time per file. Read, set the one key, write beside the file,
  rename over it, read again. If another writer won, retry once, then give up.
- A failed edit becomes an `unmet` entry. The session still starts.
- Each edit that is made is logged with its file and key.
- An adapter may only declare an edit that the vendor documents, or a file Podium
  owns. Vendor-private state is not written (the POD-4076 rule).

**Both edits reach beyond Podium, and that is accepted.** A harness home is
shared with the person's own use of that harness.

- The Claude key marks the repository trusted for their own Claude Code
  sessions too. That is the decision: the folder is trusted.
- The Codex rule lets every Codex session that uses that home run `podium`
  without asking and outside the sandbox, including sessions Podium did not
  start. There the CLI acts with the person's own authority. No per-session way
  to load a Codex rule was found; the spike looks again. A harness home that
  Podium owns (section 9) would remove this.

Pre-approving the Podium CLI is safe inside a Podium session because the server
authorises each CLI verb by the session's identity. Harness approval is not the
security boundary for the CLI.

There is no ledger and no undo in this phase. The ownership record belongs to
the managed-installs phase, where its second user appears.

### 4.8 How each harness realises it

This is the target. Cells marked **?** are filled by the spike.

| | R1 trust | R2 Podium CLI | R3 mode: supervised / autonomous | R4 quiet start | R5 Podium material |
|---|---|---|---|---|---|
| **Claude Code** | `json-key` edit on the repo root, all modes | allow rules `Bash(podium *)` and `PowerShell(podium *)` by flag | `default` / `auto` | static keys in the adapter's own session settings file, survey env | allow rule `Read(<uploads>/**)`, `mcp__<server>` |
| **Codex** | `-c projects={…}`; client: **?** | `owned-file` `rules/podium.rules`; loopback open in the sandbox in every mode | terminal: `-a on-request` / `--approve-for-me`; engine: asks reach chat / automatic review; turn: unmet / `--approve-for-me` | `-c check_for_update_on_startup=false` | reads are unrestricted by default; MCP: **?** |
| **OpenCode** | met by default | allow rule in inline config | ask rules / `--auto` | **?** | allowed by default |
| **Grok** | **?** | `--allow`; engine: **?** | `default` / `auto` | **?** | **?** |
| **Pi** | `--approve` | met by default | unmet / met by default | **?** | met by default |
| **Cursor** | turn: `--trust`; terminal: unmet (private state) | **?**, unmet until measured | nothing / `--auto-review` | **?** | `--approve-mcps` |

- **Claude needs no settings merge.** Its rules and mode have flags. The two
  notice-skipping keys are static, so they sit in the session settings file the
  Claude adapter already writes for hooks, beside the theme seed.
- **Claude trust is applied in every mode.** Without it a chat-view session
  ignores the repository's own allow rules and a terminal session honours them.
- **Codex keeps loopback open in every mode.** Today the app-server only opens
  it when an MCP server is mounted.
- **Pi cannot be supervised.** It has no approval gate. The adapter reports that
  as unmet and the UI says so.
- **Windows.** Claude Code there runs commands through a PowerShell tool with
  its own rule form, so the Claude adapter emits both forms everywhere. Nothing
  else is known to differ. Not measured.

### 4.9 What changes for existing code

| Today | After |
|---|---|
| `permissionMode`, `allowedTools`, `structuredPermissions` on `SessionSpec`, three wire frames and six server modules | `posture` |
| `harnessCommand(context, argv)` | `harnessCommand(context, argv, terms)` |
| Codex network flag in `launch()` and conditionally in `engine-host.ts` | the Codex posture section, every mode |
| OpenCode's unconditional `--auto` | chosen by the mode |
| Pi's `AUTO_PERMISSION_MODES`, Grok's and Cursor's `=== 'auto'` checks | each adapter maps Podium's two levels |
| Claude stream child's own mode default | chosen by the mode, same as the terminal |
| The mode chip shows the mode Podium sent | the mode the harness reports, or the requested one where it reports none |

`configure({ permissionMode })` for a mid-session change is untouched.

Podium's existing screen detectors for trust prompts are left as they are. This
design adds none and does not depend on them. The Codex one is refreshed to the
current wording, because it is already there and currently matches nothing.

## 5. How robust it is

What Podium adds at launch is deterministic: the same inputs give the same
command line, and nothing is observed or awaited. Four things can still go
wrong, and each has one plain outcome:

| What goes wrong | What happens |
|---|---|
| A harness cannot do something (Pi cannot be supervised; Cursor's terminal trust) | Known when the launch is built. Reported with the spawn as `unmet`; the session shows one notice naming the harness and the reason. |
| A vendor renames or removes a flag in a new release | The CLI refuses to start. Podium's existing start-failure banner shows the CLI's own message. The adapter is fixed, choosing the spelling by installed version. |
| A vendor adds a new startup menu to its terminal UI | Terminal sessions only: nothing can pre-empt a menu that does not exist yet, and the person sees it in the terminal view. Chat view over an engine has no menus. |
| Another program rewrites a harness settings file at the same moment | The edit is re-read after writing and retried once. If it still fails it is reported as `unmet`, and the next launch tries again. |

Decided: a harness has a minimum version only. Podium does not verify each
vendor release. Two checks back the design:

1. **Conformance (pure, every build).** For every harness, launch mode and mode
   level in the registry, the terms are applied and the result is
   snapshot-checked. A new harness without a posture section does not compile.
2. **One acceptance run.** A fresh agent home and a never-seen git folder, on an
   isolated instance. Each harness in each view must start with no prompt, and
   `podium issue prime` must run without an ask.

A generated matrix, in the style of `harness-support-matrix.md`, prints section
4.8 from the adapters, so the document cannot drift from the code.

## 6. Order of work

The implementation plan is `docs/plans/pod-6858-session-posture-plan.md`. In
short: a spike that fills the open cells; the contract with no behaviour change;
terms required on every launch; the home-edit mechanism; one task per harness;
product code on `posture`; reporting; the acceptance run.

It is filed as one phase of this issue, on the integration branch
`integrate/6858-harness-launch-configuration`, based on `dev/mw`. Nothing lands
on `dev/mw` until the operator says so.

## 7. Decisions (operator, 2026-11-12)

1. **Adding a folder to Podium is the act of trusting it, for every harness.**
   Said once where the folder is added. The folder's own agent settings and hooks
   take effect without a second question. It does not approve the MCP servers a
   repository declares (see the open question below).
2. **The default mode is `autonomous`, everywhere.**
3. **Podium may make narrow home edits:** vendor-documented keys and
   Podium-owned files. Cursor's terminal trust prompt stays until Cursor
   documents a way.
4. **A harness has a minimum version only.** No per-release verification.
5. **Managed installs are a later phase of this issue** (section 9), planned once
   development of this phase has started.
6. **Codex gets a standing rule for the Podium CLI.** Its wider reach (4.7) is
   accepted.

**Open question.** Decision 1 keeps a repository's declared MCP servers asking.
In a Claude Code terminal session that ask is a dialog at startup, in the
terminal, which a chat message cannot answer. In chat view over the engine,
Claude Code connects those servers without asking (vendor docs). So the two
views differ, and the terminal one stalls where nobody is looking. The robust
choices are to enable them with trust, or to switch them off for Podium
sessions. Recommended: enable them with trust, which is what chat view already
does.

## 8. Calls I made

- The name *posture*; two levels plus a native pick.
- Terms as a required argument of the existing constructor (4.6).
- A function that can only add to a launch (4.5).
- Claude uses flags, so no settings merge is needed (4.8).
- No ledger, no undo, no engine-side auto-approval, no new screen detectors.
- `toolPolicy: 'none'` stays separate.
- Hook trust for Codex (POD-4076) is not reopened.

## 9. Managed installs: a later phase of this issue

Podium should be able to install and manage a harness for the user, mark that
install as managed, and keep it updated, while still detecting and working with
an existing install.

This is Inventory work. The access contract already names it as the next thing to
build on top of itself: "an update becomes 'publish a new installation
generation; running sessions keep theirs'", and `HarnessInstallation` "leaves
room for a later `managed | external` provenance field". An install section
exists on every adapter (POD-4478). It runs the vendor's installer for the latest
version and checks `--version`. It has no managed mark, no update and no removal.

Three points where it meets this phase:

1. **An ownership record per machine** is that phase's to design. It then
   records this phase's home edits too, which are re-derived at every launch.
2. **Posture will read install ownership from the context.** When
   `installation` gains its provenance field, posture turns the vendor's own
   updater off for a managed install. Until then it only suppresses update menus.
3. **A harness home Podium owns** would keep the Codex rule and the Claude trust
   key away from the person's own use of those harnesses (4.7).

A managed install takes the vendor's latest release at or above the minimum
version. Sketch of how and when it updates, to be settled when that phase is
planned:

- **Where.** Versioned folders under Podium's state, with a current pointer.
  Never into the user's `~/.local/bin`.
- **When.** At daemon start and on a schedule, in the background: download,
  check `--version` against the minimum, then move the pointer. Never during a
  turn and never by asking.
- **Running sessions** keep the binary they started with.
- **Failure.** The previous version stays. If the new one will not start, the
  pointer does not move and the machine reports it.

## 10. Related issues

- POD-6520: the harness access contract this design builds on.
- POD-109: the original report of the trust and CLI-approval stall. This covers it.
- POD-3099: asks for a launch-time control that selects an ask-first posture for
  the Claude SDK. That is `mode: 'supervised'` here.
- POD-4632, POD-4650, POD-6615: the existing screen detectors, unchanged.
- POD-4076: Codex hook trust, unchanged.
