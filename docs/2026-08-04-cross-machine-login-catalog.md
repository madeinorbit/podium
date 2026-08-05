# Cross-machine harness login catalog

Proposal for POD-1659.

**Revision 6 — simplified.** Revisions 1-5 accumulated managed homes, a symlink farm, config mirroring, a precedence engine and an install-ownership tri-state. That was over-built. This revision follows one rule through — *if the user says a machine is Podium-managed, Podium manages it* — and most of that machinery disappears. The investigation findings (§2-4) are unchanged; the design (§5-7) is much smaller.

---

## 1. What we have today

| Piece | Where | What it does |
|---|---|---|
| Per-machine login detection | `packages/harness/src/manifests/{codex,claude-code,grok}.ts` → `inventory.detectLogin(homeDir)` | Returns `{state: 'in'\|'out'\|'unknown', account?}`. `account` is a **display string**, not an identity. |
| Inventory transport | `packages/harness/src/inventory/build-inventory.ts:37` | Each daemon already ships its `login` to the server. The data crosses the wire today. |
| Settings hub | `apps/server/src/accounts.ts:89-93` | `detectNative(homedir(), …)` runs against the **server's own** home — hence "this machine". |
| Capability gate | `packages/model/src/predicates/machine-selection.ts:190` | `login.state === 'out'` → `'logged-out'` rejection. |
| Spawn refusal | `apps/server/src/modules/machines/service.ts:390` | Throws `"codex is not logged in on machine 'X'"`. The dead-end popup. |
| Progressive enhancement | `packages/harness/src/manifest.ts:40-80` | `Declared<T>` + registry totality. The lever for uneven harness support; already exists. |
| Session wiring | `apps/daemon/src/control/session.ts:58-100` | `podium` CLI + relay are env/PATH based — **home-independent**. |

## 2. What Orca does (`stablyai/orca`, `src/main/codex-accounts/`)

**Two lanes.** `codex-real-home-flag.ts`: *"the SYSTEM-DEFAULT Codex account always runs against the user's real `~/.codex`; managed (multi-account) selections always get their own self-contained homes."* Managed homes exist for **multi-account**, and each is populated by its own `codex login` — a separate authentication, hence a separate refresh lineage.

**No cross-machine transfer.** `addCodexFromHome` / `addClaudeFromConfigDir` are host-runtime-only (`rpc/methods/accounts.ts:154,168`): *"paired mobile and remote-runtime tokens must never read host credential paths."* Their SSH relay ships plugin files, never credentials. So Orca gives us safety machinery, not a design.

**The safety rules worth stealing** (small, load-bearing, all in scope):
- **5s absence grace** (`codex-credential-absence-grace.ts`): *"codex rotates auth.json in place, so one missing/unreadable read can be a write in progress."* Never flip to logged-out on one snapshot.
- **Identity from JWT claims** (`codex-auth-identity.ts`): `email`, `chatgpt_account_id`, `workspace_account_id` out of `id_token`.
- **Freshness ordering** (`compareCodexAuthFreshness`): from `expires_at` / `exp` / `iat`, returning **`null` when unprovable** — never overwrite on a comparison you cannot make.
- **Atomic / CAS writes** (`fs-utils.ts`).

**The cost of their managed-home approach**, for reference: `runtime-home-service.ts` is 2410 lines, and `config.toml` alone generates `config-settings-promotion`, `config-settings-baseline`, `config-sync-stall`, `codex-config-settings-preservation`, `config-toml-runtime-owned-sections`. All because they copy a home instead of using it. §6 avoids this entirely by not having a second home.

## 3. The refresh-lineage problem

