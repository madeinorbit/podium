# Managed accounts & per-agent environments

Design doc + feasibility findings for issue #212 (epic #211). Builds on the
accounts foundation shipped in [spec:SP-6454] (main `87df9a7`).

**Verdict:** yes to both questions. Managed logins work today with no
reverse-engineering — proven by spike below. And "managed login" is genuinely
just one field of a larger **Environment** object; the two should ship as one
abstraction.

---

## Part 0 — Feasibility spike (executed 2026-07-09, this machine)

Everything below was run against the real CLIs (`claude` 2.1.205, `codex`
current) and a real Claude **Max** subscription account. Credential copies were
shredded afterwards; the live login is intact.

| # | Question | Result |
|---|---|---|
| 1 | Does `CLAUDE_CONFIG_DIR` isolate auth? | **Yes.** Empty dir → `Not logged in · Please run /login`. It relocates `.credentials.json`, `.claude.json`, `projects/`, `sessions/`, `backups/`. |
| 2 | Can we authenticate a *subscription* account by injecting a credential file alone? | **Yes.** Writing only `{"claudeAiOauth": {...}}` into `$CLAUDE_CONFIG_DIR/.credentials.json` → `claude -p` answered normally. No interactive login, no OAuth client, no undocumented endpoint. |
| 3 | Is more than the credential blob needed? | **No.** The CLI fetched and backfilled `oauthAccount` (email, plan, org) into the isolated `.claude.json` itself, and rewrote `.credentials.json` to add `scopes`. |
| 4 | Same credential, two isolated dirs, concurrently? | **Yes**, both worked (while the access token was unexpired). |
| 5 | `CODEX_HOME` isolation + injection? | **Yes.** Empty → `Not logged in`. Copy `auth.json` → `Logged in using ChatGPT`, `codex exec` completed a real turn. |
| 6 | Codex gotcha | Codex **refuses to create helper binaries under `/tmp`**. Managed homes must live somewhere durable, e.g. `~/.podium/accounts/<id>/`. |

The credential shapes:

```
~/.claude/.credentials.json  →  claudeAiOauth { accessToken, refreshToken,
                                  expiresAt, refreshTokenExpiresAt,
                                  scopes, subscriptionType, rateLimitTier }
~/.codex/auth.json           →  { auth_mode, OPENAI_API_KEY|null, last_refresh,
                                  tokens { id_token, access_token,
                                           refresh_token, account_id } }
```
Codex's `id_token` is a plain JWT: `iss=https://auth.openai.com`,
`aud=app_EMoamEEZ73f0CkXaXp7hrann`, with `chatgpt_plan_type` and
`chatgpt_account_id` claims. Podium already decodes this read-only in
`apps/server/src/codex-auth.ts`.

### The key insight

**Podium never needs to be an OAuth client.** We are a *credential courier*: we
hold the blob the CLI produced, hand it to a CLI on some machine, and let that
CLI perform its own refresh. No client_id, no token endpoint, no PKCE, nothing
undocumented. This sidesteps the entire ToS/reverse-engineering question that
"drive the OAuth flow headlessly" would have raised.

---

## Part 1 — The four managed-credential mechanisms

Ranked by operational safety. **M1/M2 are the primary path; M3 is advanced.**

### M1 — API key via env  *(trivial, ship first)*
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Already stored in
`settings.apiKeys`; just needs to reach the daemon's spawn env. Fully supported,
no rotation hazard, no state on disk. Billing is per-token, not subscription.

### M2 — Long-lived OAuth token via env  *(the sweet spot for Claude)*
`claude setup-token` is an **official, documented** command: *"Set up a
long-lived authentication token (requires Claude subscription)."* It emits a
~1-year token consumed as `CLAUDE_CODE_OAUTH_TOKEN`.

Why this is the best managed path for Claude:
- It is **not refreshed by the CLI** → no refresh-token rotation race (see §3).
- It **does not relocate `CLAUDE_CONFIG_DIR`** → Podium's transcript discovery,
  resume, and `~/.claude/projects` scanning keep working untouched.
- It fans out to N machines and N concurrent agents with zero coordination.
- Subscription billing (Pro/Max/Team/Enterprise).

Acquisition is one interactive step, once, on any machine with a browser.
Podium can drive it in a PTY — it already is a terminal multiplexer.

