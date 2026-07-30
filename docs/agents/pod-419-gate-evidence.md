# POD-419 — client scrub migration + replica/outbox audit: gate evidence

Branch `issue/419-3-7b-client-scrub-migration-replica-outb`, based on
`issue/279-integration`. No rebase, no merge of main or a sibling.

## The acceptance criteria, each one answered

| AC | Where | Verdict |
|---|---|---|
| **Server storage moves secrets to the server-only store** | `apps/server/src/migrations/drizzle/20260730224810_server-secret-store/`, `store/server-secrets.ts` | met — the five classified secrets are lifted out of the `meta['settings']` JSON blob into `server_secrets` (key, value, updated_at) and REMOVED from the blob. Every consumer reads the keyed store. |
| **One-shot scrub of existing client replicas and outboxes (historical rows included)** | `packages/model/src/settings/scrub.ts`, `packages/sync/src/adapters/secret-scrub.ts` + both adapters' open paths | met — every row of every region of the IndexedDB and mobile-SQLite replicas, in every outbox state including terminal and dead-lettered. |
| **Audit proves zero secret material on any client after upgrade** | `scripts/audit-client-secrets.ts` (+ `.test.ts`), `packages/sync/src/adapters/secret-scrub.test.ts` | met — paired instruments: source-text census with `--probe`, and a runtime one that seeds a real store and reads it back through its own connection. |
| **Captured-real-replica migration test green** | `apps/server/src/migrations/server-secret-store.test.ts` | met — 12 cases against a REAL pre-migration database, mutation-verified twice. |

## The property being enforced, and what was already true

**A server-owned secret is never REPLICATED and never QUEUED.**

Checked before asserting, per the brief. POD-420 left `offline-eligible` as a
DECLARATION with no outbox executor behind it, and that is still the case: no
client executor dispatches a settings write, so nothing enqueues one today. The
never-queued half is held by the DELIVERY CLASS (`online-sensitive` ⇒ not
offline-eligible ⇒ cannot be enqueued), not by anything this issue added — and
deliberately not by a payload detector, because a detector that misses one key
fails open.

So this issue owns the half nothing held: material ALREADY AT REST. The honest
division, stated so nobody reads more into the gate than it proves:

- **at rest, from an earlier build** → the scrub, run at every store open;
- **new writes** → the delivery class (POD-420);
- **there is no third mechanism.** A client that stages a row containing
  material AFTER open keeps it until the next open. That is not a hole this
  issue can close without building the payload detector ADR 1 D6 rejects.

## The migration, and the hazard it was written against

`drizzle-kit generate` emitted the `CREATE TABLE` and **nothing else** — the
POD-1076 shape verbatim, which shipped as three correctly-shaped EMPTY tables
with no error and total silent loss. The file is therefore hand-edited, and the
copy is before the clear both textually and in execution order.

```sql
CREATE TABLE `server_secrets` ( `key` text PRIMARY KEY, `value` text NOT NULL, `updated_at` text NOT NULL );
--> statement-breakpoint
INSERT OR IGNORE INTO `server_secrets` (`key`, `value`, `updated_at`)
SELECT `key`, `value`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (
  SELECT 'apiKeys.openrouter' AS `key`, json_extract(`value`, '$.apiKeys.openrouter') AS `value` FROM `meta` WHERE `key` = 'settings' AND json_valid(`value`)
  UNION ALL … (five)
) WHERE `value` IS NOT NULL AND `value` <> '';
--> statement-breakpoint
UPDATE `meta` SET `value` = json_remove(`value`, '$.apiKeys.openrouter', …) WHERE `key` = 'settings' AND json_valid(`value`);
```

`json_remove`, not `json_set(…,'')`: a blanked key is indistinguishable from one
that never held anything and leaves an address for a later write to fill.

**NOT asserted: that this migration is last.** Siblings land migrations
concurrently and pinning "last" makes a green test a function of merge order.

## Mutation evidence — 4 applied, 4 killed, 0 invalid

Each verified before running: the anchor matched exactly once, the file hash
changed, grep-back confirmed the new text, only the target was dirty, and the
mutant compiled/applied. The manifest was regenerated after each SQL edit —
without that the mutant never reaches the runner and reads as a survivor.

| # | mutant | result |
|---|---|---|
| A | delete the `INSERT … SELECT` (keep the `UPDATE`) — the POD-1076 shape | **killed**: 6 cases, incl. `carries every configured secret across BY KEY AND VALUE` |
| B | swap two same-typed keys in the copy (`apiKeys.anthropic` ← `$.apiKeys.openai`) | **killed**: 4 cases; the pairwise assertion is the only one that can see it |
| C | revert the plain-object predicate to the naive `typeof v === 'object'` | **killed**: the model's opaque-leaf case AND the adapter's `Date` survivor assertion |
| D | scrub only `state === 'queued'` outbox rows | **killed**: `removes material from EVERY region and EVERY outbox state` (3 ≠ 5) |

Mutant B's first verification greps read `$` as a regex anchor and reported
`0` matches on a mutant that HAD applied — a broken instrument, not a survivor.
Re-verified with `grep -F` and a literal one-line diff before the kill was
accepted.

## Three defects found by the instruments, not by review

1. **A `Date` satisfies a naive plain-object check.** The scrub's walker was
   rebuilding structured-clone values as `{}` — it would have DESTROYED replica
   rows while truthfully reporting that no secret remained. No test of "is the
   secret gone" can catch that; only a test of what SURVIVED. Both fixtures now
   carry a `Date`, nested arrays and unicode through and assert byte-identity.
