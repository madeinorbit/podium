# Google Antigravity integration

Podium hosts Google's native `agy` CLI in a terminal and in headless sessions.
The integration was measured against **1.5.14–1.5.15** on Linux. Podium requires
1.5.14 or newer; an unrecognized future version is reported as unverified.

## Launch and resume

Terminal sessions use Podium's durable PTY host and the stock Antigravity UI.
Models and effort reach the native `--model` and `--effort` flags. A creation
prompt uses `--prompt-interactive=<text>`, preserving multiline and option-like
prompts without submitting a separate permission flag. Subsequent input uses
the terminal driver's transcript-echo receipts. Podium uses the native Escape
key to cancel work or dismiss an approval without quitting the CLI.
First-run appearance, Google consent and workspace-trust screens remain native
and surface as waiting for the person. Podium never accepts Google's terms on
the person's behalf.
Supervised approvals stay in the terminal. The print driver reports an unmet
posture requirement when the requested mode would need interactive approval.

Resume always uses `--conversation <uuid>`. Podium never uses `--continue`,
which can reopen a concurrent session's most recent conversation.

Headless sessions run one durable process per turn with `--input-format
stream-json --output-format stream-json`. Prompts are NDJSON `user` messages
on stdin. `init` and `result` provide the native conversation ID; `step_update`
provides live text and tool activity. Later turns resume the same ID. A missing
result, error status, cancellation or `finished_reason` is an incomplete turn,
even if the process exits zero. The known ID survives failures for recovery.

Google also ships `agy acp`. Podium currently uses the verified print protocol
for headless sessions; it does not advertise an Antigravity ACP driver or an
attachable native client for that server.

## Instructions, tools and lifecycle

Each session has a private customization workspace, added with `--add-dir`.
Its `AGENTS.md` carries Podium's instructions, `.agents/mcp_config.json` mounts
MCP servers, and `.agents/hooks.json` forwards native lifecycle events. This
uses Antigravity's own discovery rather than changing the repository or the
person's global configuration. The native initial workspace-trust confirmation
remains visible in the terminal. Native command approval dialogs surface as
waiting for the person while permission decisions remain in Antigravity.

Hooks cover `SessionStart`, `PreInvocation`, `PostInvocation`, `PreToolUse`,
`PostToolUse` and `Stop`. They return `decision: allow`, which delegates to the
native permission policy; they never auto-approve a tool. The callback is
bounded and hooks remain neutral when the daemon or curl is unavailable.
`Stop` completes a turn only with `fullyIdle: true` and no active continuation.
Late bookkeeping does not restart a completed turn. A subagent's different
conversation ID cannot rebind the parent session.
The measured CLI omits `Stop` on Escape cancellation, so Podium also recognizes
its native interruption notice together with the idle composer footer.

Current `agy` forwards the session hook environment. Older claims in this
reference that all custom environment variables were removed, that JSON output
was unavailable, or that print mode omitted the conversation ID are obsolete.

## Google credentials

Settings → Credentials → Add subscription offers **Google AI subscription**.
Podium runs `agy acp --login` in a home for that credential. Google's own OAuth
flow handles Free, Pro, Ultra and eligible enterprise accounts. The person opens
the Google link and pastes its authorization code into the terminal. Credentials
stay on the machine; Podium publishes identity metadata and a fingerprint.

Native account detection reads the CLI token file or its OS keyring entry
(service `gemini`, account `antigravity`). The file is
`~/.gemini/antigravity-cli/antigravity-oauth-token`. Linux keyring reads use
`secret-tool` when available; macOS uses Keychain and Windows uses CredReadW.
Windows and macOS secure-store paths have not been exercised on the Linux
verification host. Keyring failures remain unknown when no native file exists.
An expired access token remains usable when the CLI can refresh it.

`PODIUM_ANTIGRAVITY_HOME` is Podium's selector, not an upstream environment
variable. Every account command translates it to `--gemini_dir` plus
`--app_data_dir antigravity-cli`. Changing the directory alone still reaches
the shared OS keyring. For isolated homes, Podium selects the CLI's native
remote-auth path with a child-scoped `SSH_CONNECTION` marker (preserving an
existing SSH connection), so its refreshable token is stored in that home.
The marker never changes the operator's shell environment. Named accounts use
the same isolation. Automatic Google token propagation is disabled.

