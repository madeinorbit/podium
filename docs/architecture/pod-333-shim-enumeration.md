# POD-333 — the enumerated shim list, and what it found

Phase 7.1's deletion criterion is **named compatibility shims**, not "zero
re-export modules" (finding 16: package and module index barrels are legitimate
public API). The list is therefore ENUMERATED, built at phase entry from the
per-phase as-built sections, the ledger, `docs/multi-user-readiness.md`, and the
deletion audit — then deleted against.

This file is the record, including the entries that turned out **not to exist**.
Recording an absence matters as much as recording a deletion: the next audit will
ask the same questions, and "we looked and it was not there" is a different
answer from "nobody looked".

## Part 1 — Re-export shims (deleted)

### Files (16)

Each carried its own justification in a doc comment — "re-exported here so
apps/server import sites stay stable", "Re-export shim (arch-v2 P3)",
"Compatibility re-export".

| Path | Real home |
|---|---|
| `apps/server/src/auth-store.ts` | `@podium/runtime/auth-store` |
| `apps/server/src/issue-client.ts` | `@podium/issue-client` |
| `apps/server/src/issue-commands.ts` | `@podium/issue-client` |
| `apps/web/src/app/optimistic-spawn.ts` | `@podium/client-core/viewmodels` |
| `apps/web/src/app/replica.ts` | `@podium/client-core/replica` (+ `/react`) |
| `apps/web/src/app/router.ts` | `@podium/client-core/router` |
| `apps/web/src/app/spawn-agent.ts` | `@podium/client-core` |
| `apps/web/src/app/types.ts` | `@podium/client-core/viewmodels` (+ `@podium/model`) |
| `apps/web/src/features/files/file-panel-mode.ts` | `@podium/client-core/ui-state` |
| `apps/web/src/features/superagent/derive-tray.ts` | `@podium/client-core/viewmodels` |
| `apps/web/src/features/terminal/ArrowSwipeKey.tsx` | `@podium/terminal-client-react` |
| `apps/web/src/lib/dock-panel.ts` | `@podium/client-core/viewmodels` |
| `apps/web/src/lib/file-scope.ts` | `@podium/client-core/viewmodels` |
| `apps/web/src/lib/home.ts` | `@podium/client-core/focus` |
| `apps/web/src/lib/hooks/use-mark-read-on-view.ts` | `@podium/client-core/react` |
| `apps/web/src/lib/voice.ts` | `@podium/terminal-client-react` |

### Blocks inside otherwise-legitimate barrels (2)

The audit's re-export-ONLY unit could not see these, because the files around
them are real public API.

- `packages/protocol/src/index.ts` — the branded-id republication. Its own
  comment scheduled the deletion: *"POD-362 / POD-363 re-point remaining
  consumers at @podium/model and delete this block."* Both issues are closed, so
  the block was orphaned.
- `packages/client-core/src/viewmodels/index.ts` — *"the last residue of the
  deleted `derive.ts` … so existing call sites keep working unchanged."*

### Blanket forward beside real code (1)

- `apps/web/src/lib/derive.ts` — `export * from '@podium/client-core/viewmodels'`
  next to one genuinely web-side helper (`sessionDotClass`, which needs
  tailwind-merge). Invisible to a re-export-ONLY unit for two phases, and found
  by a typecheck error rather than by the audit. The detector now counts this
  form; see the reconciliation in `docs/rearch-deletion-audit.md`.

### Kept (5) — barrels, not tombstones

`apps/daemon/src/index.ts`, `apps/server/src/index.ts`, its
`modules/{messaging,superagent}/index.ts`, and `apps/web/src/lib/motion/index.ts`
re-export **local siblings**: nothing moved, so no import path is being held
open. The audit unit was re-cut to read the EDGE rather than the file's location,
which is what separates these from the sixteen above.

### The paths are banned

`manifest-retired-path` (`scripts/architecture-manifest.ts`) is an error-level
rule with no allowlist. It refuses both the file reappearing at a retired path
and any import that resolves to one, and it understands apps/web's `@/` alias
because 30 of the moved call sites used it.

## Part 2 — The multi-user enumeration

The landings POD-1075/1076/1077/1079/1080/1081 each replaced a single-operator
mechanism, so each replacement was a candidate shim. Findings, in the brief's
order.