2. **The audit's own `--probe` failed three ways at once.** It read inside string
   literals, so it flagged `store.secrets.get('apiKeys.openai')` — the correct
   call — as loudly as the defect, and reported the migration SQL that MOVES the
   material as a leak. Its wired-adapter fixture supplied one of two adapters, so
   the clean case reported the other missing. And `import.meta.dir` is Bun-only,
   so the gate's own lane test could not even import it: `--probe` alone would
   never have found that.
3. **`'dead-lettered'` where the vocabulary says `'dead-letter'`.** Vitest passed
   — the literal was only carried through as data, so the fixture asserted its
   own typo. The workspace typecheck caught it.

## Verification

Both typechecks, instrument probed each time (a `@ts-expect-error` with nothing
to suppress must report TS2578 — it did, at `store/server-secrets.ts(140,1)` and
`adapters/secret-scrub.ts(141,1)`).

| lane | result |
|---|---|
| `bun run typecheck --force` (workspace) | **23 successful, 23 total; `Cached: 0 cached`** |
| `bunx tsgo --noEmit` in `apps/server` | exit 0 |
| `bunx tsgo --noEmit` in `packages/sync` | exit 0 |
| unit: `packages/{sync,model,runtime,commands}` + `scripts` | **132 files, 2186 tests passed** |
| unit: `apps/server` (full) | **210 files passed; 3071 tests passed, 1 skipped** (286s) |
| `bun scripts/check-boundaries.ts` | OK — 56 allowlisted, 0 new |
| `bun run audit:rearch` | OK — 29 items, 225 sites (baseline exact) |
| `bun scripts/check-no-nul-bytes.ts` | OK |
| `bun run migration:check` | Everything's fine |
| `bun run migration:manifest` | regenerated, committed |
| all 15 `audit:*` gates (incl. the new `audit:client-secrets`) | OK |

`apps/web` is EXCLUDED from `vitest.unit.config.ts`, so a run filtered to its
settings screens prints *"No test files found"* and exits 0 — the false green the
ledger names. It is reported here rather than counted as a lane: this diff
touches no `apps/web` file (`git diff --name-only issue/279-integration...HEAD`
has zero matches under `apps/web`), so the claim there is MECHANISTIC — the
changed code is disjoint from that app's sources — not measured.

NO RED WAS OBSERVED IN ANY LANE THIS ISSUE RAN, so none of the known-red list is
being invoked.

## Decisions taken at forks (no human in the loop)

Resolved from ADR 1 D6 and `docs/multi-user-readiness.md`; each is also recorded
at its declaration site and in the commit that made it.

- **The scrub runs on EVERY OPEN, not in a version-gated one-shot arm.** A store
  already at the new version never re-enters the arm, so material arriving later
  (a build with a regression, a backup restored from before the upgrade) would
  never be removed. A secret at rest is not a schema shape; it can come back.
- **It lives in `packages/sync`, not in the clients.** No new `apps/web` or
  `apps/mobile` import, so POD-307 can decide the client→sync platform edge
  either way without touching this diff.
- **Every dependency added for the relocation is REQUIRED, not optional.** An
  omitted injection would silently disable Telegram or every one-shot completion
  on an instance that HAS the material configured. The compiler named all nine
  call sites; a default would have named none.
- **`llmClient` takes one resolved key, not the `apiKeys` record.** A function
  that takes every key can be handed the blob again.
- **The repository has no bulk value accessor.** A
  `Record<ServerSecretKey, string>` getter is how the material gets back into a
  blob something then serialises — this issue's own defect, one layer down.
- **POD-420's "a removal is a change" test is RE-EXPRESSED, not deleted.** Every
  client is now served a blob whose secret members are absent and posts back `''`
  on every ordinary preference save; reading that as a clear would delete every
  secret on the instance the first time anyone changed a sidebar setting. The
  blob now cannot express a clear at all — strictly stronger — and
  `assertNoSecretChange` compares against the KEYED STORE, so a stale tab posting
  back what it was served is a round-trip rather than a rotation.
- **`updated_at` on a lifted row is the LIFT time and says so.** The blob never
  recorded a rotation time (POD-420's recorded gap), so none exists to carry.

## What was deliberately NOT done

- **The legacy secret members are still declared on `PodiumSettings`.** Removing
  them would make every stale read a compile error — the strongest form of this
  property — but POD-418 keeps them so `classification.ts` stays TOTAL over the
  blob that exists, and the runtime reconciliation asserts both directions. That
  removal is a separate change once nothing reads them; `audit:client-secrets` is
  the census that makes it safe to make. Recorded as deferred on the issue.
- **The settings UI still binds inputs to those members** (four files, now
  rendering empty strings). That is POD-421's presence/fingerprint surface. Each
  is a NAMED_SITE in the gate with its owning issue, checked in both directions
  so POD-421's removal must ratchet the census DOWN.
- **No payload detector on the outbox.** ADR 1 D6 says the refusal must be by
  CLASS; a detector that misses one key fails open.
- **`settings.get` is not re-shaped into a presence projection.** It no longer
  carries material (there is none in the blob), and `SettingsService`
  `secretPresenceList()` is the read POD-421 renders. Contracting that read is
  POD-421's, per POD-420's recorded boundary.
