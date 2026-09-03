/**
 * The store's per-table write notification (POD-3247).
 *
 * A repository that holds a read across calls has to know when that read stops
 * being true. Inside the repository that is a call it can be made to owe — a
 * source guard can read the file and fail a write path that skips it. Outside it,
 * there is nothing to read: the boot upgrades build SQL from `sqlite_master` on
 * the raw handle, and the async query layer will run its statements through an
 * executor the repository never sees.
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
