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

### M4 — `apiKeyHelper`  *(deferred)*
Claude settings support a command that prints a credential, re-invoked every 5
min or on HTTP 401 (`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`). A `podium creds fetch
<accountId>` helper would let the daemon pull short-lived creds just-in-time
instead of persisting them. Elegant for the API-key case; doesn't help OAuth
subscription (helper output is an API key/bearer, not the OAuth blob). Worth
revisiting; not in the first cut.

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

Why a **sync channel** rather than stuffing secrets into every spawn frame:
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

Minimum bar for shipping managed OAuth:

- **Encryption at rest.** AES-256-GCM per blob, key from `PODIUM_MASTER_KEY`
  (env or a `0600` file outside the DB). This would be Podium's first at-rest
  encryption primitive — there is nothing to build on today.
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
  per-user accounts, not a shared vault.
- **Rotating across multiple subscription accounts to extend rate limits →
  don't build this.** Anthropic has publicly framed exactly this behavior
  (credential sharing across teams, reselling access) as the abuse that the
  weekly caps exist to stop. "Rotate between multiple accounts" should mean
  *"I have a personal and a work account, let me pick per agent"* — a **manual,
  explicit selector**, plus at most an automatic **failover on 429 to another
  account the same human owns**. It should not mean round-robin quota farming,
  and the UI should not present it that way.

That is a product decision, not a technical one, so it is flagged rather than
assumed. Everything else in this doc is unaffected by which way it goes.

---

## Part 8 — Implementation plan

Sliced so each phase is independently shippable and the risky part comes last.

**Phase 1 — Managed env credentials (M1 + M2).** No new tables beyond the
account store; no cred dirs; no rotation risk; no transcript impact.
- `Account` gains a persisted store + `credential` (encrypted) — the slot
  `settings.ts` already reserves.
- `SpawnMessage.env?: Record<string,string>`, populated by the server from the
  resolved account.
- Daemon maps it into `spawnOpts.env` at `daemon.ts:1357`.
- Accounts hub: paste an `ANTHROPIC_API_KEY` or a `setup-token` result; drop
  "Coming soon" for these two.
- Session row records `account_id`; reattach re-injects.
- *Delivers:* "connect an account once on the server, any daemon runs on it."

**Phase 2 — Environment object.** The bundle, minus credentials (which Phase 1
already resolved).
- `environments` table + tRPC router + `resolveSpawnSpec()`.
- Adapter capability matrix + render; visible notice on unsupported fields.
- `SpawnMessage.environmentId?`; server resolves, sends the rendered spec.
- UI: named environments, assignable per agent / per role / per issue.

**Phase 3 — Sync channel + fresh-daemon bootstrap.**
- `accountsSync` / `environmentsSync` control frames on `helloOk` and on
  `settings.changed`.
- Machine × account entitlement grants.
- *Delivers:* the stated "fresh daemon install pulls its environment and is
  ready."

**Phase 4 — At-rest encryption + redaction.** Prerequisite for Phase 5, and
retroactively upgrades Phase 1's stored keys.

**Phase 5 — M3 managed OAuth (Codex first).**
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
Phases 1 + 2. Together they deliver the whole user-visible promise — *"define a
named environment with an account, mode, model, plugins, and env vars, and point
any agent at it"* — with zero rotation risk, zero transcript churn, and no new
cryptography. Phases 3–6 are where the remaining hard problems live, and each
one is separable.