A Google home inherits the person's rules, skills, plugins, hooks and MCP
configuration. Its Google login, projects, conversations and model-provider
settings stay separate. Only common appearance and editor preferences seed
its own CLI settings.

Gemini API keys are also supported in credential management. Delivery sets
`GEMINI_API_KEY` and selects `modelProvider: gemini` with one `--settings` value.
Inherited Google keys and ADC selectors are stripped. Repeating `--settings`
**replaces** its previous value in the measured CLI, so permission posture must
not add a second value that silently changes authentication.

## History, models and usage

History reads one native JSONL file per conversation, preferring
`brain/<uuid>/.system_generated/logs/transcript_full.jsonl` over its truncated
sibling. The read-only `conversation_summaries.db` index supplies native titles,
workspace URIs and parent identities. Older stores without that index retain
transcript-based titles. Malformed lines produce diagnostics beside the good
records. Podium never guesses a new session's identity from the newest sibling
in a working directory.

User messages unwrap only `<USER_REQUEST>`; internal metadata is excluded.
Assistant text, tool calls and results map to Podium's chat items. Native
transcript model names and token counts feed runtime identity and usage
accounting. The model picker enumerates `agy models`; no subscription-specific
model catalog is hard-coded. The measured subcommand still rejects
`--output-format`, so its text output is parsed.

Cross-machine conversation handoff, cloud migration and an all-tools-off mode
are not advertised: their required contracts have not been verified.

## Google plan quota and credits

Quota reads use the selected installation's native `--print /usage
--output-format json` and `/credits` commands. Podium accepts only successful
structured command reports with zero model turns. Google owns authentication,
token refresh and the quota service contract; Podium does not embed an OAuth
client secret or depend on a private quota endpoint.

Native groups become independent model-family pools, each with its five-hour
and weekly limits and exact reset time. Spending Gemini's allowance does not
make a usable Claude/GPT pool look unavailable. Unknown groups remain visible;
missing or invalid readings never become unused capacity. AI credits are a
separate account balance, shown once across its pools. Accounts without credits
retain their measured plan windows. Gemini API-key usage is not a Google plan
allowance and has no subscription quota reading.
The web panel, phone Pulse screen and `podium quota` show these readings;
`podium quota --json` preserves the complete quota payload.

The default login and every managed Google home use their own account scope
and the inventory's pinned executable. Polls run in a private workspace with
an empty customization root. A directory link (a junction on Windows) keeps
native state at its existing location, so the CLI can refresh the real token
store without copying credentials. This prevents the CLI from starting global
MCP servers, plugins or hooks for a quota read. Session-only settings disable
status/title commands and ensure the fixed slash commands run as commands.
Browser launchers are suppressed; background polling cannot start sign-in.
Timeouts, bounded output and probe-owned process cleanup prevent hung reads.

Live readings use the existing quota cache, manual refresh, account grouping
and quota-history sampling. Native historical quota backfill is unavailable;
Podium records samples from the first successful read onward.

## Verification and upstream references

Adapter tests cover launch isolation, explicit resume, credential freshness,
structured completion and failures, native JSONL/SQLite history, malformed
records, tool questions and late hooks. A process test checks neutral hook
responses with curl missing and the daemon unreachable. Real CLI probes use
local Gemini and MCP stubs and no paid model requests.
Real quota probes also exercise two isolated Google profiles, an expired
access token refreshed by the native CLI, distinct credit balances and no
MCP startup. Fixtures contain synthetic accounts only. Secure-store and
junction behavior on Windows and macOS still require platform verification.

- [CLI reference](https://antigravity.google/docs/cli/reference)
- [Headless protocol](https://antigravity.google/docs/cli/headless/)
- [Authentication](https://antigravity.google/docs/install?tab=cli)
- [Lifecycle hooks](https://antigravity.google/docs/hooks/)
- [MCP configuration](https://antigravity.google/docs/mcp)
- [Native usage command](https://antigravity.google/docs/cli/commands/usage/)
- [Native AI credits](https://antigravity.google/docs/cli/credits/)
