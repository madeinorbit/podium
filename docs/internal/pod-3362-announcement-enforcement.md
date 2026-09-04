# Cache-invalidation announcements: the seam, the claim, and what should enforce it

POD-3362, 2026-09-04. Found by POD-3292.

## The two claims, separated

POD-3247 replaced a `prepare` wrapper that recognised writes by reading SQL text with an
announcement the store makes (`apps/server/src/store/table-writes.ts`). Two claims were made
about it, and only one was true of the code.

**The seam works when it is called.** Replacing the subscribed callback with a no-op fails both
writer tests in `apps/server/src/store/repos-read-cost.test.ts`. That is the reviewer's mutation
and it holds.

**The announcement was not guaranteed.** `TableWrites.wrote()` is a call a writer makes or does
not make. The same test file asserts, immediately *before* `tableWrites.wrote('repos')`, that a
bypassing write has left the held read stale — so a writer that stops one line short is a live
staleness bug, and nothing in the tree read the writer's source to ask.

The design record described the first claim in language that only the second could have earned.
An invariant claimed and not held is worse than one never claimed, because the next writer builds
on the claim instead of checking it. That wording is corrected in `store/table-writes.ts`,
`store/repos.ts` and the spec's "DO NOT DELETE `SessionStore.tableWrites`" paragraph, dated and
attributed in the spec's own correction convention.

## The decision: guard, not executor field

**Recommendation: the type-aware whole-tree guard. Refuse the executor-boundary version — refuse
it, not defer it.**

The brief frames it correctly: the executor already carries `intent`, so the question is whether
tables belong on the same object. They do not, and the reason is a property comparison rather than
a preference.

| | `intent` (already on `Statement`) | affected tables (proposed) |
|---|---|---|
| Domain | **Closed** — two values | **Open** — schema-sized, and variable per statement |
| Cost to the caller | **Zero.** The `QueryClient` method chosen *is* the declaration: `run`/`writeGet`/`writeAll` are writes, `get`/`all` are reads (`store/executor/driver.ts`, `queryClientOver`) | **A second hand-authored declaration** at every write site, derived from knowledge of the SQL the caller wrote |
| Completeness | N/A — one value, always present | **Required and unverifiable.** A statement touching two tables that names one is silently half-right |
| Failure mode when wrong | **Loud.** Wrong lane: past the single write slot, alongside a real writer, and on a driver with `openReader` onto a read-only connection | **Silent.** Stale rows served indefinitely — the exact failure being prevented |

A declaration whose failure mode is identical to the omission it replaces is not enforcement. The
strong version would move one forgettable call to one forgettable field at every write in the
store: strictly more places to forget, with the same silence, wearing the executor's authority.

Two further costs make it worse than neutral:

- **There is no slot for it under drizzle.** drizzle's async sqlite-proxy callback is fixed at
  `(sql, params, method)` (`drizzle-orm/sqlite-core/async/*`). `intent` survives that because the
  store wraps the client and the caller's method choice supplies it; tables cannot be recovered the
  same way. The only remaining route is inspecting SQL text — which is precisely the mechanism
  POD-3247 deleted, for being dialect-fragile and blind to writers on other handles. *Deriving*
  tables rather than declaring them is that same inspection under a new name.
- **It touches the executor's shape**, so it would have to be weighed against POD-3263's flip
  rather than landed beside it — buying a freeze-window argument for a guarantee it does not
  deliver. POD-3263 does not need to carry this.

### Cost of what was built instead

One rule in the existing boundary-lint family (`scripts/check-boundaries.ts`,
`cache-table-announcement`) plus its tests. No runtime change, no executor change, no new
dependency for the flip. The recurring cost is one line in `CACHE_OWNED_TABLES` when a new
repository starts caching a table — a declaration someone makes deliberately, which is the honest
shape for a fact that cannot be detected from source (a cache is a private field; the subscription
is a loop over string names).

Its **ceiling is stated in the rule rather than discovered later**: it reads source text, so a
table name assembled at runtime is invisible, a runtime branch that skips the announcement reads as
announced, and `.wrote(` is matched on any receiver. Resolving the declaring type is the
theoretically right answer and is refused on checkability, for the reason `check-boundaries.ts`
has already recorded twice (POD-3257, `TRANSACTION_OPENERS`): a name-matching scan cannot carry a
type. The rule is still worth having, because the failure it is written for is the *ordinary* one —
a new writer that never thought about a cache, spelled the way every other writer in the store is.

## What the rule checks

Every file under `apps/` and `packages/`, excluding tests, `apps/server/src/migrations/` (which
runs before any cache holds a read) and `apps/server/src/store/repos.ts` (held to the *opposite*
ordering by its own source scan): a write to `repos` or `repo_prefixes` must be followed by an
announcement naming that table.

**Both spellings**, because the epic has two: SQL text (`INSERT OR IGNORE INTO repos …`) and
drizzle's builder (`db.update(repos)`, where the string never appears). A rule that read only SQL
would go quiet at exactly the conversion wave that introduces the risk.

**Ordering, in the direction outside writers need.** Inside `ReposRepository` the drop goes
*before* the write; outside it the announcement goes *after*. Same window, read from two sides:
announcing first leaves the write itself inside the window a read can be taken in.

## Mutation evidence

The rule's correct count on this tree is **zero** — POD-3246 retired the last outside writer — so a
green proves it ran, not that it works.

**On the real tree, through the real lint.** A writer added at
`apps/server/src/modules/repos/mutation-probe.ts`, in both spellings, then removed:

```
$ bun run scripts/check-boundaries.ts
  [cache-table-announcement] apps/server/src/modules/repos/mutation-probe.ts:9: writes `repos`
  from outside apps/server/src/store/repos.ts, which holds a cached read of it, and never
  announces it. `listRepos()` would keep serving the pre-write rows indefinitely; that exact bug
  reached a live instance once (POD-1638). …
```

Adding `store.tableWrites.wrote('repos')` after the write drops it to zero. The whole-run violation
set is otherwise byte-identical to the same script at `HEAD`, so the rule contributes nothing to
the tree it ships with.

**As permanent fixtures**, `scripts/check-boundaries.test.ts` drives it against a forgetting writer
in each of nine spellings (`INSERT`, `INSERT OR IGNORE`, `UPDATE`, `UPDATE OR IGNORE`, `DELETE`,
`REPLACE`, and three builder forms), against an announcement that comes *before* the write, against
an announcement placed between two writes, and against an announcement naming the *wrong* table —
that last one being the counterfactual without which the rule would be about nothing. The
false-positive controls are live cases, not invented ones: `packages/model/src/annotations/matrix.ts`
really does hold ``'Repo / prefix (`repos`, `repo_prefixes`)'`` in a string literal, and
`stripComments` does not strip strings.
