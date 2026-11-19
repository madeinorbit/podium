// workspace-scoped (POD-6959)
/**
 * WHAT A ROW HOLDS, AS THIS STORE LAST WROTE OR READ IT [POD-6234].
 *
 * The session upsert names an indexed column in its ON CONFLICT set only when
 * the value changed, and "changed" needs something to compare against that is
 * the row as stored. The live session's durable baseline is not that: it can
 * differ from the stored row without a write (until POD-6646 a boot restore
 * held a row stored as `live` as `reconnecting`), and a rename compared against
 * the baseline would then skip a column the full write changes. So the store
 * keeps what its own writes sent and
 * its own reads returned, and answers "unknown" (write every column) whenever
 * it cannot be sure:
 *
 *   - Inside a span a write is STAGED until the outermost commit, because a
 *     rollback puts the row back. A staged value whose unit of work rolled back
 *     (its registration is dead) makes the row unknown, not the committed value:
 *     an outer span that carries on may have written the row before the inner
 *     one, and the committed value predates that.
 *   - A write with no span open autocommits after whatever transaction holds
 *     the write slot, so it can neither trust a value read before it queued nor
 *     record one in order. It is a full write and leaves the row unknown.
 *   - Any other writer of the table runs through {@link WrittenColumns.aside},
 *     which forgets the rows it touches (or all rows) and answers "unknown"
 *     for every row while it runs: one with no span open can run between a
 *     span's commit and that span's own continuation.
 *   - A read is recorded only with no span open (a span's read may show its
 *     own uncommitted writes) and only if nothing was written, promoted or
 *     forgotten between issuing it and recording it ({@link WrittenColumns.mark}):
 *     otherwise the row it returned may already be older than what is known.
 *
 * Re-sending the value a column already holds is a no-op for every expression
 * the upsert's set uses (a plain value, COALESCE keeping the first non-null,
 * CASE keeping `bound`), which is what makes skipping it exact.
 *
 * A miss costs one full write, never a wrong one, so the committed map is
 * bounded by dropping its oldest entry.
 *
 * ONE WRITER ONLY. This is memory of one process, so it is correct only while
 * this process is the only writer of the table: a write by another server
 * process on the same database, a later multi-process or Postgres deployment,
 * or a hand-run UPDATE is invisible here, and the next upsert would skip a
 * column that no longer holds the remembered value. Before a second writer
 * exists, disable it (answer unknown always, so every upsert sets every column)
 * or invalidate it across processes. Declared as a write hint in
 * docs/agents/server-data.md ("Caching", rule 7).
 *
 * OFF ON POSTGRES [POD-6983, POD-6958 design 2.12]. A Postgres store is the
 * deployment with more than one writer, and Postgres rewrites a row whole on
 * every UPDATE whatever its SET names, so there is nothing to save either: the
 * store builds it {@link WrittenColumns.forDialect} and, there, it is
 * {@link WrittenColumns.off}: it knows nothing, records nothing, and every
 * upsert sets every column.
 */

import type { StoreDialect } from './executor/binding'
import { applyAfterCommit, spanOpen } from './executor/executor'

type CommitRegistration = ReturnType<typeof applyAfterCommit>

export class WrittenColumns<V> {
  private readonly committed = new Map<string, V>()
  private readonly staged = new Map<
    string,
    { token: number; value: V; registration: CommitRegistration }
  >()
  private nextToken = 0
  private asideInFlight = 0
  /** Moves on every write, promotion and forget, so a read can tell it was overtaken. */
  private generation = 0

  constructor(
    private readonly label: string,
    private readonly limit = 4096,
    /** False: the hint is off (see the header). It knows nothing and records nothing. */
    private readonly enabled = true,
  ) {}

  /** A hint that is off: every row is unknown, so every write is a full write. */
  static off<V>(label: string): WrittenColumns<V> {
    return new WrittenColumns<V>(label, 0, false)
  }

  /** The hint for a store on `dialect`: on for SQLite, {@link off} for Postgres. */
  static forDialect<V>(dialect: StoreDialect, label: string): WrittenColumns<V> {
    return dialect === 'pg' ? WrittenColumns.off<V>(label) : new WrittenColumns<V>(label)
  }

  /** What the row holds, or `undefined` when this store cannot know. */
  get(id: string): V | undefined {
    if (!this.enabled || !spanOpen() || this.asideInFlight > 0) return undefined
    const entry = this.staged.get(id)
    if (entry === undefined) return this.committed.get(id)
    if (entry.registration.live()) return entry.value
    this.forget(id)
    return undefined
  }

  /** Taken before a read is issued and handed to {@link read} with its rows. */
  get mark(): number {
    return this.generation
  }

  /** Record rows a read issued at `mark` returned, when that is safe (see the header). */
  read(rows: Iterable<readonly [string, V]>, mark: number): void {
    if (!this.enabled || spanOpen() || this.asideInFlight > 0 || this.generation !== mark) return
    for (const [id, value] of rows) if (!this.staged.has(id)) this.commit(id, value)
  }

  /** Record a write of `value` that just ran. */
  wrote(id: string, value: V): void {
    if (!this.enabled) return
    if (!spanOpen()) {
      this.forget(id)
      return
    }
    if (this.staged.size >= this.limit) this.forgetAll()
    this.generation++
    const token = ++this.nextToken
    // Closes over `value`: reading the staged slot back at commit would
    // promote whatever a later write staged there.
    const registration = applyAfterCommit(() => {
      if (this.staged.get(id)?.token !== token) return
      this.staged.delete(id)
      this.generation++
      this.commit(id, value)
    }, this.label)
    this.staged.set(id, { token, value, registration })
  }

  /** Run a write of `ids` (`'all'`: rows unknown) made some other way: each
   *  is written whole next time. */
  async aside<T>(ids: readonly string[] | 'all', write: () => Promise<T>): Promise<T> {
    this.asideInFlight++
    this.generation++
    try {
      return await write()
    } finally {
      if (ids === 'all') this.forgetAll()
      else for (const id of ids) this.forget(id)
      this.asideInFlight--
    }
  }

  /** The row may not hold what was recorded: write it whole next time. */
  forget(id: string): void {
    this.generation++
    this.staged.delete(id)
    this.committed.delete(id)
  }

  private forgetAll(): void {
    this.generation++
    this.staged.clear()
    this.committed.clear()
  }

  private commit(id: string, value: V): void {
    this.committed.delete(id)
    this.committed.set(id, value)
    if (this.committed.size > this.limit) this.committed.delete(this.committed.keys().next().value!)
  }
}
