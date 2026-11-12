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
