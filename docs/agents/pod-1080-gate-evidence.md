# POD-1080 (3.12 Telegram identity binding) — gate evidence

Branch `issue/1080-3-12-telegram-identity-binding`, off `issue/279-integration`.
ADR 3 Amendment 1 **D22**; ADR 1 matrix row `telegram-chat-binding`.

## The question this issue had to answer

> What stops someone claiming another person's Telegram id, and is that answer a
> property of the mechanism or of a string?

**Of the mechanism.** A Telegram message carries a chat id the sender controls,
so the chat id is never the identity assertion. The assertion is made earlier, on
an authenticated transport: a logged-in principal mints a claim code and **the
mint stamps that principal's user into it**. The claimant presents the code
out-of-band, in the chat. Redemption copies the user **from the mint**.

The enforcement is a signature, not a convention:

```ts
redeemTelegramClaimCode(mint: TelegramClaimCode, chatId: string, now: string)
```

There is no user parameter. Not "ignores one" — **takes none**, so no call site
can thread a chat-supplied value in. POD-1079's rule for the pair frame ("the
daemon supplies everything else and must not supply this"), enforced by arity and
pinned by `expect(redeemTelegramClaimCode.length).toBe(3)`.

## Which half shipped, and which did not

| D22 clause | Status |
|---|---|
| D22.1 — binding record `(chatId → UserId)` from a claim-code ceremony | **Shipped** |
| D22.2 — unknown chats yield no principal, refused, never a fallback identity | **Shipped** |
| D22.3 — the bound user's *superagent* is the actor, the user the on-behalf-of | **NOT shipped** — POD-1209, `discovered-from` POD-1080 |
| D22.4 — bot token stays `secret-value`; chat id is per-user routing | **Partial**, deliberately: see below |
| D22.5 — Telegram is not a D3 exposure tag | **Held** — no contract names a telegram transport |

**D22.3** needs superagent threads to have an owner, and they have none
(readiness §3.1.6 S2). The resolved `UserId` therefore gates the message and is
not threaded into `sendTurn`: doing that without an owned thread would put a
person's id on a shared row, which is the per-user-fact-on-a-shared-entity
mistake the POD-1076 family exists to prevent.

**D22.4**: inbound authentication moved to the binding table. The outbound
`notifications.telegramChatId` singleton still exists and is still written,
because making notification *routing* per-user is ADR 9 D8 S3's work. Inbound and
outbound are two facts on two rows; only the inbound one was an impersonation
surface.

## THE QUALIFIER — the mechanism is trustworthy, today's binding is only as good as the transport

`packages/runtime/src/auth-store.ts` is still one shared password and
`CLIENT_PRINCIPAL_GRADE` is still `'device'`, so every mint stamps the same first
admin. The honest statement is **"this instance has one human and their chat is
bound to them"**, not "chats are bound per person".

The placeholder is **named, reused, and counted**: the composition root calls
`deviceGradeSoleOwner()` — the existing name, not a fourth spelling — and
`bun run audit:machine-grants` holds its call sites to an allowlist. POD-315
deletes that module outright, which makes this line a compile error that has to
name the real principal. **Nothing in the model or the ceremony changes when it
does**: the user is already a parameter of the mint on this side of the seam.

Note the asymmetry the new audit encodes: `deviceGradeSoleOwner` is *forbidden*
inside the messaging module. At the mint it is a true statement about a transport
that cannot name a person; on the inbound path it would be a guess about a
message that named nobody at all.

## Decisions taken at forks (no human in the loop)

| Fork | Resolution | Source |
|---|---|---|
| Contract names | Keep `settings.telegramSetupStart` / `telegramSetupPoll` | A `telegram.*` family would be a THIRD spelling; the audit's exception list shrinks instead of growing a sibling |
| Role floor on the mint | `admin` | D22 reads as self-service (argues `member`); **ADR 3 Am1 D15.3 is unconditional** for a `secret` resource. ADR wins, default-closed. `machines.pairingCode` recorded and resolved the identical fork |
| Floor on the redeem | `admin`, matching the mint | The lower of two floors is the ceremony's real floor |
| Ownership on create | `inheritanceOnCreate: 'parent'` | The parent is the MINT. Plain `on-behalf-of-human` would name the redeemer, letting anyone with a `setupId` take the chat |
| Key shape | PK on `chat_id` alone | Satisfies the matrix's `(userId, chatId)` and adds what resolution needs: a chat names at most one user |
| Model fragment | `PerUserSingletonKey`, not `perUserKey(...)` | `ClientSessionAggregate`'s identical call: a Telegram chat is not a Podium entity |
| Resolution result | A union, not `UserId \| undefined` | A bare undefined is one `??` from the fallback D22.2 forbids |
| Claim-code matrix row | Reuse `pairing-token` | All five of its security cells are already right for a preimage; a second row is a second place to keep them in sync |

