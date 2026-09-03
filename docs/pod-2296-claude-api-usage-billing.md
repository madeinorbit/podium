# "API Usage Billing" on the POD-2245 instance — what it actually was (POD-2296)

**Verdict: nothing was billed to the API account.** The header the operator saw is the label
Claude Code prints when it is **logged out**, rendered once at startup and never redrawn. The
session that showed it had no credential yet; the login the operator did a minute later could not
change a line that was already on the screen.

The reported symptom was false, but the hazard it named is real and was **unguarded on the path
`claude` runs on** — a fix for that is what this issue lands.

---

## 1. What was measured

Read-only, on the live instance (state root `/tmp/pod-op`), plus a throwaway home of my own.

**The claude child's real environment** (`/proc/<pid>/environ` of the running session):

```
ABDUCO_SESSION ABDUCO_SOCKET ABDUCO_SOCKET_DIR BROWSER COLORTERM DBUS_SESSION_BUS_ADDRESS
GPG_AGENT_INFO HOME INVOCATION_ID LANG LOGNAME MANAGERPID … PATH PODIUM_AGENT_RELAY
PODIUM_AGENT_RELAY_PORT PODIUM_HOOK_PORT PODIUM_HOST PODIUM_INSTANCE PODIUM_NO_RELAY PODIUM_PORT
PODIUM_SESSION_ID PODIUM_SESSION_INSTANCE PODIUM_SESSION_RELAY PODIUM_STATE_DIR SHELL
SSH_AUTH_SOCK SYSTEMD_EXEC_PID TERM TMUX_TMPDIR USER XDG_DATA_DIRS XDG_RUNTIME_DIR
```

No `ANTHROPIC_API_KEY`, no `ANTHROPIC_AUTH_TOKEN`, no `CLAUDE_CODE_*` override, and
`HOME=/tmp/pod-op/state/agent-home` — the instance home, as intended. The session's only possible
credential source was that home.

**That home's credential**, non-secret fields only:

```json
{"scopes":["user:file_upload","user:inference","user:mcp_servers","user:profile",
           "user:sessions:claude_code"],
 "subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}
```

A Max subscription with `user:inference`. Written at **17:38** — the operator's in-pane login.

**The timeline that closes it.** The session process started at **17:37:07**; the credential file
was written at **17:38**. The banner the operator read was rendered ~50 seconds before any
credential existed.

## 2. Why a logged-out Claude Code says "API Usage Billing"

From the shipped CLI (2.1.224), the header builds its billing label as:

```js
let provider = apiProvider()                       // "firstParty" unless CLAUDE_CODE_USE_BEDROCK/VERTEX/…
billingType = provider !== "firstParty" ? LABEL[provider]
            : isSubscriptionAuth() ? subscriptionLabel()   // "Claude Max" / "Claude Pro" / …
            : "API Usage Billing"
```

`isSubscriptionAuth()` requires BOTH that auth resolves to OAuth *and* that the stored credential's
scopes contain `user:inference`. **No credential fails that test**, so a logged-out session falls
through to the same string as a key-authenticated one. Reproduced directly, in an empty home:

```
Opus 5 (1M context) · API Usage Billing
…
Not logged in · Run /login
```

and the identical home once a subscription credential exists: `Claude Max`.

Two further consequences worth recording: the banner is static output (printed once, never
re-rendered), so it cannot report a login that happens later in the same session; and with **no**
credential and **no** key, requests do not silently fall back to an API account — they fail with
"Not logged in". There was no billing to leak.

## 3. The real hazard, which the issue title named correctly

The environment on that instance was clean by luck of how it was started, not by construction.
Measured on the same home holding the same Max credential, with one variable added:

| environment | `claude auth status --json` |
| --- | --- |
| clean | `authMethod: "claude.ai"`, `subscriptionType: "max"` |
| `ANTHROPIC_API_KEY=…` | `apiKeySource: "ANTHROPIC_API_KEY"`, `subscriptionType: null` |

An interactive session first stops at a modal — *"Detected a custom API key in your environment …
Do you want to use this API key?"* — which, in a Podium pane nobody is watching, reads as a session
that launched and then went quiet. Approve it once and the answer is remembered per key in
`.claude.json`: from then on the switch is silent, and Podium's own login readout still names the
account on disk.

A daemon carries whatever the shell that started it carried. `podium daemon` started from a
terminal with `ANTHROPIC_API_KEY` exported hands that key to every agent it launches.

**Podium already knew this** — and had fixed it everywhere except where `claude` runs. The opencode
serve host and its attach client strip provider keys (POD-2059), the codex app-server host strips
`STRIPPED_CODEX_CREDENTIALS`, the grok ACP host deletes `XAI_API_KEY`. All three are the
*server-driver* family. The *terminal* family — every PTY session, which is how `claude`, and every
`<cli> login`, runs — stripped nothing.

## 4. The fix

Each harness manifest now declares `inventory.foreignCredentialEnv`: the env vars that override
*that* CLI's stored login (claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`; codex: the three
OpenAI/Codex credentials; grok: `XAI_API_KEY`; cursor: `CURSOR_API_KEY`; opencode: its provider
list, hoisted out of the daemon so there is one home for the fact). Required by the type, so a new
harness cannot arrive unguarded.

The PTY spawn path deletes them — a delete, because an empty `ANTHROPIC_API_KEY` is still a set one
to a CLI that tests presence. `stripEnv` existed on the abduco backend already; it is now honoured
by all three PTY backends so the guarantee does not depend on which one a machine runs.

Two things are deliberately **not** stripped:

- **A key the server put on the spawn frame.** That is the account Podium resolved for this session
  (a managed account, #216) — deliberate, not inherited. Same variable, opposite meaning; the frame
  is what tells them apart.
- **A shell session's environment.** A shell is the operator at their own prompt, not an agent
  resolving an account, and taking their key out of their own terminal would break work they meant
  to do.

Also out of scope by decision: provider/endpoint redirects (`CLAUDE_CODE_USE_BEDROCK`,
`CODEX_API_BASE`) and org selectors, which an operator may set machine-wide on purpose; and
`CLAUDE_CODE_OAUTH_TOKEN`, which is a *subscription* credential and the documented way to log a
headless box in at all — stripping it would leave such a machine with no login rather than the
right one.

Proven end to end in `apps/daemon/test/managed-account-env.bun.test.ts`, against a real process's
real environ on the Bun PTY backend the shipped daemon uses: a daemon key does not reach a
claude session, a frame credential still does, and a shell keeps the operator's own.

## 5. What is still open

- **Why the session opened logged out at all.** The home had been seeded with a copy of the
  developer's credential, and OAuth refresh tokens rotate: two homes sharing one token family
  invalidate each other, whichever refreshes first. The original file was overwritten by the
  operator's login, so this is inference from the mechanism rather than a preserved artefact.
- **Podium reported that home as logged in the whole time.** `detectLogin` for claude answers "in"
  for any parseable non-empty `.credentials.json` — it checks neither expiry nor usability, and
  `claude auth status --json`, which is authoritative for everything else, is local-only and cannot
  see a rotated refresh token either. Filed separately (POD-2308).
