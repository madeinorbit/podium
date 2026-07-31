# POD-1213 — Personal preferences get per-user storage

**Status:** review · branch `issue/1213-per-user-preference-storage`, REBASED onto `issue/279-integration` (rebased, never merged — the diff is exactly this issue's four commits against the new base). The rebase was needed to reach POD-1211's membership gate, which does not exist on the older base.

## What landed

ADR 1's 24 `preferences-personal` leaves moved off the instance-wide
`meta['settings']` blob onto a `(user_id, key)` table. Instance-tier keys stayed
on the singleton — this moved 24 leaves, not the blob.

| Piece | Where |
|---|---|
| Family member (7th) | `packages/model/src/user-state/preference-state.ts`; `family.ts` counts 7 members + 2 non-members (was 6 + 3) |
| Table | `apps/server/src/migrations/schema.ts` → `user_preferences(user_id, key, value, updated_at)`, PK `(user_id, key)` |
| Migration | `drizzle/20260731040000_personal-preference-store` — COPY before CLEAR, backfilled to `'user:sole'` |
| Repository | `apps/server/src/store/user-preferences.ts` — every method takes a user; no bulk cross-user read exists |
| Resolution | `SettingsRepository.getSettingsFor / setSettingsFor / applyPreferencePatch / preferenceFor` |
| Transport | `settings.get` resolves for `s.caller.userId`; `settings.set` for the calling principal; `settings.updatePersonal` writes the owning user's rows (actor threaded through `SettingsHandler`) |

### Decisions made without a human (recorded here and on the issue)

1. **The blob's personal members are REMOVED, not left as a shared fallback.**
   Leaving them would keep one person's values readable by everyone at rest,
   which is the exit-audit item itself. After the clear, the fallback for an
   unset preference is the model's default — the brief's "instance blob's value
   as the fallback" with nothing personal left in it.
2. **Values are carried with `->`, not `->>`.** `->>` coerces to SQL scalars:
   three booleans would become integers and `sidebar.repoOrder` would stop
   round-tripping through `JSON.parse`. No count, schema or NOT NULL check can
   see that.
3. **Server-side consumers of personal leaves now name a user.** Notify,
   messaging, issues, sessions (`roles.*`, `autoContinue`) and superagent
   (`roles.superagent`) read `getSettingsFor(FIRST_ADMIN_USER_ID)` — spelled out,
   never defaulted, the shape `IssueService.broadcastViewer` uses. POD-315
   replaces the argument; nothing has to be re-found.
4. **`settings.changed` carries the writer's RESOLVED view.** Its subscribers
   react to `notifications.*` and `autoContinue.enabled`, which are personal now;
   the instance pair would make those changes invisible to them.
5. **`notifications.telegramChatId` is written for `setup.mint.userId`**, not for
   whoever polls — the same identity POD-1080's inbound binding uses. That
   ceremony was not touched or duplicated.

## Proving the instruments can say NO

Every mutant was applied to ONE thing, the manifest regenerated, the result
grepped back out of `drizzle-manifest.generated.ts`, and reverted with
`git checkout` from a committed tree.

| Mutant | Result |
|---|---|
| (a) delete the `INSERT..SELECT`, keep the DDL | **KILLED** — 10 of 12 cases red (a correctly-shaped empty table is not a pass) |
| (b) swap `roles.superagent.model` ↔ `roles.background.model` inside the copy | **KILLED** — 2 red, on the pairwise by-key-and-value comparison; grep-back confirmed the mutant reached the runner |
| (c) drop `WHERE user_id = ?` from the bulk read | **KILLED** — 3 cross-user cases red |
| (d) drop `WHERE user_id = ?` from the single-key read | **SURVIVED at first.** Real coverage gap: every other case resolved through the bulk read. Test added (`the SINGLE-KEY read is scoped too`), mutant re-applied, now **KILLED** |

Fixture non-vacuity is asserted, not assumed: all 18 string values distinct, the
one boolean pair that shares a parent holds opposite values, and instance-tier
preferences are asserted to survive in place so "removed 24 members" is
distinguishable from "replaced the row".

## Verification

- `bun run typecheck` — clean (needed `bun install` in the worktree first; without it tsgo resolves `@podium/*` from the MAIN checkout and reports another branch's errors).
- Targeted lane: `apps/server/src/{store,migrations,modules/settings,modules/notify,modules/messaging,modules/sessions,modules/issues,modules/superagent}`, `relay.test.ts`, `packages/model`, `packages/commands/src/settings`, runtime settings — all green (~1500 tests).
- Gates: `audit:settings` (+ `--probe`), `audit:rearch`, `audit:client-secrets`, `audit:telegram-binding`, `audit:machine-grants`, `lint:boundaries` (0 new), `check-no-nul-bytes`.
- **Runtime, against a real running server** (not a unit fake): booted `startServer` on a scratch state dir and drove `settings.get`, `settings.set`, `settings.updatePersonal`, `settings.updateInstance` over HTTP. The resulting database:

```
user:sole autoContinue.enabled       = true
user:sole notifications.ntfyTopic    = "runtime-check-topic"
user:sole roles.coding.model         = "runtime-opus"
user:sole sidebar.repoOrder          = ["/x","/y"]
user:sole sidebar.repoSort           = "alphabetical"
BLOB sidebar: {"repoSort":"lastUsed","repoOrder":[],"groupByRepo":false}   ← no personal value on the shared row
BLOB gitWorkflow.mergeStyle: "pr"   hibernation.memoryPct: 71             ← instance tier still shared
```

## Durable-class membership (POD-1211's gate, added after this branched)

`user_preferences` is declared in `DURABLE_STORES` naming the EXISTING row
`preferences-personal-keys`, whose visibility is `per-user-state` — the never-grantable family.
Argued rather than defaulted, and argued in both directions against POD-1211's own reasoning for
`settings-audit-trail`: `personal` is refused because it is GRANTABLE, `secret` is refused because
that class exists to never replicate and a preference must reach its owner's replicas. Full
adjudication: `docs/agents/pod-1213-preference-class-membership.md`.

Gate: `durable-class audit: clean — 88 durable stores, every one on the matrix or explained`.
Mutants: removing the entry reports `drizzle-table-undeclared`; mistyping the row id reports
`store-names-a-row-that-does-not-exist`.

## For POD-421's exit audit

"No cross-user leakage" for personal preferences is now storage-enforced, not
convention: the repository has no method that can read another user's row, the
wire read resolves for the caller, and the blob no longer holds a personal value
to leak. The audit's remaining question for this surface is whether any NEW
consumer reads `getSettings()` for a personal leaf — grep for `getSettingsFor`
to see the call sites that already ask the question.

## Not done, deliberately

- Per-user notification FAN-OUT (sending one person's notice to their own route
  rather than the sole account's) is ADR 9 D8 S3 / POD-315 work — the storage is
  keyed for it, the delivery loop still has one identity.
- The web client is unchanged: the wire shape is identical, and the save still
  posts the whole blob.