## Verification

Run in this worktree, after `bun install`, on the final tree.

**Typechecks** — instrument probed first by injecting `const __probe: number =
"not a number"` into `store/telegram-bindings.ts`; it was **reported**
(`TS2322`), then reverted.

```
bun run typecheck --force   →  Tasks: 23 successful, 23 total / Cached: 0 cached, 23 total
in-package tsgo --noEmit    →  packages/model=0  packages/commands=0  apps/server=0  apps/web=0
```

**Lanes**

```
bun run test:unit      568 files / 8223 passed  (1 failed — see KNOWN RED)
scripts lane           25 files / 446 passed
bun run test:web       174 files / 1371 passed
bun run test:bun:unit  14 tests, 0 fail
```

**Gates** — all green:

```
check-boundaries  56 allowlisted, 0 new       check-no-nul-bytes  ok
rearch-audit      29 items / 223 sites (baseline exact)
migration:check   ok                          migration:manifest  35 folders == 35 entries
audit: issues sessions workflows settings router-mutations machine-grants
       scoped-feed fleet spec superagent mail automations seam wire-adapters
       telegram-binding                       — all exit 0
```

**Ratchets, both DOWN, each with its vanished keys named:**

- `rearch-audit-baseline.json` — `router-triple-access` **54 → 52**, the only key
  that moved. VANISHED, not moved: the two hand-written `telegramSetup*`
  procedures left `router.ts`, and `grep mods(ctx).settings` shows the derived
  path adds no site (`modules/settings/trpc.ts:78` is the ONE generic builder
  POD-420 already shipped).
- `router-mutation-census.json` — **27 → 25**; `settings` keys go
  `['set','telegramSetupStart','telegramSetupPoll']` → `['set']`. The settings
  guard is no-ratchet in BOTH directions on purpose, so this removal is recorded
  with its reason rather than allowed quietly.
- `audit-settings-commands.ts` `ALLOWED_HAND_WRITTEN` — **3 → 1**.

**Wire goldens** — regenerated for the two new model schemas: **146 lines added,
0 removed**. `TelegramClaimCode` sits beside `UserCredential` and
`ClientSessionAggregate`; the golden pins the SHAPE of every exported model
schema and is not a claim that any of them travels the wire.

## Mutation evidence

One mutant per call. Each: applied with match-count 1, hash change confirmed,
grep-back, only the target file dirty, and **compiles** (`tsgo` exit 0).

| # | Mutant | Result |
|---|---|---|
| M1 | `if (!boundUser) return` → `void boundUser` (delete the inbound gate) | **KILLED** — 4 tests |
| M2 | binding `userId` taken from the redeeming call instead of the mint | **KILLED** — 2 tests |
| M3 | composition root mints for `user:someone-else` instead of `deviceGradeSoleOwner` | **KILLED** — 1 test |
| M4 | `MIN_SCANNED_FILES` 500 → 100000 (the new population floor) | **FIRES** — names the real population, 824 |

## The instrument bug this issue found in its own gate

The runtime-arm test timed out at 20s. Cause: each workspace package carries a
`node_modules` **symlink** to the root store and `statSync` **follows symlinks**,
so walking `apps` and `packages` re-read the whole dependency tree once per
package. `lstatSync` plus a skip set: 824 first-party non-test files, 0.2s.

The fix is the argument for the floor that came with it. `single-resolution-path`
is an absence claim over the whole tree, and the way that claim goes quietly
wrong is the scan reading nothing. A slightly different skip rule would have cut
the population to zero and made this the fastest green in the repo. POD-301's
census floor and POD-305's empty-matrix guard, same shape.

## KNOWN RED, not mine

`scripts/rearch-audit.test.ts > CLI exit codes > gates a phase whose items are
still alive` — `Test timed out in 20000ms`. This is the red the coordinator named
in advance (spawns the real binary via `spawnSync`, slow on a busy host).

- **MEASURED in isolation, 3/3 green**, each reporting a non-zero count
  (`Tests 63 passed`) — the count is checked because `vitest run` exits 0 on
  "no test files found".
- Host load average **28.83 / 37.01 / 35.42** at the time of the failing run.
- Also **MECHANISTIC**: the case spawns `scripts/rearch-audit.ts` as a child
  process and asserts its exit code; my diff touches that script's baseline JSON
  by one integer and no code it executes.
