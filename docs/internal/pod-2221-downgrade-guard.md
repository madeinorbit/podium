# A downgrade the database has outgrown is refused, not applied (POD-2213)

The merge blocker the acceptance drive found: converging a machine to a version
OLDER than the one it runs bricked the install. Reproduced twice, deterministically,
in about four seconds. Evidence: `docs/internal/pod-2157-evidence/stable-install-downgrade.txt`.

## What was actually wrong

Not the downgrade, and not the downgrade protection. Both are deliberate, and both
are right. The bug was that they never met.

- `packages/protocol/src/update/convergence.ts` converges to target **equality**, up or
  down, because a planner that only moves forward makes rollback structurally
  impossible.
- §13 of `2026-08-04-coherent-update-story-design.md` says a database whose schema is
  newer than the running code **must refuse to open**, and §13.3 says a schema-advanced
  rollback must **halt and report** rather than proceed.

The first was executed without consulting the second, so the daemon swapped the install
its co-located server runs from, the older server refused the migrated database, and the
supervisor crash-looped through all eight generations. From there nothing inside Podium
can help: the thing that would apply a fix is the server that will not start, and
`podium update` answers "already up to date" because the feed really has nothing newer.

## The fix, and where it sits

**Before anything is fetched**, a daemon asks one question: can the build I am about to
swap in open THIS machine's database? Answering it needs two facts.

| Fact | Where it comes from |
|---|---|
| What this database has applied | its own drizzle ledger, read read-only (`packages/runtime/src/migration-ledger.ts`) |
| What the target build defines | declared by whoever published the target (`schema.migrations` on `UpdateTarget`) |

Publishers declare from the artifact, never from themselves:

- the release manifest reads the migration folder names out of the tree being released
  (`readDefinedMigrations` in `scripts/release.ts`, which **throws** rather than
  publishing silence — a release that cannot say what it opens is one nothing can ever
  safely roll back to);
- the development publisher reads them from the **commit it advertises**
  (`migrationsAtRevision`, a `git ls-tree` of that sha), never from the build it happens
  to be running. A checkout moving backwards is the one case where those two differ, and
  that difference is exactly this bug.

The gate itself is `refuseSchemaRegression` in `apps/daemon/src/convergence.ts`, next to
the POD-2210 refusal it is modelled on, and it lands in the same place in `applyGrant`:
after `already-current`, before `downloading`.

## Both arms

| Case | Result |
|---|---|
| Machine holds no database (every remote worker) | converges, ungated — §13.3, "a daemon owns no database" |
| Nothing applied yet | converges, ungated |
| Downgrade whose schema did not advance | **converges** — the rollback the expand-only policy keeps cheap |
| Downgrade past a migration the target lacks | refused `schema-advanced`, naming the migration |
| Target that does not declare its schema | refused `schema-unknown` |
| This machine's ledger could not be read | refused `schema-unreadable` — fail closed |

All three refusals keep the machine **running on the version that works**, in the same
honest half-way state POD-2210 chose: nothing fetched, nothing swapped. Each is a
sentence with a stable token, and `describeUpdateFailure` in `apps/web` turns it into
copy whose next action is not "try again" — because the machine is fine.

## What Podium cannot do, said plainly

Rolling back **across** a migration needs a database restore by hand
(`docs/data-and-upgrades.md`). Podium will not do it for you, and the refusal says so:
restoring silently would discard every write made since the schema advanced. That is
§13.3's rule, stated where a person actually meets it.

## Honest limits

- Every release published **before** this change declares nothing, so a machine with a
  database now refuses to converge to one. That includes the exact move the acceptance
  drive used to prove feed delivery end to end (`dev+03a2892` → `0.1.3`). The proof
  path for that arm is now either a machine with no database or a target that declares
  its schema. This is a deliberate trade: unproven is treated as unsafe, because the
  machine that guesses wrong cannot start and cannot update itself back.
- A declaration is a claim by the publisher, trusted exactly as much as the rest of the
  manifest (its URLs and digests already are). The artifact signature does not cover it.
- The manifest grows by the migration list — 75 names, about 3 KB today.