ChatGPT refresh tokens are single-use and rotate on refresh (`apps/server/src/codex-auth.ts:12-19`, openai/codex #10332).

**A separate directory does not create a separate lineage.** Copy a credential from home A to home B and both hold the same refresh token; whichever refreshes first rotates it upstream and the other is left holding a spent one. Two directories, one lineage, one winner.

This is the key fact for §6: **managed homes were never buying us safety for propagation.** They buy multi-account. Propagation forks a lineage no matter where the bytes land, so paying the managed-home complexity tax to do it changes nothing about the risk.

The answer is convergence, not prevention: detect the failure, re-propagate the freshest working copy.

## 4. What lives in a harness home

Relevant because it is the cost of *any* home redirection — and the reason §6 does not redirect.

| Content | Podium's dependency | Breaks under redirect? |
|---|---|---|
| `hooks.json` | `apps/daemon/src/codex-hooks.ts:122` hardcodes `join(homeDir, '.codex')` | **Yes** — no agent-state observation, no session binding |
| `sessions/*.jsonl` | transcripts (`agent-state/codex.ts:1091`), resume (`manifests/codex.ts:142`), discovery (`:481`) | **Yes** |
| `config.toml`, AGENTS.md | model provider config, trust, instructions | Yes — silent drift |
| MCP config | codex `inline`, claude `path` — both by flag | No |
| `podium` CLI + relay | env + PATH | No |

## 5. The organising rule

**One flag, two worlds. No middle cases.**

| | **Podium-managed machine** | **User's machine** |
|---|---|---|
| Default for | copy-paste onboarding (a server you added *for* Podium) | desktop app (your Mac) |
| Harnesses | Podium installs and updates its own, into its own prefix | Podium installs nothing, updates nothing |
| Harness home | the real home, used directly | the real home, used directly |
| Hooks | written | written (as today) |
| Propagating a login in | silent | ask first |

If the user says a machine is Podium-managed, Podium follows through and installs its own harnesses. A pre-existing foreign install is simply left alone — not adopted, not updated, not reasoned about. The user's own terminal keeps using it; Podium sessions get Podium's, because `spawnEnv` already makes Podium's install roots authoritative on PATH (`control/session.ts:78-90`). Two installs, zero coupling, no adoption logic.

The version-skew objection I raised in r5 dissolves here: skew only matters on a machine where the user also works, and there we install nothing at all.

**Onboarding UX.** A toggle beside the copy-paste field that rewrites the command (`--managed` / `--shared`), defaulting to managed. Desktop app defaults to user's machine. Both defaults are right for the common case, so it is zero-click; the toggle exists so it is never a surprise. The machine row carries a plain badge with one line on what it changes. Post-hoc switching is the same flag.

## 6. Design

### 6.1 Propagation writes the real home — only when it holds no valid login

This is the simplification the rest of the design hangs on, and it reverses r1-r5's "never write a real home" invariant. The reason that invariant existed was to avoid **overriding a working login** (constraint 1). Writing only into a home that has *no* working login cannot do that.

Consequences:
- The user's `codex login` always wins, because they write the same file we do — the moment they log in, they are authoritative. Constraint 1 holds by construction, not by a precedence engine.
- No managed homes, no symlink farm, no config mirroring, no session bridging, no launch-time home resolution. §4's whole breakage table becomes irrelevant.
- Hooks, transcripts, resume and config keep working untouched, because nothing moves.
- Risk is unchanged from any managed-home variant (§3), so we pay none of the complexity for none of the benefit.

Consent, not isolation, is what protects the user's machine: on a machine they marked as theirs, we ask before writing a borrowed credential in. On a Podium-managed machine we just do it.

### 6.1a Taking the login from an existing install costs nothing

On a Podium-managed machine we install our own harness binary and leave any foreign one alone (§5). The login still carries over **with no work at all**, because *credentials live in the home, not next to the binary*. `~/.codex/auth.json` is per-user; a homebrew codex and a Podium-installed codex read the same file. Since §6.1 uses the real home directly, a Podium-installed binary simply finds the login the user's own CLI created.

There is nothing to adopt, migrate, or copy. Binaries and credentials are on different axes, which is why the install-ownership question (r5) never applied to logins in the first place.

One edge case, minor: a user who sets `CODEX_HOME` in their shell rc has a home the daemon (started by systemd) will not see. Detection already reads `process.env.CODEX_HOME` (`manifests/codex.ts:32`), and detection and spawn resolve it the same way, so the two stay consistent with each other even when they differ from the user's interactive shell. Not worth special-casing now.

### 6.2 Catalog

Extend `HarnessLogin` with identity and freshness (non-secret; rides the existing inventory path to clients):

```ts
export interface HarnessLogin {
  state: 'in' | 'out' | 'unknown'
  account?: string                  // display, unchanged
  identity?: { fingerprint: string; email?: string; providerAccountId?: string }
  freshness?: number                // ordering only
}
```

Server aggregates per-machine logins into a catalog keyed by fingerprint: one entry per identity, listing the machines that hold it. `accountViews()` reads that instead of `detectNative(homedir())`, and Settings shows "on vmi3407763, macbook".

### 6.3 Progressive enhancement — `Declared<T>`

Two new capabilities on `HarnessInventory`, alongside the existing mandatory `detectLogin`:

```ts
loginIdentity: Declared<(homeDir: string) => LoginIdentity | undefined>
portableCredential: Declared<{
  files: readonly string[]
  compareFreshness(a: string, b: string): -1 | 0 | 1 | null
}>
```

Registry totality forces every harness to declare; `unsupported(reason)` surfaces in `podium doctor`. Support degrades in tiers with no harness-specific branching anywhere:

| Harness | detect | identity | portable | Result |
|---|---|---|---|---|
| codex | ✅ | ✅ JWT claims | ✅ `auth.json` | catalog + propagation |
| claude-code | ✅ | ✅ `.claude.json` | ✅ `.credentials.json` | catalog + propagation |
| grok | ✅ | likely | to confirm | catalog at minimum |
| cursor, opencode | ❌ `'unknown'` | ❌ one line | ❌ one line | absent; spawn unaffected |

Note `managedHome` is **gone** from r4's capability set — nothing redirects a home any more.

### 6.4 Propagation mechanics

Triggers: a spawn finds the target logged out; or a running session raises a logged-out harness error (`apps/server/src/modules/superagent/harness-error.ts:85` already classifies `401 / not logged in / token expired`).

Donor: catalog entries with `state === 'in'` on an online machine — first match (no policy yet).

Transfer: server requests bytes from the donor daemon, hands them to the target daemon, which writes the real home's credential file with a CAS write. Guarded by:
- **5s absence grace** before believing a machine is logged out — otherwise in-place rotation reads as a logout and we propagate over a race.
- **Only strictly-fresher bytes overwrite** — `compareFreshness(candidate, current) === 1`; `null` does not overwrite.
- **Attempt cap + backoff** so re-propagation cannot thrash.

Secrets: bytes go server-side keyed store only (`store/server-secrets.ts`), server→daemon over the authenticated channel, principal-gated. Never into the replicated store or the settings blob — `apps/server/src/accounts.ts:72` already warns that settings round-trip to every client wholesale. The catalog (identities, states, freshness) is client-safe.

### 6.5 Soft logged-out — the popup fix

Narrow the rejection union so `logged-out` is no longer an `AgentCapabilityRejection`; the compiler then walks every consumer (`requireAgent`'s exhaustive switch, `NewPanelMenu.tsx:550`, `SessionContextMenu.tsx:114`).

Spawn proceeds, the pane opens, the user can run `codex login` in it. The session carries a login condition so state stops lying, with affordances "log in here" and "use the login from `<machine>`".

One subtlety: `resolveMachineForAgent` uses the same predicate for *implicit* machine selection, where refusing a logged-out machine is correct. The two call sites must diverge — implicit picking still avoids logged-out machines; an explicit pin no longer hard-fails.

## 7. Phasing

| Phase | Deliverable | Ships alone? |
|---|---|---|
| **A** | Soft logged-out + accurate session login state (§6.5) | Yes — kills the dead-end popup |
| **B** | `Declared` login capabilities, identity + freshness, server catalog keyed by fingerprint, fingerprint-capable native account ids, session records the identity it used, `podiumManaged` machine flag + onboarding toggle (§5, §6.2-6.3, §10) | Yes — "this machine" becomes real, and multi-account stays additive |
| **C** | Propagation + re-propagation into the real home (§6.4) | The actual ask |

Three phases, not five. C is now small because there is no home machinery under it.

## 8. Explicitly deferred

Not needed for the 90%, and each is cleanly additive later:

- **Multiple native logins per harness on one machine.** This is the only genuinely expensive part, because two OAuth logins on one machine need two homes — Orca's whole `runtime-home-service` problem. Postpone; see §11 for why postponing is nearly free.
- **Dedicated Podium login** (`CODEX_HOME=<managed> codex login`, Orca's `service.ts:1651`). The clean upgrade path when a borrowed credential proves too disruptive on a user's machine. Needs managed homes, so it follows them.
- **Selection policy** when several logins work — round-robin, pinning, quota awareness. First match until it hurts.
- **Adopting foreign harness installs**, and harness install/update machinery generally. A separate deliverable; this issue closes without it.

## 9. Residual risk, stated plainly

Propagation forks a refresh lineage (§3). A user running codex heavily in their own terminal *and* on a borrowed copy elsewhere will sometimes get logged out locally; re-propagation heals the Podium side automatically, but their terminal needs a manual `codex login`. The `podiumManaged` flag keeps this consented rather than surprising, and §8's dedicated Podium login is the escape hatch if it bites in practice.

## 10. Multi-account and API keys — now or later?

Split the question, because the two halves have very different costs.

**API keys / managed credentials: already built.** Not "easy to add" — present.

- `accounts` table with arbitrary rows, `credential` server-only, clients see a masked `identity` (`apps/server/src/store/accounts.ts`).
- Injection at spawn: `resolveAccountEnv` → `credentialEnv` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`).
- Per-role selection already models the unified account reference: `RoleBackend.accountId` (`packages/model/src/settings/preferences.ts:83`) accepts `native:<harness>` or `managed:<provider>`, and its doc states *"the account determines execution (harness vs api) + provider/harness"*. It already carries the presence-not-value discipline: the id replicates, the credential never does.
- `scope: 'role' | 'ambient'` exists for per-role vs every-spawn injection.

So a remote runtime that needs API-key credentials is already served. Adding providers is a line in `credentialEnv`.

**Multiple native OAuth logins: expensive, and postponing is nearly free.**

Expensive because two logins on one machine need two homes, which is exactly the machinery §6 just deleted. But the only things costly to retrofit are *identifiers* and *keys*, and both can be made future-proof in phase B at no cost:

1. **Key the catalog by identity fingerprint, not by machine** — §6.2 already does. Multiple identities per harness are representable from day one; only *selection* is missing.
2. **Mint native account ids that can carry a fingerprint** — `native:codex` today, `native:codex:<fingerprint>` when there are two. `AccountIdField` is brand-only and already tolerates both, and `''` already means "the role's default", so a single-login machine keeps working unchanged.
3. **Record which identity a session actually used.** One field, cheap now, and the only thing here that is genuinely painful to backfill — every future selection or quota policy needs the history.

With those three in phase B, adding multi-account later is purely additive: managed homes plus a picker, no migration of a replicated record.

**Recommendation: postpone the implementation, land the shape now.** File it as a spin-off when wanted — this issue closes honestly without it.

## 11. Open question

Ship A alone first, or A-C in one branch? A is small and independent.
