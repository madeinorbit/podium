/**
 * POD-7094 — the stubs in memory as a compact table (design POD-7059,
 * "Parts": the terminal colours references while it paints and needs the
 * answer at once).
 *
 * Every issue the device holds has a stub: its reference, state and parent,
 * picked from the whole record or held at stub level only. This table keeps
 * the declared stub fields of each one in columns (one array per field, the
 * strings interned), with an index by parent and by reference, and is kept
 * current record by record from the replica's own events. Reading a stub,
 * an issue's children or the issue at a reference costs a lookup; nothing is
 * rebuilt over every row when the feed changes something else. It is the one
 * thing on the device that grows with history, as the design accepts.
 *
 * POD-7115: it is also the only copy in memory of a record held as its stub
 * alone. The device store keeps such a row here (`putStub`), with the few row
 * fields a stub row has (feed number, revision, as-of), and gives the row
 * back built from the columns (`stubRecord`). A whole record keeps its own
 * row in the store's map; here it only has its stub columns.
 */

import { SideMap } from './side-state'
import type { EntityRecord, StubRow } from './types'

type Value = string | number | boolean | null

/** Fields with few distinct values: their strings are shared, not copied per row. */
// side-state: declaration: field names, fixed
const SHARED = new Set(['repoId', 'stage', 'closedReason', 'audience'])

/** What a reader of the stubs needs: the replica and the loader read only this. */
export interface StubTableReader {
  /** Bumped whenever a stub field of any row changed. */
  readonly version: number
  readonly size: number
  has(id: string): boolean
  stubOf(id: string): Readonly<Record<string, unknown>> | undefined
  childrenOf(parentId: string): readonly string[]
  idAt(repoId: string, seq: number): string | undefined
  rows(): readonly StubRow[]
}

/** One record type's stubs, by id. */
export class StubTable implements StubTableReader {
  private readonly slots = new SideMap<string, number>('stubTable.slots')
  private readonly ids: (string | undefined)[] = []
  private readonly free: number[] = []
  /** Column per declared field (`id` excepted: it is `ids`). */
  private readonly columns = new SideMap<string, (Value | undefined)[]>('stubTable.columns')
  private readonly strings = new SideMap<string, string>('stubTable.strings')
  /** Parent id → child ids, when the record type declares a parent field. */
  private readonly children = new SideMap<string, Set<string>>('stubTable.children')
  /** `repoId:seq` → the ids holding that reference (normally one). */
  private readonly references = new SideMap<string, Set<string>>('stubTable.references')
  private childLists = new SideMap<string, readonly string[]>('stubTable.childLists')
  private rowsCache: { readonly version: number; readonly rows: readonly StubRow[] } | undefined
  private changes = 0
  // A row held as its stub alone: its slot is marked, and its row fields are
  // columns too, so no record object is kept per stub.
  private readonly stubOnly: (true | undefined)[] = []
  private stubCount = 0
  private readonly feedSeqs: (number | undefined)[] = []
  private readonly revisions: (number | undefined)[] = []
  private readonly asOfs: (number | undefined)[] = []
  private readonly originIds: (string | undefined)[] = []
  private readonly causationIds: (string | undefined)[] = []
  private readonly mutationIds: (string | undefined)[] = []
  /** A stub value the columns cannot give back as it came (a field not declared, say). */
  private readonly verbatim = new SideMap<string, unknown>('stubTable.verbatim')

  constructor(
    private readonly fields: readonly string[],
    private readonly parentField: string | undefined,
  ) {
    for (const field of fields) if (field !== 'id') this.columns.set(field, [])
  }

  /** Bumped whenever a stub field of any row changed. */
  get version(): number {
    return this.changes
  }

  get size(): number {
    return this.slots.size
  }

  /** Rows held as their stub alone (`putStub`). */
  get stubOnlySize(): number {
    return this.stubCount
  }

  /** Hold `id`'s stub from a record value (whole or stub level). */
  put(id: string, value: unknown): void {
    const slot = this.write(id, value)
    if (this.stubOnly[slot] === true) this.clearRow(id, slot)
  }

