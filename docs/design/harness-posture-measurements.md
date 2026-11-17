# Harness posture measurements

Measurements for the session posture design (`harness-session-posture.md`,
POD-6858). Task 0 of `docs/plans/pod-6858-session-posture-plan.md`, done on
2026-11-12 under POD-6879. Section 4.8 of the design is filled from this file.

## How it was measured

- Machine: a Linux test host (Ubuntu 24.04, kernel 6.8) with every harness
  installed. Turns that need a model reply from Claude Code ran on a second
  Linux host, because the first host's Claude account was at its weekly limit.
- Versions: Claude Code 2.1.322, Codex 0.167.1 (0.167.2 on the second host;
  0.147.0 installed in a scratch folder for the minimum-version checks),
  OpenCode 1.18.35, Grok 1.0.70, Pi 1.5.0, Cursor Agent 2026.07.23-e383d2b.
- Tool: `bun scripts/posture-probe.ts --harness <kind> --home <dir> --cwd <dir> [-- <args>]`.
  It starts the CLI in a PTY (120×40) with `HOME` set to a fresh folder and
  `PODIUM_*`, `CLAUDE_CODE_*`, `CLAUDECODE` and `XDG_*` removed, waits a fixed
  time, and prints the screen. It never sends a key. A prompt given as a
  command-line argument starts a turn without typing.
- Every run used a fresh home and a fresh `git init` folder unless the row
  says otherwise. "Signed in" means only the harness's credential file was
  copied into the fresh home; nothing else from the real home.
- Codex's Linux sandbox could not start on the first host (bubblewrap cannot
  create a user namespace there: `bwrap: loopback: Failed RTM_NEWADDR`), so
  every sandboxed Codex command fails on that host. Sandbox behaviour was
  measured on the second host. Podium sessions on such a host hit the same
  failure; that is a host fact, not a posture fact.

Raw probe output is attached to POD-6879 as `posture-probe-raw`.

## Claude Code 2.1.322