**Codex has no equivalent.** `codex login --with-access-token` (stdin) takes a
*short-lived* access token, not a durable one. So Codex subscription accounts
must use M3.

### M3 — Credential-directory provisioning  *(full managed OAuth)*
Server holds the blob; daemon materializes
`~/.podium/accounts/<accountId>/claude/.credentials.json` (mode `0600`, dir
`0700`) or `.../codex/auth.json`, and spawns with `CLAUDE_CONFIG_DIR` /
`CODEX_HOME` pointed there. Proven in spike rows 2/5.

This is what unlocks *"connect a ChatGPT/Claude subscription once on the server,
run it on any daemon."* It carries two real costs — §3 (rotation) and §4
(transcript relocation).

### M4 — Credential callback CLI  *(deferred, but the strategic endpoint)*
Rather than the daemon persisting anything, it asks the server for a fresh
credential per operation. Two harness-native hooks already expect exactly this
shape:
- Claude's `apiKeyHelper` — a command that prints a credential, re-invoked every
  5 min or on HTTP 401 (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`).
- git's `credential.helper` — which is how **#214** proposes to deliver GitHub
  tokens.

So `podium credential <accountId>` is one CLI serving both. It gives expiry,
rotation, revocation and multi-account for free, and the daemon stores zero
secrets on disk. It does **not** help the OAuth-subscription case (helper output
is an API key or bearer, not the `claudeAiOauth` blob).

**#214's finding promotes this from "nice later" to "required for one credential
class."** GitHub App refresh tokens are single-use and rotating, and — the nasty
part — *a refresh silently invalidates every access token already handed out*
(GitHub: "Once you use a refresh token, that refresh token **and the old user
access token** will no longer work"). Access tokens live 8h. So a GitHub token
injected into a long-running agent's env doesn't merely go stale on a timer; it
dies the instant the server refreshes for any reason, and `git push` fails
mid-session with a bare 403.

That generalizes into the rule that decides env-injection vs callback:

| Credential | Lifetime | Dies mid-session? | Env injection OK? |
|---|---|---|---|
| Provider API key | indefinite | no | yes |
| `CLAUDE_CODE_OAUTH_TOKEN` | ~1 yr | no | yes |
| `claudeAiOauth` blob (M3) | CLI-refreshed in place | no (CLI owns the file) | n/a — it's a file, not env |
| GitHub user access token | 8 h, **invalidated early by any refresh** | **yes** | first cut only |

**Env injection is sound for long-lived credentials and is a latent mid-session
failure for short-lived ones.** Phase 1 stays a valid first cut for GitHub only
because it mints a fresh token per spawn and closes a hole that exists today
(#215) — but the callback CLI is the destination, and it should be pulled
earlier than "someday" on #214's account. It is not on the critical path for
Anthropic, whose managed credentials are all long-lived by construction.

---

## Part 2 — Acquisition: how a credential reaches the server

The user must log in once, somewhere. Three flows, all avoiding OAuth internals:

1. **Paste** — user runs `claude setup-token` anywhere, pastes the token into
   Podium's Accounts hub. Dumbest, works today, zero new machinery. **Ship this
   first.**
2. **PTY-driven login** — Podium spawns `claude /login`, `claude setup-token` or
   `codex login` in a PTY on a chosen machine and shows it in the existing web
   terminal. The user completes the browser step; the daemon then reads the
   resulting credential file and uploads it. Both CLIs already fall back to a
   paste-the-code flow when the loopback callback is unreachable (the SSH /
   container case), which is exactly our case.
3. **Loopback relay** (nice-to-have) — proxy the CLI's `localhost:1455` callback
   out through the daemon WS so the user's remote browser can complete the
   redirect. Removes the paste step. Pure plumbing, no OAuth knowledge.

Import of an *existing* native login is a special case of (2): the daemon
already knows how to read the file, so "Adopt this native login as a managed
account" is a single button.

---

## Part 3 — The hard problem: refresh-token rotation

This is the one thing that can silently corrupt a user's login, and the
codebase already knows it. `apps/server/src/codex-auth.ts` deliberately never
refreshes, with the comment that OAuth refresh tokens are **single-use** and a
racing refresher would wedge the login (openai/codex#10332). Claude's blob has
the same shape (`refreshToken` + `refreshTokenExpiresAt`).

**Consequence:** if two machines hold the same OAuth blob and both CLIs decide
to refresh, the first rotation invalidates the other's refresh token. The loser
wedges and needs a re-login. The spike's row 4 (two dirs, same creds, both
worked) is *not* a counterexample — the access token was still valid, so neither
side refreshed.

Design response, in order of preference:

- **Prefer non-refreshing credentials.** M1 and M2 have no refresh token at all.
  This is the single strongest argument for making M2 the default Claude path
  and pushing M3 to "advanced / Codex-only".
- **Single-holder lease for M3.** The server grants an OAuth account to exactly
  one machine at a time (lease with TTL + heartbeat). Moving the account to
  another machine revokes and re-seeds. Simple, correct, and matches the actual
  use case (one human, one active machine at a time).
- **Write-back with compare-and-swap.** The daemon watches the materialized
  credential file; when the CLI refreshes it in place, the daemon pushes
  `{accountId, version, blob}` upstream and the server accepts only if `version`
  matches (CAS). This keeps the vault authoritative and makes lease handoff
  self-healing. Without it, the server's copy goes stale the first time the CLI
  refreshes, and a later re-seed would *downgrade* a machine to a dead token.

Write-back is mandatory for M3 — not optional. A read-only vault would actively
break logins.

---

## Part 4 — The hidden cost of `CLAUDE_CONFIG_DIR`

`CLAUDE_CONFIG_DIR` relocates **`projects/` and `sessions/`**, not just
credentials. Podium's transcript loading is disk-truth: it discovers and tails
`~/.claude/projects/<cwd-bucket>/<uuid>.jsonl`, and Claude's `--resume` is
cwd-bucket-scoped.

So adopting M3 for Claude means the discovery scanner and transcript reader must
learn about **per-account roots**, not just `~/.claude`. That is a real chunk of
work touching the daemon's worker-thread discovery indexer and the transcript
read/subscribe path.

**Recommendation:** scope the config dir **per account, not per session** (so
transcripts are stable across a session's lifetime), and treat "teach discovery
about multiple roots" as an explicit prerequisite sub-issue for M3. M1/M2 dodge
this entirely — another reason to lead with them.

---

## Part 4.5 — Not every credential is role-scoped (from #214)

`resolveRole()` binds **one account per role** (coding / superagent / background).
That is right for LLM credentials — a role picks its backend. It is wrong for
GitHub, which is not an LLM, is not role-scoped, and must be injected into
*every* spawn (and into `runRepoOp`, which today shells out `gh` with no env at
all — see `apps/daemon/src/repo-op.ts:121`).

So the Account model needs two classes:

```ts
Account {
  …
  scope: 'role' | 'ambient'   // ambient = injected into every spawn
}
```

- **role-scoped** — anthropic / openai / openrouter / xai / google. Selected by
  `resolveRole()`, at most one active per role.
- **ambient** — GitHub today; plausibly npm, Docker registries, cloud CLIs later.
  All enabled ambient accounts contribute env to every spawn. Collision on an env
  var name is a config error, surfaced, not last-write-wins.

This also forces the provider enum open. `AccountProvider` is currently LLM-only
(`packages/core/src/settings.ts:116`). Split it:

```ts
LlmProvider        = 'anthropic'|'openai'|'openrouter'|'xai'|'google'
CredentialProvider = LlmProvider | 'github' | …
```

`RoleBackend.accountId` keeps pointing at an `LlmProvider` account; the ambient
set is provider-agnostic. **#214's GitHub work is tenant #1 of this model, not a
parallel path** — and its spike (server-held token + three env vars → private
clone, authenticated push, working `gh`, zero files written to disk) is
independent confirmation that the `SpawnMessage.env` seam in Phase 1 is
sufficient. Phase 1 should therefore land the generic `env` field, not an
Anthropic-shaped one.

## Part 5 — Environment: the unifying abstraction

Managed login is one facet. Every knob the user named — env vars, mode, plugins,
hooks, system prompt, model/effort — is already a `claude` flag today:

```
--permission-mode {acceptEdits,auto,bypassPermissions,manual,dontAsk,plan}
--settings <file-or-json>      (env block, hooks, permissions)
--append-system-prompt / --system-prompt
--plugin-dir <path> (repeatable) / --plugin-url <url>
--mcp-config <configs...> / --strict-mcp-config
--model / --effort / --agents <json>
--allowedTools / --disallowedTools / --tools / --add-dir
--setting-sources user,project,local
```

So an Environment is a **declarative spawn spec** that each harness adapter
*renders* into argv + env.

```ts
Environment {
  id, name
  accountId?        // ← managed login is just this field
  harness?          // claude-code | codex | grok | ...
  model?, effort?
  permissionMode?
  env: Record<string, string>
  secretRefs: string[]        // vault ids → materialized as env at spawn
  systemPromptAppend?: string
  plugins?: Array<{ dir: string } | { url: string }>
  mcpServers?: McpConfig
  hooks?: HookConfig
  allowedTools?, disallowedTools?, addDirs?
  settingsJson?               // escape hatch, merged into --settings
  settingSources?             // isolation: ignore user/project settings
}
```

### Resolution layering

Extend the existing single read path rather than adding a parallel one:

```
DEFAULTS  ←  roles[role]  ←  environment  ←  per-session override
                                   ↓
                          resolveSpawnSpec()  →  SpawnSpec
```

`resolveRole()` already collapses (account, model, effort) into a
`ResolvedRole`. `resolveSpawnSpec(settings, role, environmentId, overrides)`
is its natural superset, returning a `SpawnSpec` whose `credential` is a
**reference** (`accountId`), never a secret.

### Capability matrix, not silent drop

Codex has no `--append-system-prompt` (the adapter prepends to the prompt
instead); grok has no `--settings`. Follow the existing `HARNESS_MCP_SUPPORT` /
`AGENT_CAPABILITIES` pattern: each adapter declares what it can render, and
unsupported fields surface as a **visible notice**, never a silent no-op. This
is the same rule the superagent already follows when a harness can't mount MCP.

---

## Part 6 — Server → daemon architecture

Today: the spawn frame carries **no env**, and there is **no config-push
channel**. The server resolves everything into concrete argv per spawn. Two
additive changes, both backward compatible (protocol zod objects are non-strict;
optional fields are the established additive convention, no `WIRE_VERSION` bump).

```
        ┌── server ────────────────────────────────┐
        │ vault (encrypted blobs, versioned)       │
        │ environments table                       │
        │ entitlements: machine × account          │
        └──────────────┬───────────────────────────┘
                       │ on helloOk + on settings.changed
                       │   ← NEW control frames →
                       │  accountsSync { accounts[] }        (server→daemon)
                       │  environmentsSync { environments[] }
                       │  credentialUpdated { accountId, version, blob }
                       │                                     (daemon→server, CAS)
        ┌──────────────▼───────────────────────────┐
        │ daemon                                   │
        │  materializer → ~/.podium/accounts/<id>/ │  0700 / 0600
        │  watcher      → fs.watch → write-back    │
        │  spawn: SpawnMessage { …, environmentId?, accountId? }
        │         → adapter renders argv + env     │
        └──────────────────────────────────────────┘
```

### Machine state vs Environment: two scopes, one channel (with #213 / #234)

#213 proposes the daemon become a **convergence engine**: the server holds a
per-machine `desiredState` (which harnesses, which tool versions, pinned or
floating), the daemon reconciles on connect + timer + push, and reports actual
state back via an `inventory` field on pair/hello (#222). They ask whether that
document and this one's Environment are the same object.

**They are not the same object, and collapsing them would be a mistake** — the
scopes differ:

- **MachineState** is *per machine*, and describes what is **installed**:
  `harnesses[]`, `tools[]`, version pins, plus which accounts this machine is
  entitled to. Reconciled continuously. Cardinality: one per daemon.
- **Environment** is *per spawn*, and describes how one agent **runs**: account,
  model, effort, permission mode, plugins, env, hooks. Resolved at spawn.
  Cardinality: many, and freely reassignable without touching a machine.

The relationship is a **contract, not an inheritance**: an Environment *declares
requirements* (`harness: 'codex'`, `plugins: [...]`); MachineState *satisfies*
them; `inventory` *verifies*. That gives us something neither issue gets alone —
the server can refuse to schedule an Environment onto a machine that lacks its
harness, instead of the current behavior, where `abduco` silently hides a missing
binary (#219).

What they **should** share, and what I'm signing up for:

1. **One transport.** `accountsSync` / `environmentsSync` / `machineStateSync`
   are the same push-on-`helloOk`-and-on-change control frame family, not three
   bespoke mechanisms. #234 and Phase 3 are one piece of work.
2. **One reconcile loop** in the daemon, with credentials as one reconciler among
   several (harnesses, tools, creds, environments).
3. **`inventory` (#222) is a prerequisite for credential push**, exactly as #213
   suspected. The server cannot decide which credentials a machine needs without
   knowing which harnesses it has. Entitlement (Part 7) is machine × account;
   inventory is what makes that decidable rather than guessed.

### Machine env is a layer in the spawn env

#213 surfaced that several agent CLIs self-update in place and will fight any
version pin: `DISABLE_AUTOUPDATER=1` (+ `DISABLE_INSTALLATION_CHECKS=1`) for
claude, `OPENCODE_DISABLE_AUTOUPDATE=1` for opencode; codex doesn't auto-update;
cursor-agent has no clean opt-out. Those vars must reach the **spawned agent's**
env — `daemon.ts:1357`, the seam this issue owns.

So they are not a special case. They are a **machine-level contribution to the
spawn env**, and the layering in Part 5 extends by one:

```
DEFAULTS ← machine env (version pins, tool paths — from MachineState)
         ← role account env
         ← ambient account env  (GitHub, …)
         ← environment env
         ← per-session override
```

One merge, one precedence order, one place a user can see why a variable has the
value it has. Not two mechanisms.

### Why a sync channel

Rather than stuffing secrets into every spawn frame:
- secrets stop riding the wire on every session create;
- a **fresh daemon install pulls its environment on `helloOk` and is ready** —
  which is the stated requirement, and is impossible with a per-spawn-only model;
- write-back needs an upstream frame anyway.

Concrete seams (all identified, all narrow):

| Concern | Site |
|---|---|
| spawn frame schema | `packages/protocol/src/messages.ts:1197` (`SpawnMessage`) |
| control union | `packages/protocol/src/messages.ts:1617` |
| server spawn payload | `apps/server/src/modules/sessions/service.ts:1350` |
| **env injection point** | `apps/daemon/src/daemon.ts:1357-1370` (`spawnOpts.env`) |
| argv render | `packages/agent-bridge/src/harness/adapters/*.ts` |
| settings-changed bus (forward to daemons) | `apps/server/src/modules/settings/service.ts` |
| machine routing / push | `apps/server/src/modules/machines/service.ts:98` (`toMachine`) |
| accounts router (extend) | `apps/server/src/router.ts:700` |
| new tables | `apps/server/src/migrations/010-*.ts` (current version 9) |

One correctness catch: a **resumed session must get the same account it started
with** (transcript location and rate-limit identity both depend on it). So
`sessions` needs an `account_id` / `environment_id` column, and the
reattach/resurrect paths must re-inject the identical env.

---

## Part 7 — Security posture

Podium currently stores API keys **plaintext** in SQLite, justified in
`settings.ts` as "same trust domain as the shell the agents already run in."
That reasoning holds for a single-user self-host. It **stops holding** once the
server vaults a credential and pushes it to *other* machines: the blast radius
of the DB file now includes the user's Claude Max and ChatGPT logins.

**When encryption becomes mandatory** is a function of *what class of secret*
lands in the DB, not of which phase we're in. #214 argues it is a prerequisite,
and that is right for their credential but not for all of Phase 1. The line:

| Secret | Encryption before storing? |
|---|---|
| Provider API key (`sk-ant-…`, `sk-…`) | No regression — already plaintext in `settings.apiKeys`. |
| `CLAUDE_CODE_OAUTH_TOKEN` (long-lived, revocable, no refresh) | Should, and cheap to do. |
| OAuth blob w/ refresh token (Claude, Codex) | **Yes — blocking.** |
| GitHub user access token + refresh token (#214) | **Yes — blocking.** |

A stolen `podium.db` today leaks metered API keys the user can rotate in a
console. Once it leaks a GitHub refresh token or a Claude Max OAuth blob, it
leaks durable identity. So: **encryption gates the refresh-token-bearing
credentials, and #214 and Phase 5 both sit behind it.** It does not need to gate
the API-key slice of Phase 1, which is why the plan below keeps them separable.

Minimum bar:

- **Encryption at rest.** AES-256-GCM per blob, key from `PODIUM_MASTER_KEY`
  (env or a `0600` file outside the DB). This would be Podium's first at-rest
  encryption primitive — there is nothing to build on today. Owned here, since
  #212 and #214 both need it and neither should build it twice.
- **Redaction.** Credential blobs must never hit logs; the protocol logger needs
  an explicit redaction list. (Blobs currently would flow through the same WS
  logging path as everything else.)
- **Entitlement, opt-in.** Pairing a machine must *not* implicitly grant it
  every account. Machine × account is an explicit grant. Otherwise a pairing
  code becomes a Claude-Max-token bearer token.
- **Filesystem.** `0700` dirs, `0600` files, under `~/.podium`, never `/tmp`
  (also a hard codex requirement).
- **Be honest about the ceiling.** An agent with a Bash tool can read its own
  `CLAUDE_CONFIG_DIR` and exfiltrate the token. This is equally true of native
  logins today. Managed accounts do not make an untrusted agent safe; they make
  a *trusted* agent portable.

### ToS — read this before building rotation

Anthropic's consumer terms are explicit:

> "You may not share your Account login information, Anthropic API key, or
> Account credentials with anyone else or make your Account available to anyone
> else."

and prohibit accessing the Services "through automated or non-human means"
except via an API key or where explicitly permitted — Claude Code on Pro/Max
*is* explicitly permitted.

Reading that against this feature:

- **One human, many of their own machines → fine.** This is the actual use case.
  The credential never leaves its owner.
- **A team sharing one subscription through Podium → prohibited.** Podium must
  not become an account-sharing tool. The multi-user/hub deployment mode needs
  per-user accounts, not a shared vault. #213 reaches the same place from the
  security side: a subscription OAuth token carries the user's *entire* plan
  quota, is not scopable, and is not cheaply revocable — whereas an API key is
  scoped, metered and revocable in a console. **For any multi-tenant deployment,
  API keys are the only defensible choice**, and managed subscription OAuth
  should be a single-user-self-host feature. Worth recording as a spec decision.
- **One human, several accounts they bought, rotated for capacity → not
  prohibited by anything I can find.** This deserves stating carefully, because
  it is easy to get wrong (an earlier draft of this doc did). The relevant
  clauses:
  - The consumer terms contain **no clause limiting how many accounts an
    individual may hold**. Their defined "Technical Limitation" is the rate limit
    itself ("the number of Inputs you may submit … within a certain period of
    time"), with no anti-circumvention language attached to it.
  - The usage policy's two multiple-account clauses are both scoped to conduct
    that does not apply here: *"Coordinate **malicious activity** across multiple
    accounts to avoid detection…"* and *"Circumvent **a ban** through the use of
    a different account…"*.
  - The sharing clause quoted above is about **other people**, not about one
    person's own accounts.

  What remains is **enforcement discretion, not a clause violation**. Anthropic
  reserves the right to limit usage "in other ways … at their discretion," and
  the weekly caps were introduced in response to credential *sharing and
  reselling*. A single user with N paid subscriptions is paying N times; the
  residual risk is that an account-level heuristic mistakes the pattern for
  sharing. That is a business risk for the user to accept, not a line for Podium
  to draw on their behalf.

So the product decision is **not** "is rotation legal" (it appears to be). It is
how much rope to hand the user, and how loudly to explain the residual risk. The
options are a manual selector; a manual selector plus 429 failover; or a full
auto-rotating pool. All three are technically identical work.

The one firm line is the multi-user hub: a shared vault behind several humans is
prohibited outright, regardless of rotation, and is independently ruled out on
security grounds below.

That is a product decision, not a technical one, so it is flagged rather than
assumed. Everything else in this doc is unaffected by which way it goes.

---

## Part 8 — Implementation plan

Sliced so each phase is independently shippable and the risky part comes last.

**Phase 1 — Managed env credentials (M1 + M2) + the generic `env` seam.** No cred
dirs; no rotation risk; no transcript impact. **Shared with #214** — build the
seam once.
- `Account` gains a persisted store + `credential`, `scope: 'role'|'ambient'`,
  and a widened `CredentialProvider` (Part 4.5).
- `SpawnMessage.env?: Record<string,string>` — **generic, not Anthropic-shaped**.
  Server populates it from the resolved role account *plus* every enabled ambient
  account. Additive optional field; no `WIRE_VERSION` bump.
- Daemon maps it into `spawnOpts.env` at `daemon.ts:1357`, and — for #214 — into
  `runRepoOp`, which currently passes no env at all (`repo-op.ts:121`).
- Accounts hub: paste an `ANTHROPIC_API_KEY` or a `setup-token` result; drop
  "Coming soon" for these two.
- Session row records `account_id`; reattach/resurrect re-inject identically.
- *Delivers:* "connect an account once on the server, any daemon runs on it."

**Phase 1.5 — At-rest encryption + redaction.** AES-256-GCM, `PODIUM_MASTER_KEY`,
credential redaction in the protocol logger. **Gates #214 and Phase 5**, not the
API-key slice of Phase 1 (Part 7 table). Pulled early because two issues need it
and neither should build it twice.

**Phase 2 — Environment object.** The bundle, minus credentials (which Phase 1
already resolved).
- `environments` table + tRPC router + `resolveSpawnSpec()`.
- Adapter capability matrix + render; visible notice on unsupported fields.
- `SpawnMessage.environmentId?`; server resolves, sends the rendered spec.
- UI: named environments, assignable per agent / per role / per issue.

**Phase 2.5 — `podium credential <accountId>` callback CLI.** Backs git's
`credential.helper` and Claude's `apiKeyHelper` from one command; the daemon
persists nothing. Required for short-lived credentials (GitHub's 8h access
token, which any server-side refresh kills early — see Part 1 M4). Not on the
critical path for Anthropic. Pulled ahead of Phase 3 at #214's request.

**Phase 3 — Sync channel + fresh-daemon bootstrap. Merged with #234.**
- `accountsSync` / `environmentsSync` / `machineStateSync` as one control-frame
  family pushed on `helloOk` and on change, feeding **one** daemon reconcile loop.
- Machine × account entitlement grants, decidable only once **#222** (`inventory`
  on pair/hello) lands — so #222 is a hard prerequisite, not a nice-to-have.
- Machine env layer (autoupdater pins) merges into spawn env.
- *Delivers:* the stated "fresh daemon install pulls its environment and is
  ready", and #213's convergence engine, as one thing.

**Phase 4 — *(folded into Phase 1.5)*.**

**Phase 5 — M3 managed OAuth (Codex first).** Gated on Phase 1.5.
- Materializer + fs watcher + CAS write-back.
- Single-holder lease.
- Codex first because it *has* no M2 alternative, and because `CODEX_HOME`
  does not disturb Podium's transcript discovery the way `CLAUDE_CONFIG_DIR`
  does.

**Phase 6 — M3 for Claude.** Gated on teaching the discovery scanner and
transcript reader about per-account roots (Part 4). Only worth doing if M2
proves insufficient in practice.

**Phase 7 — PTY-driven login + loopback relay.** Quality-of-life on acquisition;
independent of everything above.

### Recommended first cut
Phases 1 + 2, with 1.5 immediately behind them. Together 1 + 2 deliver the whole
user-visible promise — *"define a named environment with an account, mode, model,
plugins, and env vars, and point any agent at it"* — with zero rotation risk and
zero transcript churn. Phase 1.5 unblocks both #214 and managed OAuth. Phases 3,
5, 6, 7 are where the remaining hard problems live, and each one is separable.

### Cross-issue ownership
- **#212 (here)** owns: the Account model (`scope`, `CredentialProvider`), the
  generic `SpawnMessage.env` seam, the credential store, Phase 1.5 encryption,
  and the Environment object.
- **#214** owns: which GitHub credential to hold, the device-flow connect UX, and
  the git/`gh` env mapping. It consumes this model as ambient tenant #1.
- **#213** (fresh-machine bootstrap) consumes Phase 3's `accountsSync` /
  `environmentsSync` frames — that *is* the "fresh daemon pulls its environment"
  mechanism.