  /**
   * Hold a row the device keeps as its stub alone: the stub columns and the
   * row's own fields. The store gives it back with {@link stubRecord}.
   */
  putStub(row: EntityRecord): void {
    const id = row.entityId
    const slot = this.write(id, row.value)
    if (this.stubOnly[slot] !== true) {
      this.stubOnly[slot] = true
      this.stubCount += 1
    }
    this.feedSeqs[slot] = row.provenance.seq
    this.revisions[slot] = row.revision
    this.asOfs[slot] = row.asOf
    this.originIds[slot] = row.provenance.originId
    this.causationIds[slot] = row.provenance.causationId
    this.mutationIds[slot] = row.provenance.mutationId
    if (this.representable(id, row.value)) this.verbatim.delete(id)
    else this.verbatim.set(id, row.value)
  }

  /** Whether `id` is held as its stub alone. */
  isStubOnly(id: string): boolean {
    const slot = this.slots.get(id)
    return slot !== undefined && this.stubOnly[slot] === true
  }

  /** The row of `id` when it is held as its stub alone; `undefined` otherwise. */
  stubRecord(entity: string, id: string): EntityRecord | undefined {
    const slot = this.slots.get(id)
    if (slot === undefined || this.stubOnly[slot] !== true) return undefined
    const revision = this.revisions[slot]
    const asOf = this.asOfs[slot]
    return {
      entity,
      entityId: id,
      value: this.verbatim.has(id) ? this.verbatim.get(id) : this.materialize(id, slot),
      ...(revision === undefined ? {} : { revision }),
      provenance: {
        seq: this.feedSeqs[slot] as number,
        originId: this.originIds[slot],
        causationId: this.causationIds[slot],
        mutationId: this.mutationIds[slot],
      } as EntityRecord['provenance'],
      part: 'stub',
      ...(asOf === undefined ? {} : { asOf }),
    }
  }

  /** The ids held as their stub alone, in no particular order. */
  stubOnlyIds(): string[] {
    const out: string[] = []
    if (this.stubCount === 0) return out
    for (const [id, slot] of this.slots) if (this.stubOnly[slot] === true) out.push(id)
    return out
  }

  /** Forget `id`: the device holds no record of it. */
  remove(id: string): void {
    const slot = this.slots.get(id)
    if (slot === undefined) return
    if (this.stubOnly[slot] === true) this.clearRow(id, slot)
    this.unindex(id, slot)
    this.slots.delete(id)
    this.ids[slot] = undefined
    for (const column of this.columns.values()) column[slot] = undefined
    this.free.push(slot)
    this.changed()
  }

  /** Forget every row. */
  clear(): void {
    if (this.slots.size === 0) return
    for (const id of [...this.slots.keys()]) this.remove(id)
  }

  has(id: string): boolean {
    return this.slots.has(id)
  }

  /** The stub of `id`, as `stubOfValue` picks it: only the fields it carries. */
  stubOf(id: string): Readonly<Record<string, unknown>> | undefined {
    const slot = this.slots.get(id)
    return slot === undefined ? undefined : this.materialize(id, slot)
  }

  /** The ids whose parent is `parentId`. */
  childrenOf(parentId: string): readonly string[] {
    let list = this.childLists.get(parentId)
    if (list === undefined) {
      list = [...(this.children.get(parentId) ?? [])]
      this.childLists.set(parentId, list)
    }
    return list
  }

  /** The id holding reference `repoId`/`seq`; the lowest id when several do. */
  idAt(repoId: string, seq: number): string | undefined {
    const ids = this.references.get(`${repoId}:${seq}`)
    if (ids === undefined) return undefined
    let lowest: string | undefined
    for (const id of ids) if (lowest === undefined || id < lowest) lowest = id
    return lowest
  }

  /** Every stub, in no particular order; one array per version. */
  rows(): readonly StubRow[] {
    if (this.rowsCache?.version === this.changes) return this.rowsCache.rows
    const rows: StubRow[] = []
    for (const [id, slot] of this.slots) rows.push({ id, stub: this.materialize(id, slot) })
    this.rowsCache = { version: this.changes, rows }
    return rows
  }