| Question | Result |
|---|---|
| Fresh home, nothing seeded | Onboarding theme picker, then sign-in. `--settings '{"theme":"auto"}'` does not skip it: the picker is gated on `hasCompletedOnboarding` in `~/.claude.json`, which a home gets when Claude itself signs in (and which Podium's credential transfer already seeds). |
| Signed-in, onboarded home, untrusted folder | Trust dialog "Quick safety check … ❯ No, exit / Yes, I trust this folder". The selected row exits. |
| Does the `json-key` trust edit work in a fresh home? | **Yes.** With only `projects["<folder>"].hasTrustDialogAccepted = true` seeded, the session starts at the prompt with no dialog. |
| Does the key on the main checkout cover a worktree? | **Yes.** Key on the main checkout root, session started in a linked worktree elsewhere on disk: no dialog. |
| Does a session already running elsewhere undo the edit when it saves? | **No.** Session A ran in folder X. 12 s in, the key for folder Y was added by write-beside-and-rename. A then wrote the file twice more (graceful shutdown: its own project stats, `autoUpdates`, `installMethod`). The key for Y was still there and A's own writes were also there: Claude re-reads the file before it writes. |
| Does `--allowedTools` apply in an interactive session? | **Yes.** `--permission-mode default '--allowedTools=Bash(podium *)'` ran `podium --version` with no prompt; the same launch without the flag showed "This command requires approval". |
| `--allowedTools` spelling | **Use the `=` form.** The option is variadic: `--allowedTools 'Bash(podium *)' "<prompt>"` swallows the prompt as a second rule and the session starts with no turn. `--allowedTools=<rule>` (one flag per rule) or a following `--` boundary keeps the prompt. |
| Rule that allows reading one absolute folder | **`Read(//<abs path>/**)`** (two slashes). `Read(/<abs path>/**)` (one slash) did not match: the Read prompt still appeared. |
| `--permission-mode auto` in a fresh home: auto-mode notice | A notice is printed into the transcript ("Auto mode lets Claude handle permission prompts automatically …") and the footer shows `⏵⏵ auto mode on`. It is **not modal**: the input box has focus and a prompt given at launch runs. `skipAutoPermissionPrompt: true` in `settings.json` does not remove it, and nothing needs to. The default-mode notice ("Auto mode is now Claude Code's default permission mode") is the same kind of transcript notice. |
| `/auto-mode-setup` | **Not seen on 2.1.322.** Fresh signed-in home, trusted folder, `--permission-mode auto`, one turn ("Reply ok"), watched 45 s after it ended: no wizard. (It was seen on 2.1.231.) No settings key is needed. |
| Mode reported when auto mode is not available | The session starts in manual mode without an error. TUI footer: `⏸ manual mode on`. Stream session (`-p --output-format stream-json --permission-mode auto`): the `system/init` event reports `"permissionMode": "default"`. Made unavailable with `--settings '{"disableAutoMode":"disable"}'`. `--model haiku` keeps auto mode. |
| `--permission-mode default` | Footer `⏸ manual mode on`. |
| Other startup notices | "Fable 5.2 is here …" and "N more notices hidden": transcript notices, not modal. No survey or update menu appeared. |

## Codex 0.167.1

| Question | Result |
|---|---|
| Fresh home, nothing seeded | Sign-in menu. |
| Signed in, untrusted folder | "Trust this folder? … › 1. Trust and continue / 2. Back to Agent Command Center". |
| `-c 'projects={"<folder>"={trust_level="trusted"}}'` | **Works**: no trust prompt, nothing written to `config.toml`. |
| Update menu | Seen in two forms. First start: a banner ("Update available! 0.167.1 -> 0.167.2. Run bun install -g @openai/codex"), not modal. Later starts in the same home: a **modal** menu "› 1. Update now (runs `bun install -g @openai/codex`) / 2. Skip / 3. Skip until next version"; Enter runs the updater. Seen on `resume --remote` clients. `-c check_for_update_on_startup=false` removes both. |
| Is `rules/podium.rules` in the Codex home loaded by the **TUI**? | **Yes.** `prefix_rule(pattern=["podium"], decision="allow")` in `$CODEX_HOME/rules/podium.rules`. Under `-a on-request -s workspace-write`, `podium issue ready` ran outside the sandbox with no prompt (it reached the server: the server's 401 came back). Without the file, the same command ran inside the sandbox; when the model asked to escalate, the TUI showed "Would you like to run the following command? … Reason: May I run podium issue ready with network access?". |
| Is it loaded by the **app-server**? | **Yes.** `codex app-server` over stdio, `sandbox_mode="workspace-write"`, approval policy `on-request`: with the file, no `item/commandExecution/requestApproval` and the command reached the server; without it, an approval request arrived. |
| With the rule, does the automatic reviewer still see `podium` commands? | **No.** Under `--approve-for-me` with the rule, the command ran directly with no review. Without the rule and with an escalation, the reviewer approved it in the one run made; the operator has seen it flag Podium's CLI. The rule takes the reviewer out of the path. |
| Any way to load a rule for one session only? | **None found.** `-c rules.prefix_rules=[…]` is ignored with the warning "session-flags: `rules` is ignored". `-p <profile>` layers `$CODEX_HOME/<name>.config.toml`, but rules still come from `$CODEX_HOME/rules/`. A project layer **is** loaded: `<folder>/.codex/rules/*.rules` in a trusted folder allowed `podium` in the app-server. That is scoped to the repository, not the session, and writes into the user's tree. |
| Does `resume --remote` accept `-c projects={…}`? | **Accepted, no effect.** The client starts with it, but trust is decided by the app-server: against an app-server started without the trust override, the client shows the trust prompt with or without its own `-c projects=…`; against one started with it, no prompt. So R1 in client mode is met by the engine's flag. |
| Does `resume --remote` accept `-c check_for_update_on_startup=false`? | **Yes, and it takes effect**: the update menu is drawn by the client and the flag removes it. |
| Permission overrides on `resume --remote` | Refused: `-c sandbox_workspace_write.network_access=true` exits with "Permission overrides are not supported when resuming a remote task." (unchanged from 0.166). |
| `--approve-for-me` and `approvals_reviewer` at the minimum version 0.147 | **Both exist.** 0.147.0 `--help` lists `--approve-for-me` ("Route approval requests through automatic review using the workspace-write sandbox"); `codex exec --approve-for-me` runs a turn. `--strict-config -c approvals_reviewer="auto_review"` is accepted, where `--strict-config -c bogus_posture_key=1` is refused. |
| Does `git commit` succeed in a worktree under `workspace-write`? | **No.** `codex exec -s workspace-write` in a linked worktree: `fatal: Unable to create '<main>/.git/worktrees/wt/index.lock': Read-only file system`. The same happens in the main checkout itself (`<main>/.git/index.lock`): Codex mounts `.git` read-only inside writable roots. Under `codex sandbox -P :workspace`, adding `<main>/.git` through `-c sandbox_workspace_write.writable_roots=[…]` did not lift it (a permission profile may not read that key; not pursued). A commit needs an escalation (an ask under `on-request`, the reviewer under `--approve-for-me`) or a rule. |
| Shared background server | 0.167 TUI connects to a shared background app-server unless `--no-daemon`; the daemon is per Codex home. Noted, not measured further. |

### Hook review at startup (POD-6999, 0.147.0, 0.167.2, 0.169.0)

Found by the acceptance run (POD-6867): Codex 0.169.0 in terminal view showed
"Hooks need review: 6 hooks are new or changed" for the hooks Podium's daemon
installs into `$CODEX_HOME/hooks.json`, and the first message sent went into
that modal. Measured on the acceptance test host with `posture-probe.ts`, in
scratch homes holding only `auth.json` plus that `hooks.json`, a fresh
`git init` folder, and the posture flags (`-c projects={…trusted}`,
`-c check_for_update_on_startup=false`). "Hooks fire": a listener on
`PODIUM_CODEX_HOOK_URL` received the events.

| Question | Result |
|---|---|
| Podium's `hooks.json`, nothing else | **Modal** "Hooks need review … › 1. Review hooks / 2. Trust all and continue / 3. Continue without trusting (hooks won't run)". The same on 0.147.0, 0.167.2 and 0.169.0. Without `hooks.json`: no modal. |
| What Codex documents | Non-managed hooks must be reviewed and trusted; trust is recorded "against the hook's current hash"; `/hooks` reviews them; managed hooks (`requirements.toml`, MDM, system) are trusted by policy; `--dangerously-bypass-hook-trust` runs every enabled hook without persisted trust "for that invocation". The `[hooks.state]` table, its key and its hash are **not documented**. |
| `--dangerously-bypass-hook-trust` | No modal (one more startup warning). **Rejected:** it trusts every enabled hook, the person's own and a project's included (POD-4076). `-c bypass_hook_trust=true` is not honoured: modal still shown (POD-6867). |
| What "Trust all" writes | `[hooks.state."<CODEX_HOME>/hooks.json:<event_snake>:<group>:<handler>"]` with `trusted_hash = "sha256:<hex>"` in `config.toml`. The hashes are identical in two homes at different paths: the path is only in the key. |
| The hash | SHA-256 of the canonical JSON (keys sorted, compact) of `{"event_name":"<snake>","hooks":[{"async":false,"command":…,"timeout":5,"type":"command"}]}`, plus `"matcher"` when the group has one. `commandWindows` is not part of it on Linux. Reproduced byte for byte for all six handlers, and for a handler at index 0:1 of a group with `matcher = "Bash"` (fixtures `packages/harness/src/adapters/codex/fixtures/hook-trust-0.169.0`). |
| `-c 'hooks.state={"<key>"={trusted_hash="sha256:…"},…}'` for Podium's six handlers | **No modal, hooks fire** (SessionStart, UserPromptSubmit, Stop), a prompt given at launch is answered, nothing is written to `config.toml`. Same startup warning count as a home with no hooks. Works on 0.147.0, 0.167.2 and 0.169.0. |
| The same, with one foreign handler added beside Podium's | Modal "1 hook is new or changed": only the named handlers are trusted. |
| The same, in a home whose `config.toml` already trusts a foreign handler the override does not name | No modal: the session-layer table merges with the persisted one. |
| Re-probe with the committed code (hook install plus posture section, argv as Podium builds it), 0.169.0 | No modal; the launch prompt was answered (`• PONG`); hook events SessionStart, UserPromptSubmit, Stop; no `config.toml` written. |

If Codex changes the hash or the key, the override stops matching and the
modal comes back: it fails safe. Windows is unmeasured.

### Hook review in the chat view (POD-7028, 0.147.0, 0.169.0)

The same scratch homes (`auth.json` plus the `hooks.json` Podium's install
writes), `codex app-server --listen unix://…` with the engine posture flags,
a JSON-RPC client that starts a thread and runs one turn, then the stock TUI as
`resume -C <repo> <thread> --remote unix://…` with
`-c check_for_update_on_startup=false` and a prompt, in a PTY
(`posture-probe.ts`). "Hooks fire": a listener on `PODIUM_CODEX_HOOK_URL`, set
on the engine for the measurement only.

| Question | Result |
|---|---|
| App-server, no override | The turn is answered; no hooks run; no `hook/*` notification and no warning about hooks over JSON-RPC. |
| App-server with Podium's override | The turn is answered; SessionStart, UserPromptSubmit and Stop fire, each as `hook/started` and `hook/completed`; nothing written to `config.toml`. |
| `resume --remote` client, engine without the override | **Modal** "Hooks need review: 6 hooks are new or changed"; the client's launch prompt is not sent. Same on 0.147.0 and 0.169.0. |
| The same, with the override on the client only | **Modal**, unchanged: the client's `-c hooks.state` is ignored. The engine decides, as it does for folder trust. |
| Client, engine with the override | No modal; the client's launch prompt is answered; nothing written. Same on 0.147.0 and 0.169.0. |
| Re-probe with the committed code (engine argv from the engine's trust args, engine env with `PODIUM_SESSION_ID` and no hook URL or socket), 0.147.0 and 0.169.0 | No modal; both prompts answered; Codex runs the handlers (`hook/started`, `hook/completed`) and none reaches the listener; no `config.toml`. |

### Folder trust in a worktree (POD-7039, 0.147.0, 0.169.0)

Found by the acceptance run (POD-6867): a Codex chat-view session in a linked
worktree, whose CLI tab starts `resume -C <worktree> <thread> --remote …`, drew
"Folder access: Trust this folder?" while the engine trusted only the main
checkout. Measured on the acceptance test host with a probe built like the
POD-7028 one: a scratch home holding `auth.json` plus Podium's `hooks.json`, a
repository with one commit and a `git worktree add` (both paths contain a space
and `é`), the engine started in the worktree with the engine terms
`codexPosture` builds (hook trust included), a JSON-RPC thread and turn in the
worktree, then the stock TUI as a client with a launch prompt. "Screen": the
"Folder access: Trust this folder?" screen; "Answered": the client's launch
prompt got its reply.

| Engine `projects=` | Client `-C` | 0.169.0 | 0.147.0 |
|---|---|---|---|
| main checkout only (the old terms) | worktree | **Screen**; prompt not sent | No screen; answered |
| main checkout only | main checkout | No screen; answered | not run |
| main checkout only, plus the client's own `-c projects={worktree}` | worktree | **Screen**: the client's copy is ignored | not run |
| main checkout and worktree, one table (the new terms) | worktree | No screen; answered | No screen; answered |
| main checkout and worktree, one table | main checkout | No screen; answered | No screen; answered |
| two separate `-c projects=` (main checkout, then worktree) | main checkout | **Screen**: the second replaced the first | not run |
| two separate `-c projects=` | worktree | No screen; answered | not run |
| main-checkout session: main checkout only (the new terms there) | main checkout | No screen; answered | No screen; answered |

| Terminal `projects=`, TUI in the worktree | 0.169.0 | 0.147.0 |
|---|---|---|
| main checkout only | No screen; answered | not run |
| main checkout and worktree, one table | No screen; answered | No screen; answered |

So a terminal resolves a worktree's trust to the main checkout, but on 0.169.0
the engine checks a client's `-C` folder as given. 0.147.0 does not show the
screen even with the old terms.

Then live in Podium, on the same host and at the fix commit: a real server and
daemon in one process, a scratch home holding only Codex's `auth.json`, a
fresh repository and its worktree, and Codex 0.169.0. A chat-view session
(`codex-app-server`) in each folder was created through `sessions.create`. The
first message was sent from chat, and the web app's CLI tab was opened.

| Session | Engine `projects=` (from `/proc`) | CLI tab (`resume -C <folder> --remote`) | First message | Home edits |
|---|---|---|---|---|
| Worktree | main checkout and worktree | Composer, **no trust screen** | Answered; `podium issue prime` ran | The rules file only (first launch in the fresh home) |
| Main checkout | main checkout only, as before | Composer, no trust screen | Answered; `podium issue prime` ran | None |

## OpenCode 1.18.35

All turns used the default free model (OpenCode Zen, "Big Pickle"), so no
sign-in was needed. Config was passed inline with `OPENCODE_CONFIG_CONTENT`.

| Question | Result |
|---|---|
| Fresh home, fresh folder | Straight to the prompt. No trust prompt, no update or first-run menu; one tip line ("Run /connect to add an AI provider"). The binary was not upgraded by any run (still 1.18.35 afterwards). |
| Default policy for a shell command | `podium --version` ran with no prompt. |
| `{"permission":{"bash":"ask"}}` | "△ Permission required … Allow once / Allow always / Reject". |
| Allow-rule syntax the inline config accepts | **`{"permission":{"bash":{"*":"ask","podium *":"allow"}}}`**: the object form with glob keys. With it, `podium --version` ran with no prompt while every other command still asks. |
| What `--auto` changes | Every rule that would ask is approved (deny rules still hold). With `bash: "ask"` and `--auto`, `podium --version` ran with no prompt. The footer shows `Build auto`; without it, `Build`. |
| Reading a file outside the folder | **Asks by default**: "← Access external directory <dir> … Allow once / Allow always / Reject". So R5 (attachments) is not met by default. |
| Rule for the uploads folder | **`{"permission":{"external_directory":{"<abs dir>/*":"allow"}}}`** (`/**` works too). With it the read ran with no prompt. |

## Grok 1.0.70

| Question | Result |
|---|---|
| Fresh home, not signed in | Device-code sign-in screen. |
| Signed in, fresh folder | Straight to the prompt. **No folder prompt.** A "New /learn skill!" line inside the welcome box; nothing modal. |
| `--allow` grammar | Claude-style rules: `--allow 'Bash(podium *)'`. Measured in the TUI under `--permission-mode default`: `podium --version` ran with no prompt; without the flag it showed a five-row approval menu. Docs (bundled user guide, `14-headless-mode.md`, `22-permissions-and-safety.md`): `Bash(...)` `*` matches any characters including spaces; `Bash(cmd:*)` is prefix matching; path rules `Read(...)` use `*` and `**`; one value may hold several rules separated by commas or by a space after `)`; repeatable; aliases `--allowedTools`, `--allowed-tools`. |
| Does `grok agent stdio` accept `--allow`? | **No.** `grok agent --allow … stdio` → "error: unexpected argument '--allow' found"; `grok agent stdio` has no permission options. The ACP `session/new` `_meta` options are `rules` (system prompt text), `systemPromptOverride`, `agentProfile`, `yoloMode`, `autoMode`. `GROK_CONFIG` is an overlay limited to soft settings: with `{"permission":{"allow":["Bash(podium *)"]}}` in it, the engine still asked. |
| Does its engine ask before running `podium`? | **Yes, in default mode**: `session/request_permission` (kind `execute`, "Execute `podium --version`") reaches the ACP client. With `_meta.autoMode: true` the classifier let `podium --version` run with no request (one run; the docs say a call the classifier will not allow becomes a permission request, or a failure in a non-interactive session). |
| Per-launch allow channel for the engine | **None.** The documented places for an allow rule outside the command line are `~/.grok/config.toml` `[permission] allow = [...]`, a project `.grok/config.toml`, and `.claude/settings.json` (user or project). Grok also reads the user's `~/.claude/settings.json` permission rules. |
| Reading outside the folder | `read_file`, `list_dir` and `grep` are read-only tools that "run without prompting, in every mode" unless a deny rule or hook blocks them (docs). Not measured. |

### The engine's allow rule in the user config (POD-6949, 1.0.70)

Measured over ACP with `grok agent stdio`, one fresh process and session per
run, in scratch homes (`HOME` and `GROK_HOME` both scratch, so no
`~/.claude/settings.json` rules apply; only `auth.json` copied in). "With the
rule": `$GROK_HOME/config.toml` holds exactly what Podium's edit writes into a
missing file, `[permission]` / `allow = ["Bash(podium *)"]`. "Without": no
`config.toml`. The prompt asks the agent to run one command and nothing else;
a permission request is answered with reject. Runs marked *stub* put a
`podium` that only echoes first on `PATH`: the rule and the classifier judge
the command text, and the stub keeps a write-looking verb inert.

| Mode, command | Without the rule | With the rule |
|---|---|---|
| default (`session/set_mode default`), `podium --version` | **asks**: `session/request_permission` "Execute `podium --version`", 3 of 3 | **no ask, ran**: 3 of 3 |
| `_meta.autoMode`, `podium --version` | no ask, ran: 8 of 8 | no ask, ran: 8 of 8 |
| `_meta.autoMode`, `podium issue update --id 1 --stage review` (stub) | no ask, ran: 8 of 8 | no ask, ran: 8 of 8 |
| `_meta.autoMode`, `podium issue delete 1` (stub) | **blocked, no ask**: 7 of 8. The tool call fails with "Auto mode blocked this action (Deleting a remote issue is an irreversible destructive write …)" and the agent stops; one run ran | **ran**: 8 of 8 |
| `_meta.autoMode`, `podium merge-lock steal main` (stub) | blocked (1 of 1) | ran: 3 of 3 |
| `_meta.autoMode`, `podium auth mint-session` (stub) | blocked (1 of 1) | not run |

So the engine reads `[permission] allow` from the user config, and a matching
rule approves the call before the auto-mode classifier sees it, as the docs
say (a command that matches no allow rule "falls through to the mode"). An
unidentified ACP client gets a classifier block as a failed tool call, not a
`session/request_permission`.

A config holding only that table, at first start (TUI, `posture-probe.ts`,
fresh home, signed in): the screen is identical to a home with no
`config.toml` (same welcome box, the "New /learn skill!" line, the prompt;
nothing modal, still signed in). Grok writes the same files in both homes; the
two `config.toml` files then differ only by the `[permission]` table, above
Grok's own first-start keys (`[marketplace]`, `[[marketplace.sources]]`). An
ACP start writes the same keys and keeps the table.

### Folder trust with Podium's hooks (POD-6999)

Found by the acceptance run (POD-6867): Grok 1.0.70 in terminal view asked "Do
you trust the contents of this directory? … Yes, proceed / No, quit". The spike
above saw no prompt because its home held no hooks. The bundled user guide
(`10-hooks.md`) says personal hooks in `~/.grok/hooks/*.json` load only "after
folder trust", and "while you have such a hook, folder trust asks in every
folder but your home directory and filesystem or drive roots". Podium's hook
install writes `$GROK_HOME/hooks/podium.json`. Measured with `posture-probe.ts`,
scratch homes holding only `auth.json` (plus that file where named), fresh
`git init` folders.

| Question | Result |
|---|---|
| 1.0.70, no hooks file | No prompt. |
| 1.0.70, Podium's `hooks/podium.json` | **Prompt.** The cause is the hook file (POD-6867 also removed it from a copy of the acceptance home: no prompt). |
| 1.0.70, hook file plus `--trust` | No prompt. Grok writes `[folders."<repo>"] trusted = true` to `~/.grok/trusted_folders.toml`. |
| `--trust` in `--help` | Not listed (1.0.70, 1.0.5), but accepted. |
| Oldest Grok that takes `--trust` | 1.0.5, the oldest measured, takes it (and records the folder); 1.0.5 rejects an unknown flag ("unexpected argument"), so the flag is real there. 1.0.13 and 1.0.52 take it too. |
| 1.0.52 with the hook file, no flag | No prompt: the gate arrived after 1.0.52. |
| `-p` turn with `--trust` | Accepted (1.0.70, 1.0.13); answered "pong". |
| `grok agent stdio` | Refuses `--trust` ("unexpected argument"), before and after `stdio`. |
| Re-probe with the committed code (posture section's argv), 1.0.70 | No prompt; the launch prompt was answered (`PONG`); hook events SessionStart, UserPromptSubmit, Stop, SessionEnd reached Podium's listener. A "Help improve Grok [Opt out] [Opt in]" notice appears after the first turn; the composer keeps focus. |

## Pi 1.5.0

| Question | Result |
|---|---|
| Fresh home, fresh folder (signed in or not) | **"Trust project folder?"** with "→ Trust" selected, in an empty `git init` folder and in a plain empty folder. (Section 2 of the design saw no prompt in an empty folder on 1.5.2 with an existing home; with a fresh home, 1.5.0 asks every time.) |
| `--approve` | **Removes it**: straight to the prompt. |
| First-run behaviour | Downloads `fd` into `~/.pi/agent/bin/` on first start (a network fetch, not a menu). |
| Update notice | "Update Available: New version 1.5.2 is available. Run pi update". A transcript notice, not modal. `PI_SKIP_VERSION_CHECK=1` removes it. `--offline` (`PI_OFFLINE=1`) also removes it but skips the `fd` download too. |
| Approval gate | None to measure: Pi has no permission prompts (adapter note, unchanged). |

## Cursor Agent 2026.07.23-e383d2b

**Not measured past sign-in; this row is documentation only.** The test host's
Cursor account was signed out: the TUI showed "Press any key to log in...", and
`cursor-agent --print --trust` answered "Authentication required" in the real
home as well as in a fresh one. Three logins were started in scratch homes on a
test host; none was completed before its scratch home expired, and the
coordinator (POD-6858) decided not to start another. Every cell that depends on
what Cursor draws once signed in is marked **unmeasured**.

**Cursor can be measured later**, once a signed-in Cursor login is in place on a
test host: rerun `posture-probe.ts --harness cursor` in a fresh folder with the
login's credentials in a fresh home, with no flags, with `--trust`, and with
`-p --trust`, and fill the unmeasured cells below and in section 4.8 of the
design.

What is known without a session:

| Question | Result |
|---|---|
| Fresh home, fresh folder | "Cursor Agent … Press any key to log in..." |
| Terminal trust prompt (signed in) | **Unmeasured.** |
| `--trust` | Listed by `--help`: "Trust the current workspace without prompting". Whether it also applies to the terminal UI: **unmeasured**. |
| Terminal trust state | A marker file `~/.cursor/projects/<slug>/.workspace-trusted`, seen on disk in the real home. Vendor-private. |
| Allow rule for one launch | None in `--help`. Rules live in `~/.cursor/cli-config.json` (`permissions.allow`, e.g. `Shell(ls)`) or a project `.cursor/cli.json`. The bundle reads `CURSOR_CONFIG_DIR` (else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`) as the config folder; pointing it at a session folder would replace the user's whole config rather than add a rule. **Unmeasured.** |
| `--approve-mcps` | Listed by `--help`: "Automatically approve all MCP servers". |
| Modes | `--auto-review` (server classifier), `-f`/`--force`/`--yolo` (run everything), `--mode plan|ask`, `--sandbox enabled|disabled`. Default `approvalMode` is `allowlist`. |
| First-run and update menus (signed in) | **Unmeasured.** |
| Reading a file outside the folder | **Unmeasured.** |
