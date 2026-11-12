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
