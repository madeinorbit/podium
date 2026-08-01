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
