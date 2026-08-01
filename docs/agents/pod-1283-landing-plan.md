# POD-1283 landing plan — measured 2026-08-01 03:05

POD-1283 is the sole blocker for Phases 4 and 6. It is the largest merge left in
the rewrite. This file exists so the landing does not depend on one session's
memory. **Re-measure before trusting any number here** — it was true at
integration `50cbca33` and POD-1283 `58da115a`.

## Conflict surface (measured, not estimated)

    merge-base                    git merge-base issue/279-integration issue/1283-phase-3-policy-completion
    POD-1283 touched              183 files
    integration touched since     115 files
    OVERLAP                        12 files

The 12:

    apps/server/src/migrations/drizzle-manifest.generated.ts    <- REGENERATE, do not merge
    scripts/rearch-audit-baseline.json                          <- REGENERATE, do not merge
    apps/server/src/modules/sessions/service.ts                 <- 5,893 lines, read the resolution
    apps/server/src/modules/sessions/command-plane.ts + .test.ts
    apps/server/src/modules/sessions/oracle-handoff.test.ts
    apps/server/src/relay.test.ts, relay.machines.test.ts
    apps/web/src/features/machines/HostIndicators.tsx
    packages/client-core/src/engine/engine.ts + .test.ts
    scripts/rearch-audit.test.ts

## The two files that must be REGENERATED, never hand-merged

**`drizzle-manifest.generated.ts`** is what the tests execute, and drizzle applies
migrations BY NAME. Both sides added migrations:

    POD-1283      20260731195047_phase-3-policy-ownership
    integration   20260731221009_feed-identity-singleton
                  20260731225445_drop-dead-sync-feed

POD-1283's timestamp (19:50) is EARLIER than both of integration's, so the merge
inserts a migration *into the past*: on a fresh DB it runs first, on an existing
DB the ledger runs it last.

**Checked, and it is benign for schema outcome:** policy-ownership is pure
`ALTER TABLE ... ADD COLUMN` across issues/sessions/automations/superagent/etc,
and it references `sync_feed` ZERO times — so it cannot collide with
drop-dead-sync-feed. Fresh and existing databases converge on the same schema.

**What is NOT benign is the snapshot chain.** POD-1283's `snapshot.json` was
generated from a base without integration's two migrations. After the merge the
chain is inconsistent and the next `drizzle-kit generate` will diff against the
wrong ancestor. Regenerate the manifest and re-derive the snapshot after merging;
do not accept the auto-merged versions.

**`scripts/rearch-audit-baseline.json`** is a MEASUREMENT, not source. Both sides
changed exactly 1 line. Never hand-merge two baselines and never compare two
baseline files as if they were two readings of one instrument. Regenerate with one
binary over the merged tree.

## Standing checks for this merge specifically

1. Ambient principals: `git diff HEAD~1 HEAD | grep -E '^\+.*(FIRST_ADMIN_USER_ID|OPERATOR)'`.
   POD-1283's whole purpose is REMOVING ambient minting, so a new production site
   here means the merge undid its work. Test-fixture actors are fine and expected.
2. `bun run typecheck --force` must be 23/23 with **0 cached**. A cached pass is
   not evidence.
3. Read the resolutions in `sessions/service.ts` and `client-core/engine.ts` by
   hand. Two defects this run existed in NEITHER branch alone — a floating
   unawaited promise and an import that shadowed a local test helper. A clean
   auto-merge does not report shadowing.
4. Re-run `bun scripts/rearch-audit.ts --phase POD-314` — it is at 0 on POD-1283
   (was 18 at the gate). If it comes back non-zero after the merge, the merge
   reintroduced sites.

## Migration hygiene reminder

There are no down migrations here, and migrations apply by name. Verify against
`drizzle-manifest.generated.ts` — that file, not the directory listing, is what
runs in tests.

---

## UPDATE 2026-08-01 05:05 — the surface doubled, and a rename/modify trap appeared

Re-measured at integration `008fb9e1`, POD-1283 `8ebfed9a`:

    POD-1283 touched              200 files  (was 183)
    integration touched since     165 files  (was 115)
    OVERLAP                        24 files  (was 12)

New in the overlap since 03:05: `relay.ts`, `router.ts`, `server.ts`,
`queries.ts`, `superagent/service.ts`, `superagent/tools.ts`, `oracle-support.ts`,
`oracle-errors.test.ts`, `oracle-presence.test.ts`, `router.test.ts`,
`superagent-headless.test.ts`, `relay.conversation-registry.test.ts`.

