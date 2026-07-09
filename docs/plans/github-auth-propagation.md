# GitHub auth propagation (#214)

Investigation outcome: recommended GitHub auth model, propagation design, and a
working spike. Sibling of the managed-environment track (#212); parent epic #211.
Builds on the Account model in [spec:SP-6454] — GitHub is **just another managed
account**, not a bespoke path.

---

## 1. The question

Can the user connect Podium to GitHub once, at the server, and have `git` and
`gh` then work for agents on every daemon machine without per-machine login?

**Yes.** The transport is proven (§5) and small. The only real decision is which
GitHub credential the server holds.

## 2. Where we are today

- `gh pr create` already runs on the daemon — `apps/daemon/src/repo-op.ts:121`,
  executed by `runRepoOp` at `apps/daemon/src/daemon.ts:1833` with **no `env`
  passed**, so it inherits the daemon process env. It works only if that machine
  happens to have `gh` logged in. On a fresh VPS daemon it silently fails.
- `SpawnMessage` (`packages/protocol/src/messages.ts:1197-1213`) has **no field
  able to carry a credential**, and there is no settings/config push at all — the
  server only ever sends control frames.
- The daemon's per-spawn env overlay is `apps/daemon/src/daemon.ts:1357-1370`
  (currently: `PODIUM_SESSION_ID`, `PODIUM_ISSUE_RELAY`,
  `CLAUDE_CODE_SUBAGENT_MODEL`, a codex hook URL). This is the injection seam.
- Server-held secrets are **plaintext** in the `settings` JSON blob in SQLite
  (`apps/server/src/store/settings.ts:14-30`). No vault, no encryption at rest.
  The existing comment (`packages/core/src/settings.ts:196`) states the trust
  model: *"same trust domain as the shell the agents already run in."*

That last point governs the whole security analysis (§6).

## 3. Recommended auth model

### Primary: a **GitHub App**, connected by **device flow**, held as a **user access token**

The user runs "Connect GitHub" in Settings, gets a code, enters it at
`github.com/login/device`, and picks which repos to install the Podium app on.
The server stores the resulting user access token + refresh token.

Why a **GitHub App** (not an OAuth App, not a PAT):
- Fine-grained, per-repo permissions the user chooses at install time; an OAuth
  App collapses everything into the single blanket `repo` scope.
- Fine-grained PATs **cannot be minted programmatically** (UI-only), so they
  can't back a "connect once" flow at all. Classic PATs are a blanket secret.
- Device flow needs no client secret and no browser on the server, which is
  exactly the headless/self-hosted shape. It must be explicitly enabled in the
  app settings.

Why a **user** access token (not an installation token) as the default:
- **Attribution.** Commits, PRs and comments land as the real user. Installation
  tokens act as `podium[bot]`. For a personal coding-agent tool where the user's
  own PRs are the product, bot attribution is the wrong default.
- **`gh` compatibility.** `gh` assumes a user context: with an installation token
  `gh auth status` and `gh api /user` fail (no user behind the token), because
  `gh` validates by calling `/user`. Repo and PR subcommands still work, but the
  agent gets confusing errors.
- **Gists are impossible** with an installation token — GitHub Apps have no gist
  permission at all. Only a user-context token (`gist` scope / user token) can.
- Lifetime is workable: 8h token + 6-month single-use refresh token, refreshed
  server-side. (Token expiry is still an opt-in app feature — we should leave it
  **on**; non-expiring user tokens are a currently-permitted option GitHub has
  signalled may tighten.)

Caveat to design around: a user access token reaches the **intersection** of what
the user can access and what the app is installed on. It is not a blanket "all my
repos" token — installing the app on the right repos is part of connect.

### Secondary: **installation tokens**, for untrusted machines and unattended work

Same GitHub App, different token family: mint a 1-hour token from the app private
key (JWT → `POST /app/installations/{id}/access_tokens`), scoped at mint time to
a specific repo set and permission subset. Use it when:
- the daemon runs on a machine we don't fully trust (a rented VPS), where a
  1-hour repo-scoped token is a much smaller thing to leak than a 6-month
  refresh token; or
- we want per-operation minting with no standing credential anywhere.

Worth correcting a widespread belief: pushes made with a GitHub App **installation
token do trigger Actions workflows**. The recursion guard applies only to the
Actions-provided `GITHUB_TOKEN`. Using an App token *is* the standard workaround
for that guard, so this is not an argument against installation tokens.

### Permissions to request

| Agent capability | GitHub App permission | (classic scope equivalent) |
|---|---|---|
| baseline | `metadata: read` | — |
| clone private repo | `contents: read` | `repo` |
| push a branch | `contents: write` | `repo` |
| open / update a PR | `pull_requests: write` | `repo` |
| comment on PR or issue | `issues: write` + `pull_requests: write` | `repo` |
| read / write issues | `issues: write` | `repo` |
| push `.github/workflows/**` | `workflows: write` (+ `contents: write`) | `workflow` |
| create a gist | *impossible for installation tokens*; user token only | `gist` |

Request `workflows: write` — agents edit CI constantly, and without it the push
is rejected with a confusing error. Treat gist as out of scope for the
installation path.

## 4. Propagation design

The load-bearing principle: **the daemon never stores a GitHub credential.** It
receives one at spawn, and/or asks the server for a fresh one per operation.

### Refresh-token rotation constrains the whole design

GitHub App refresh tokens are **single-use and rotating**: exchanging one returns
a new access token *and* a new refresh token, and — the part that bites —
["that refresh token and the old user access token will no longer work"](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
Two consequences, both load-bearing:

1. **The refresh token must never leave the server.** Two daemons holding it
   would race to rotate and permanently wedge the login. Only short-lived access
   tokens are ever propagated. (Access tokens are plain bearer tokens — several
   daemons may hold the same one concurrently until it expires. It is only
   *refresh* that is single-holder.)
2. **A refresh silently kills every access token already handed out.** An 8-hour
   access token injected into a running agent's env is not merely stale after 8
   hours; it dies the *instant* the server refreshes for any reason. Env
   injection therefore cannot be the end state for long-lived sessions — it makes
   `git push` fail mid-session with a bare 403.

This is the strongest argument for Layer 2, and it upgrades the callback helper
from a nice-to-have to the correct destination. Layer 1 remains a valid first cut
because it fixes a hole that exists today, and because a fresh token is minted at
each spawn.

### Layer 1 — env injection at spawn (works today, proven)

The server resolves the GitHub account and adds to the spawn env overlay
(`daemon.ts:1357-1370`), carried by a new `env: Record<string,string>` field on
`SpawnMessage`:

```
GH_TOKEN=<token>
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=credential.https://github.com.helper
GIT_CONFIG_VALUE_0=!gh auth git-credential
```

`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` inject git config purely through the
environment — no `~/.gitconfig`, no `.git/config` mutation, nothing on disk. Git
then delegates credentials to `gh`, which reads the same `GH_TOKEN`. One
credential, two consumers, zero files. It is inherited by every process the agent
spawns.

The `env` field must be a general `Record<string,string>` and not a
`githubToken` field — that is the whole point of coordinating with #212. LLM API
keys, GitHub tokens, and any future managed credential all ride the same channel.

### Layer 2 — a callback credential helper (handles expiry, rotation, revocation)

Env is captured at spawn and cannot be updated in a running process. An 8-hour
user token — let alone a 1-hour installation token — goes stale inside a long
agent session. So git should not read a *value* from env; it should read a
*command*:

```
GIT_CONFIG_VALUE_0=!podium git-credential
```

`podium git-credential` is a new daemon-side CLI verb that calls the server over
the existing daemon socket, asking for a token for this remote. The server
refreshes or mints on demand and returns it on stdout. Git invokes the helper on
every auth challenge, so every git operation gets a fresh token, and nothing
durable exists on the daemon at all.

This one mechanism buys expiry handling, rotation, instant revocation (the server
just stops answering), multi-account selection (the server picks the account by
repo/owner), and per-operation installation-token minting — the exact pattern the
industry converged on.

`gh` cannot take a command for `GH_TOKEN`. Cover it with a `gh` shim placed
earlier on the daemon's PATH that fetches a fresh token, exports it, and `exec`s
the real `gh`. Same trick makes `repo-op.ts`'s `gh pr create` work unchanged.

Per #212, this callback generalises past git: `podium credential <accountId>`
serves both git's `credential.helper` and Claude Code's `apiKeyHelper`. So Layer
1's env injection must not hard-code git config *writing* — the env path has to
be replaceable by the helper path without touching adapters.

Note the daemon must actually have `gh` on PATH for the `!gh auth git-credential`
form. #213's bootstrap installs `gh` but deliberately does **not** authenticate
it, and #222 will have the daemon report a tool inventory at pair/hello — so the
server can know whether a machine can receive a gh credential at all. Fallback
where `gh` is absent: a plain shell helper printing `username`/`password`.

### Phasing

1. **Layer 1 + a plain token** (the spike, §5). Immediately fixes `gh pr create`
   failing on fresh daemons. Needs: `env` on `SpawnMessage`, an env arg on
   `runRepoOp`, and a `managed:github` Account.
2. **Device-flow connect UI** in the Accounts & Keys hub (already shipped as a
   hub, with "managed" modelled and marked Coming soon).
3. **Layer 2** — `podium git-credential` + `gh` shim + server-side refresh.
   Unlocks expiring tokens, installation tokens, multi-account.

### Fit with the Account model (SP-6454)

No new concepts. GitHub becomes:

```
Account { id: 'managed:github', provider: 'github', source: 'managed',
          kind: 'oauth', identity: { login, avatar }, credential: <server-side> }
```

`AccountProvider` gains `'github'`. This does stretch the current model in one
place worth naming: `provider` is presently an *LLM* provider, and roles bind to
exactly one account. GitHub is not an LLM and is not role-scoped — every session
wants it. So the resolver needs a notion of **ambient accounts** (credentials
injected into every spawn) distinct from **role accounts** (the LLM backing a
role). That is a #212 decision, not a GitHub one — flagged in mail to that track.

Multi-account (work + personal GitHub) then falls out: several `managed:github`
accounts, and the server selects by repo owner when answering the credential
helper. Layer 1 cannot do this (one env, one token); Layer 2 can. Another reason
Layer 2 is the real destination.

## 5. Spike — done, passing

`scripts/spike-gh-auth-propagation.sh`. Simulates a fresh daemon with
`env -i HOME=<empty>`: no `~/.config/gh`, no `~/.git-credentials`, no ssh keys.

Baseline, before injection:
- `gh auth status` → not logged into any GitHub hosts
- `git ls-remote <private repo>` → `fatal: could not read Username`

After injecting the three env vars above and nothing else:
- `gh auth status` → logged in, source `GH_TOKEN`; `gh api /user` → the user
- `git ls-remote` and `git clone --depth 1` on a **private** repo → succeed
- `git push --dry-run origin HEAD:refs/heads/…` → `* [new branch]`, auth accepted
- **files written to the daemon's HOME: 0**

So a server-held token plus three environment variables is sufficient for the
full clone/push/PR surface, with no state left on the machine.

## 6. Security model

The honest framing: **an agent with a shell can read its own environment**, and
Podium agents have a shell. Injecting a GitHub token into the spawn env grants
the agent exactly the GitHub access we intend to grant it. There is no
containment story against the agent itself, and pretending otherwise would be
theatre. What the design *can* control is blast radius and lifetime:

- **Scope** — the app is installed only on repos the user picks, with the
  permission set in §3. A leaked token is not "all of GitHub".
- **Lifetime** — Layer 2 means the only thing on a daemon at any instant is a
  token good for ≤1h (installation) or ≤8h (user), fetched per operation. The
  long-lived secret (app private key, refresh token) never leaves the server.
- **Revocation** — a server-side switch, effective immediately, because the
  daemon has nothing cached.
- **Exposure surface on the box** — env is readable via `/proc/<pid>/environ` by
  the same uid, and daemons already carry ambient state, so this is not a new
  class of exposure. Keeping the token out of argv and off disk (both true here)
  removes it from `ps` output, shell history, and backups.
- **Server-side storage is the weak link and must be fixed before this ships.**
  Today every secret is plaintext in `meta.settings`. A GitHub refresh token or
  app private key sitting next to the LLM keys in a plaintext blob is a
  meaningful step up in what a stolen `podium.db` costs the user. Encryption at
  rest for managed credentials is a **prerequisite of the managed-account work in
  #212**, not a GitHub-specific concern.

## 7. Recommendation

1. Register a **Podium GitHub App**, device flow enabled, permissions per §3.
   (Self-hosters who won't use a shared app can register their own and paste the
   client id — the flow is identical.)
2. Ship **Layer 1 + user access token** first: it is a `SpawnMessage.env` field,
   an env arg on `runRepoOp`, and a connect flow. It closes the "PR creation
   silently fails on a fresh daemon" hole today.
3. Then **Layer 2** (`podium git-credential` + `gh` shim), which is what makes
   expiry, rotation, revocation and multi-account work rather than be hazards.
4. Offer **installation tokens** as a per-machine option for untrusted daemons,
   accepting bot attribution there. Workflows still trigger; gists don't work.
5. Do none of this as a GitHub-specific pipe. `SpawnMessage.env` and the
   credential-helper callback belong to #212's managed-credential channel; GitHub
   is the first tenant.

## 8. Open questions for #212

- **Ambient vs role-scoped accounts** — the resolver assumes one account per
  role; GitHub is needed by every session regardless of role. Needs a first-class
  "inject into every spawn" concept.
- **Encryption at rest** for managed credentials, before any refresh token or app
  private key is persisted.
- **`AccountProvider`** must widen beyond LLM providers, or split into
  `LlmProvider` and a broader `CredentialProvider`.

## Sources

- [Differences between GitHub Apps and OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)
- [Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [GITHUB_TOKEN and the workflow-recursion guard](https://docs.github.com/en/actions/concepts/security/github_token)
- [actions/create-github-app-token](https://github.com/actions/create-github-app-token) — App tokens do trigger workflows
- [gitcredentials — custom helpers](https://git-scm.com/docs/gitcredentials)
- [gh auth login manual](https://cli.github.com/manual/gh_auth_login)
- [Cursor GitHub integration](https://cursor.com/docs/integrations/github) — App-installation precedent
- [claude-code-action setup](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md) — OIDC → installation token precedent
