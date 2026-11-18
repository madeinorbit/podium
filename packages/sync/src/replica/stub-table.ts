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
 */

import type { StubRow } from './types'

type Value = string | number | boolean | null

/** Fields with few distinct values: their strings are shared, not copied per row. */
const SHARED = new Set(['repoId', 'stage', 'closedReason', 'audience'])

/** One record type's stubs, by id. */
export class StubTable {
  private readonly slots = new Map<string, number>()
  private readonly ids: (string | undefined)[] = []
  private readonly free: number[] = []
  /** Column per declared field (`id` excepted: it is `ids`). */
  private readonly columns = new Map<string, (Value | undefined)[]>()
  private readonly strings = new Map<string, string>()
  /** Parent id → child ids, when the record type declares a parent field. */
  private readonly children = new Map<string, Set<string>>()
  /** `repoId:seq` → the ids holding that reference (normally one). */
  private readonly references = new Map<string, Set<string>>()
  private childLists = new Map<string, readonly string[]>()
  private rowsCache: { readonly version: number; readonly rows: readonly StubRow[] } | undefined
  private changes = 0

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

  /** Hold `id`'s stub from a record value (whole or stub level). */
  put(id: string, value: unknown): void {
    const record = (value ?? {}) as Record<string, unknown>
    let slot = this.slots.get(id)
    if (slot !== undefined && this.same(slot, record)) return
    if (slot === undefined) {
      slot = this.free.pop() ?? this.ids.length
      this.slots.set(id, slot)
      this.ids[slot] = id
    } else this.unindex(id, slot)
    for (const [field, column] of this.columns) column[slot] = this.cell(field, record[field])
    this.index(id, slot)
    this.changed()
  }

  /** Forget `id`: the device holds no record of it. */
  remove(id: string): void {
    const slot = this.slots.get(id)
    if (slot === undefined) return
    this.unindex(id, slot)
    this.slots.delete(id)
    this.ids[slot] = undefined
    for (const column of this.columns.values()) column[slot] = undefined
    this.free.push(slot)
    this.changed()
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
      if (set === undefined) this.children.set(parent, (set = new Set()))
      set.add(id)
      this.childLists.delete(parent)
    }
    const key = this.referenceKey(slot)
    if (key !== undefined) {
      let set = this.references.get(key)
      if (set === undefined) this.references.set(key, (set = new Set()))
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
