/**
 * POD-7115 — one principal's rows in memory, as every device store keeps them
 * (the in-memory, IndexedDB and SQLite adapters).
 *
 * A `Map` from row key (`entity\0entityId`) to row, to the code that stages and
 * publishes writes, so the stores' drafts and commits are unchanged. Inside, a
 * whole record is kept as its row, while a record held as its stub alone is
 * kept only in its record type's compact stub table (`stub-table.ts`), which
 * also holds the stub columns of every whole record of that type. The table is
 * what the replica reads stubs, children and references from, so the device
 * keeps one copy of the stubs in memory, not a row object per stub beside it.
 *
 * A stub row read back (`get`, iteration) is built from the table each time.
 *
 * POD-7159: the mirror is the store's RESIDENT SET, not a copy of the disk.
 * A whole record on disk that is not in memory keeps only its stub columns in
 * its table (`putStubOf`), so the stub table stays complete over every record
 * the device holds, while `get`, `has` and `mainRows` answer resident rows only.
 * `unload` takes a whole record out of memory and leaves its stub columns.
 */

import { recordOf } from '@podium/model'
import { stubFieldsOf } from './holdings'
import { SideMap } from './side-state'
import { StubTable, type StubTableReader } from './stub-table'
import type { EntityRecord } from './types'

const SEPARATOR = '\u0000'

/** Every row of one principal: whole records by key, stubs in their tables. */
export class RowMirror extends SideMap<string, EntityRecord> {
  private readonly tables = new SideMap<string, StubTable>('rowMirror.tables')

  /** The resident rows are side state: screens read them through the pool's tables (POD-7454). */
  constructor() {
    super('replica.rows')
  }

  /** A mirror holding `rows`. */
  static of(rows: Iterable<EntityRecord>): RowMirror {
    const mirror = new RowMirror()
    for (const row of rows) mirror.set(`${row.entity}${SEPARATOR}${row.entityId}`, row)
    return mirror
  }

  override get size(): number {
    let stubs = 0
    for (const table of this.tables.values()) stubs += table.stubOnlySize
    return super.size + stubs
  }

  override get(key: string): EntityRecord | undefined {
    const main = super.get(key)
    if (main !== undefined) return main
    const at = key.indexOf(SEPARATOR)
    if (at < 0) return undefined
    const entity = key.slice(0, at)
    return this.tables.get(entity)?.stubRecord(entity, key.slice(at + 1))
  }

  override has(key: string): boolean {
    if (super.has(key)) return true
    const at = key.indexOf(SEPARATOR)
    return at >= 0 && this.tables.get(key.slice(0, at))?.isStubOnly(key.slice(at + 1)) === true
  }

  override set(key: string, row: EntityRecord): this {
    // Map's constructor calls `set` before the subclass fields exist; the
    // mirror is never built from entries that way (see `of`).
    if (this.tables === undefined) return super.set(key, row)
    const fields = stubFieldsOf(row.entity)
    if (row.part === 'stub' && fields.length > 0) {
      super.delete(key)
      this.table(row.entity, fields).putStub(row)
      return this
    }
    super.set(key, row)
    if (fields.length > 0) this.table(row.entity, fields).put(row.entityId, row.value)
    return this
  }

  /**
   * POD-7159 — the stub columns of a whole record that is on disk and not in
   * memory (read from the disk index at start). Not a row: `get` and `has`
   * do not answer it.
   */
  putStubOf(entity: string, entityId: string, value: unknown): void {
    const fields = stubFieldsOf(entity)
    if (fields.length > 0) this.table(entity, fields).put(entityId, value)
  }

  /**
   * POD-7159 — take a whole record out of memory, keeping it on the device:
   * its stub columns stay in the table. Returns whether a resident row left.
   */
  unload(key: string): boolean {
    return super.delete(key)
  }

  /** Whether a whole record is in memory (a stub row is in its table, never here). */
  hasMain(key: string): boolean {
    return super.has(key)
  }

  /**
   * POD-7181 — the row kept by key, without building a stub row from its
   * table: what a read of resident rows asks (`get` builds one for a stub).
   */
  getMain(key: string): EntityRecord | undefined {
    return super.get(key)
  }

  override delete(key: string): boolean {
    const main = super.delete(key)
    const at = key.indexOf(SEPARATOR)
    if (at < 0) return main
    const table = this.tables.get(key.slice(0, at))
    if (table === undefined) return main
    const id = key.slice(at + 1)
    const stub = table.isStubOnly(id)
    table.remove(id)
    return main || stub
  }

  override clear(): void {
    super.clear()
    for (const table of this.tables.values()) table.clear()
  }

  // Iteration (a sweep, a snapshot, a scrub) is rare: it goes over a plain
  // map of every row, the stubs built from their tables.
  override entries(): MapIterator<[string, EntityRecord]> {
    return this.everyRow().entries()
  }

  override keys(): MapIterator<string> {
    return this.everyRow().keys()
  }

  override values(): MapIterator<EntityRecord> {
    return this.everyRow().values()
  }

  override [Symbol.iterator](): MapIterator<[string, EntityRecord]> {
    return this.everyRow().entries()
  }

  override forEach(
    callback: (value: EntityRecord, key: string, map: Map<string, EntityRecord>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, row] of this.everyRow()) callback.call(thisArg, row, key, this)
  }

  /** The whole records (`readEntities`): no stub among them. */
  mainRows(): EntityRecord[] {
    return [...super.values()]
  }

  /** The rows held as their stub alone (`readStubs`), built from the tables. */
  stubRows(): EntityRecord[] {
    const out: EntityRecord[] = []
    for (const [entity, table] of this.tables)
      for (const id of table.stubOnlyIds()) {
        const row = table.stubRecord(entity, id)
        if (row !== undefined) out.push(row)
      }
    return out
  }

  /**
   * The stubs of `entity`, whole records and stubs alike; `undefined` for a
   * record type without a stub. The same table as long as the mirror lives.
   */
  stubTable(entity: string): StubTableReader | undefined {
    const fields = stubFieldsOf(entity)
    return fields.length === 0 ? undefined : this.table(entity, fields)
  }

  private everyRow(): Map<string, EntityRecord> {
    const all = new Map<string, EntityRecord>(super.entries())
    for (const row of this.stubRows()) all.set(`${row.entity}${SEPARATOR}${row.entityId}`, row)
    return all
  }

  private table(entity: string, fields: readonly string[]): StubTable {
    let table = this.tables.get(entity)
    if (table === undefined) {
      table = new StubTable(fields, recordOf(entity)?.parentLink)
      this.tables.set(entity, table)
    }
    return table
  }
}