### THE TRAP: oracle-presence.test.ts is a MODIFY/DELETE across two branches

- **POD-393 DELETES it.** It renamed the concept presence -> session-state, so
  `oracle-presence.test.ts` becomes `oracle-session-state.test.ts`. Verified
  faithful at the time: 23 tests -> 23 tests, 8 exports -> 8 exports.
- **POD-1283 MODIFIES it**, as part of the policy work.

Git will raise a modify/delete conflict, and **the natural resolution — accept the
delete — silently discards POD-1283's edits.** Nothing reports that. It is the
same shape as the two defects this run that existed in neither branch alone.

**Whichever of the two lands second, the edits must be carried BY HAND into
`oracle-session-state.test.ts`.** Do not resolve this conflict by choosing a side.
Concretely: before resolving, capture POD-1283's diff for that file

    git diff <merge-base> issue/1283-phase-3-policy-completion -- \
      apps/server/src/modules/sessions/oracle-presence.test.ts

and re-apply each hunk to the renamed file, then confirm the test count did not
drop. The same check that validated POD-393's rename (count the `it(`/`test(`
calls on both sides) is what proves nothing was lost here.

The same caution applies in weaker form to `oracle-support.ts` and
`oracle-errors.test.ts`, which POD-393 also touched during the rename.

### Suggested landing ORDER

Land POD-393 and POD-394 (the extractions) BEFORE POD-1283 if they are ready
first, because their changes are structural and mostly additive, and POD-1283's
are semantic edits that are easier to re-apply onto a settled structure than the
reverse. But do not delay POD-1283 for them — it is the phase blocker, and a
hand-carried rename is a known, bounded cost.

---

## UPDATE 2026-08-01 08:05 — the remaining delta is small, but the rename is NOT blanket

Measured at integration `2d2bcaed`, POD-1283 working tree (uncommitted).

**Good news: POD-1283 has already reconciled forward through POD-393 and POD-394.**
Its working tree already contains `sessions/inbox.ts` (508 lines) and
`sessions/session-state/service.ts`. Those two extractions are NOT part of the
remaining delta.

**What it still lacks is only the two client-core landings:**

    POD-1313          packages/client-core/src/transport/ -> socket-transport/,
                      plus the ./socket-transport export and the CLEAN BREAK
                      (socket symbols removed from the ./transport barrel).
    POD-400 follow-up legacy feed cursor/epoch/gap/healing moved under replica/
                      (legacy-wire-v1-feed, new legacy-wire-v1-binding), boundary
                      hardened to forbid transport importing replica.

POD-400's replica files are NEW, so they add rather than conflict. The real work is
the import paths.

### THE TRAP: do NOT sed a blanket rename

**30 files on POD-1283's tree import the old `transport` path**, including
`engine/engine.ts`, `engine/wiring.ts`, `engine/types.ts`, `client-core/index.ts`,
`apps/web/src/lib/kernelReplica.ts`, `ConnectionIndicator.tsx`,
`MobileClientProvider.tsx` and several terminal-client tests.

They do NOT all move. The split is by SYMBOL, not by file:

| importing… | belongs at |
|---|---|
| `ServerOrigin`, `ServerConfig`, `LocationLike`, `parseServer`, `parseServerOrigin`, `resolveServerConfig` | `./transport` — UNCHANGED |
| `SocketHub`, `FeedSinkPort`, subscriptions, echo-latency, anything from the socket module | `./socket-transport` |

A blanket `s/transport/socket-transport/` will wrongly move the origin-parser
imports and break three known consumers (`MobileClientProvider.tsx`,
`apps/web/src/app/trpc.ts`, `apps/mobile/src/client/trpc.ts`) which legitimately
import `ServerConfig` from `./transport`.

Because POD-1313 chose a CLEAN BREAK (no deprecated alias), a wrong resolution
FAILS LOUDLY at typecheck rather than silently resolving. That is the design
working as intended — trust typecheck here, and run it with `--force` so a cached
pass cannot hide the mistake.

### Reminders that still stand

- `drizzle-manifest.generated.ts` and `scripts/rearch-audit-baseline.json` are
  MEASUREMENTS. Regenerate; never hand-merge.
- Typecheck target is **22/22 with 0 cached**.
- Check EVERY sibling file for a defect found in one — a duplicate import in
  `wiring.ts` slipped through this run precisely because it was only checked in
  `engine.test.ts`.