### 2.1 The single-operator auth path — **EXISTS, NOT DELETED HERE** (POD-1554)

`packages/runtime/src/auth-store.ts` still keeps one shared password per instance
in `auth.json`, and `credentialFor()` still returns `source:
'instance-password'`. It is residue by its own migration's words — POD-1075's
migration says minting per-account credentials *"lands with the per-user login
work in Phase 3 (POD-315)"*, and POD-315 closed without doing so.

It was NOT deleted in this sweep, for two reasons, the second blocking:

1. **Lockout risk.** The first admin of every upgraded instance authenticates
   through `auth.json`. The hash has to move into a `per-user-scrypt` credential
   row first, and that cannot be a SQL migration (SQL cannot read `auth.json`).
2. **A product decision is required.** An instance may run with NO password —
   the loopback/all-in-one default — and `clearPassword` is a supported "opt out
   of login" action in Settings → Security. Under real accounts, "no auth" and
   "per-user accounts" are different regimes, and `clearPassword` has no per-user
   meaning: one user cannot turn login off for the instance. How the two regimes
   coexist is exactly the per-feature call `docs/multi-user-readiness.md` leaves
   deferred, and a shim sweep is the wrong place to decide it.

Filed as **POD-1554** with the full site list and the runtime verification it
needs (a real browser login on an upgraded instance, plus a second account
logging in beside it — this is an authentication surface, and a green unit lane
is not evidence).

### 2.2 The `OPERATOR` constant — **EXISTED, DELETED**

`packages/model` exported `OPERATOR` (`admin`/`all`) as *"the human operator …
unconstrained"*. A repo-wide search found **no production reader**: only tests,
the server's oracle support, and prose. Moved to
`apps/server/src/test-support/capabilities.ts` as a named fixture, with the trap
recorded beside it — `scope: 'all'` short-circuits `authorize()`, so a test
written against it exercises the short circuit rather than the policy, which is
how POD-351 lost a class of revocation coverage.

No parallel authorization helper was introduced as a bridge: §3.2's requirement
that the closed `IssueScope` set be EXTENDED with owner/grant scopes rather than
duplicated held — `authorize()` is still the single enforcement function, and the
`owned` scope is a member of the same closed set.

### 2.3 Nullable-owner / dual-read tolerance — **EXISTED, DELETED**

`SessionClientControl` took `sessionOwner` and `machineUseFor` as OPTIONAL ports,
behind `if (!this.ports.sessionOwner) return true` and `?? 'granted'`. Production
wired both, so nothing was exposed — but a gate that is skipped when a dependency
is missing is one refactor from being an unwired gate, and `MachineUseDecision`
deliberately has no `'unknown'` member precisely so this cannot happen. Both
ports are required now, and an unresolvable owner denies — including for the
instance admin, which is the operator-fallback shape itself.

### 2.4 Ownerless machines — **DID NOT EXIST**

The `20260730210350_machine-ownership` migration (POD-1079) is the one-shot data
migration §3.1.4 M3 asks for, and it stays where schema migrations live. The
runtime already fails closed: `owner_user_id` is nullable *and null is
meaningful* — `machineUseAllowed` grants `use` to nobody on an ownerless machine,
and the migration's own header explains why a NOT NULL column with a default
would have been the fail-OPEN shape. `AgentCapabilityRejection` keeps
`unauthorized` and `offline` distinct, as M5 requires. No ambient-team-compute
path was found.

### 2.5 Unscoped feed / watermark adapters — **DID NOT EXIST**

As §3.1 predicted: the scoped feed landed before the POD-308 wire cutover, so
there is no pre-scoping path beside the scoped one and no transitional watermark
or rescope/evict adapter. No deviation to record.

### 2.6 Singleton `telegramChatId` — **DID NOT EXIST (already per-user)**

`notifications.telegramChatId` is already per-user routing
(`settings.getSettingsFor(userId)`), and `notifications.telegramBotToken` remains
a server-only admin-managed secret, which is not a shim. The unknown-chat
fallback §3.1.6 S4 warns about does not exist either:
`resolveTelegramPrincipal` returns `{ ok: false, reason: 'unbound' | 'ambiguous' }`
and there is no operator-identity arm. Because it is already per-user, Job 2
needed no `telegramChatId` config migration.
