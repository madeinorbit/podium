/**
 * The store's per-table write notification (POD-3247).
 *
 * A repository that holds a read across calls has to know when that read stops
 * being true. Inside the repository that is a call it can be made to owe — a
 * source guard can read the file and fail a write path that skips it. Outside it,
 * there is nothing FOR THE REPOSITORY to read: the boot upgrades build SQL from
 * `sqlite_master` on the raw handle, and the async query layer will run its
 * statements through an executor the repository never sees.
 *
 * THIS IS A COOPERATIVE SEAM, AND THE ORIGINAL WORDING OVERSTATED IT (POD-3362,
 * from POD-3292's review). {@link TableWrites.wrote} is a call a writer makes or
 * does not make; nothing in the type system requires it, and a writer that omits
 * it leaves the registry serving pre-write rows for the life of the process. The
 * two claims are separate and only the first was ever true of the code:
 *
 *   THE SEAM WORKS WHEN CALLED. Replacing the subscribed callback with a no-op
 *   fails both writer tests in `store/repos-read-cost.test.ts`.
 *
 *   THE ANNOUNCEMENT IS NOT GUARANTEED. The same file asserts, one line BEFORE
 *   `wrote('repos')`, that a bypassing write has left the held read stale. A
 *   writer that stops there is a live staleness bug and nothing in this class
 *   can tell.
 *
 * What closes the gap is a CHECK rather than a construction:
 * `scripts/check-boundaries.ts`'s `cache-table-announcement` rule scans every
 * file under `apps/` and `packages/` — excluding the migrations, which run before
 * any cache holds a read, and `store/repos.ts`, which is held to the opposite
 * ordering by its own scan — and refuses a write to a cache-owning table, in SQL
 * text or through drizzle's builder, that no announcement follows. Its ceiling is
 * source text: a table name assembled at runtime is invisible to it. Prefer
 * "guarded" over "cannot be bypassed" when describing this, in a comment or in
 * the spec; an invariant claimed and not held is worse than one never claimed,
 * because the next writer builds on the claim instead of checking it.
 *
 * MAKING IT UNAVOIDABLE AT THE EXECUTOR — `Statement` carrying its affected
 * tables so the executor announces them — was considered and NOT recommended
 * (POD-3362). Write intent is already on that object and belongs there: it has
 * two values, it costs the caller nothing (the `QueryClient` method chosen
 * IS the declaration), and getting it wrong is loud. An affected-table list has
 * none of those properties — it is open-ended, it has to be authored per
 * statement, it has to be COMPLETE to be worth anything, and an incomplete one
 * fails exactly as silently as forgetting the announcement does. It would move
 * one forgettable call to one forgettable field at every write in the store.
 *
 * THE REPOS CACHE USED TO ANSWER THIS BY INSPECTING SQL TEXT — a `prepare`
 * wrapper that dropped the cache when the statement it was handed looked like a
 * write to `repos`. It only ever saw statements prepared on ITS handle, in a
 * dialect it could parse, so both of those writers were invisible to it: the
 * first (the machine-identity upgrade) was a live correctness bug, and the second
 * has not been written yet. This replaces the inspection with an announcement the
 * store makes.
 *
 * DELIBERATELY NOT A GENERAL EVENT BUS. Synchronous delivery, no unsubscribe, no
 * payload, no ordering guarantee between listeners: the only thing a listener may
 * do is drop state it is holding. Anything a listener could WANT the payload for —
 * which rows changed, in what order — is a read, and a read belongs after the
 * announcement, not inside it.
 *
 * The table name is a plain string rather than a union of the schema's tables.
 * Most tables have no listener and never will, so a union would have to name all
 * of them to say nothing about most; an announcement for a table nobody listens
 * to is the ordinary case and costs one map lookup.
 */
export class TableWrites {
  private readonly listeners = new Map<string, (() => void)[]>()

  /** Run `listener` whenever a write to `table` is announced. */
  subscribe(table: string, listener: () => void): void {
    const existing = this.listeners.get(table)
    if (existing) existing.push(listener)
    else this.listeners.set(table, [listener])
  }

  /** Announce that `tables` have been written. */
  wrote(...tables: string[]): void {
    for (const table of tables) for (const listener of this.listeners.get(table) ?? []) listener()
  }
}