  /** Write `id`'s stub columns; returns its slot. */
  private write(id: string, value: unknown): number {
    const record = (value ?? {}) as Record<string, unknown>
    let slot = this.slots.get(id)
    if (slot !== undefined && this.same(slot, record)) return slot
    if (slot === undefined) {
      slot = this.free.pop() ?? this.ids.length
      this.slots.set(id, slot)
      this.ids[slot] = id
    } else this.unindex(id, slot)
    for (const [field, column] of this.columns) column[slot] = this.cell(field, record[field])
    this.index(id, slot)
    this.changed()
    return slot
  }

  /** Drop the row fields of a slot held as a stub alone. */
  private clearRow(id: string, slot: number): void {
    this.stubOnly[slot] = undefined
    this.stubCount -= 1
    this.feedSeqs[slot] = undefined
    this.revisions[slot] = undefined
    this.asOfs[slot] = undefined
    this.originIds[slot] = undefined
    this.causationIds[slot] = undefined
    this.mutationIds[slot] = undefined
    this.verbatim.delete(id)
  }

  /** Whether the columns give `value` back as it is: its fields declared, its `id` this one. */
  private representable(id: string, value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    const declaresId = this.fields.includes('id')
    for (const key of Object.keys(record)) {
      if (key === 'id' && declaresId) continue
      if (!this.columns.has(key) || record[key] === undefined) return false
    }
    // `materialize` always writes the id when the type declares it.
    return !declaresId || record.id === id
  }

  private same(slot: number, record: Record<string, unknown>): boolean {
    for (const [field, column] of this.columns)
      if (column[slot] !== this.cell(field, record[field])) return false
    return true
  }

  private cell(field: string, value: unknown): Value | undefined {
    if (value === undefined || value === null) return value as null | undefined
    if (typeof value === 'string') {
      if (!SHARED.has(field)) return value
      const held = this.strings.get(value)
      if (held !== undefined) return held
      this.strings.set(value, value)
      return value
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value
    // Stub fields are scalars by declaration; anything else is kept as given.
    return value as Value
  }

  private materialize(id: string, slot: number): Readonly<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    for (const field of this.fields) {
      if (field === 'id') {
        out[field] = id
        continue
      }
      const value = this.columns.get(field)![slot]
      if (value !== undefined) out[field] = value
    }
    return out
  }

  private index(id: string, slot: number): void {
    const parent =
      this.parentField === undefined ? undefined : this.columns.get(this.parentField)?.[slot]
    if (typeof parent === 'string' && parent !== '') {
      let set = this.children.get(parent)
      if (set === undefined) {
        set = new Set()
        this.children.set(parent, set)
      }
      set.add(id)
      this.childLists.delete(parent)
    }
    const key = this.referenceKey(slot)
    if (key !== undefined) {
      let set = this.references.get(key)
      if (set === undefined) {
        set = new Set()
        this.references.set(key, set)
      }
      set.add(id)
    }
  }

  private unindex(id: string, slot: number): void {
    const parent =
      this.parentField === undefined ? undefined : this.columns.get(this.parentField)?.[slot]
    if (typeof parent === 'string' && parent !== '') {
      const set = this.children.get(parent)
      set?.delete(id)
      if (set?.size === 0) this.children.delete(parent)
      this.childLists.delete(parent)
    }
    const key = this.referenceKey(slot)
    if (key !== undefined) {
      const set = this.references.get(key)
      set?.delete(id)
      if (set?.size === 0) this.references.delete(key)
    }
  }

  private referenceKey(slot: number): string | undefined {
    const repo = this.columns.get('repoId')?.[slot]
    const seq = this.columns.get('seq')?.[slot]
    return typeof repo === 'string' && typeof seq === 'number' ? `${repo}:${seq}` : undefined
  }

  private changed(): void {
    this.changes += 1
  }
}
