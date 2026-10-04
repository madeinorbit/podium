/**
 * POD-4557 (L5a) — the reads-per-change fence.
 *
 * Round two counted rows COMMITTED (React Profiler, `row-shell.tsx`) but never
 * rows READ. An arm could commit one row while walking the whole corpus to
 * decide which one, and every count stayed green. This module is the other
 * half: a shared, arm-independent count of how many entity rows an arm reads
 * to handle one change.
 *
 * WHAT IS COUNTED. Three doors, all owned here, never by an arm:
 *
 * 1. The FEED. `fence.wrapSource(source)` hands every row value to the arm as
 *    a borrowed counting proxy. Any property read on it — at apply time or
 *    months later from inside a derivation — counts that row. An arm that
 *    stores the borrowed object (the rule: the pool stores the borrowed row
 *    object, never a copy) is counted wherever it reads it from.
 * 2. The TABLES. `fence.wrapTables(tables)` wraps the arm's entity tables
 *    (`ReadonlyMap`s or arrays). `get`/`has` count the id; EVERY iteration
 *    (`keys`, `values`, `entries`, `forEach`, `for…of`, array index reads)
 *    counts EVERY element it yields. `keys()` counts each id WITHOUT reading
 *    its value (POD-4621): an id walk touches membership only, so under MobX
 *    it does not subscribe the walker to every row. Any other member throws: a
 *    fenced table is a read-only view, and an uncounted escape hatch would be
 *    the bypass. By default a table must hold borrowed rows; a value the feed
 *    did not hand out (a copy) throws on first read.
 * 3. The RELATIONS. `fence.wrapRelations(reader)` wraps the shared
 *    {@link RelationReader} accessor the pools implement (Ma2/Ha2). A relation
 *    name is checked against the declared schema; `one` counts its target,
 *    `many` counts every id it yields. `size` is free, like `Map.size`.
 *
 * THE NUMBER. `readsPerChange` is the count of DISTINCT `entity:id` rows
 * touched through any door since the last `reset()`. Distinct, because the
 * question is "how much of the corpus did this change touch", and an arm
 * reading the same row five times is a constant factor, not a scaling
 * failure. The raw access counts are kept alongside for diagnosis.
 *
 * ROWS READ (POD-4746). `ReadStats.data` counts only the rows whose DATA the
 * arm read: a field of a borrowed row (door 1, any path to it: a table, the
 * MobX pool's one row reader, a closure), a per-row read of the feed
 * (`RowSource.row`), or a harness adapter's `touch(…, 'field')` (the legacy
 * control's store). It leaves out ids yielded by a table walk or a relation
 * and presence probes: those are element walks, which the scale check counts
 * from outside (`harness/src/work-meter.ts`), not rows read. It is the rows
 * cell of that check; doors 2 and 3 and `touch` stay only while arm code
 * still calls them (POD-4759 removes those calls).
 *
 * TIMING RUNS. Proxies cost real time in the browser. `createReadFence({
 * enabled: false })` makes every wrapper the identity (the arm receives the
 * raw objects) and makes `stats()` THROW, so a count run that forgot to enable
 * the fence fails instead of reporting zero reads.
 *
 * VIOLATIONS ARE STICKY. Every refusal above throws AND is recorded; the
 * feed swallows listener errors, so `stats()` re-throws the first recorded
 * violation, forever, and a count run on a violating arm fails.
 *
 * THE COPY SWEEP (POD-4563, L6a). An arm that copies a borrowed row's fields
 * into an object of its own is counted once at the copy and never again. The
 * wrapped tables refuse such values, so the copy would live in a second,
 * unwrapped container. `fence.assertNoCopies(handle)` walks everything
 * reachable from the arm handle by reflection (own data properties, symbol
 * keys, Map and Set entries; getters are never invoked, borrowed rows and
 * fenced tables are never touched) and fails on any object that carries a fed
 * row's key plus two or more of that row's own field values outside the
 * row-view vocabulary (`COPY_EXEMPT_FIELDS`). It also fails when the walk
 * reaches neither a wrapped table nor a stored borrowed row: then it cannot
 * see the arm's state, and silence would be a pass by blindness. (POD-4746:
 * a borrowed row reached is enough, so the sweep needs no door in arm code.)
 *
 * WHAT THE SWEEP CANNOT SEE: state held only in a closure, a `#private` class
 * field, or a WeakMap/WeakSet. The lint fence (`harness/lint/`) forbids
 * module-scope state and `#private` fields in arm code; closures and weak
 * collections stay a review item.
 */

import type { RowSource } from '../arm'
import { type EntityName, SCHEMA } from '@podium/client-graph/shared/schema'
import type { RowRecord, RowSourceEvent } from '../stats'

/** How a row was reached. Raw counts per door, for diagnosis. `feed`: a per-row read of the feed. */
export type ReadVia = 'get' | 'iterate' | 'relation' | 'field' | 'feed'

/** The doors that read a row's data (`ReadStats.data`), not only its id. */
const DATA_DOORS: ReadonlySet<ReadVia> = new Set<ReadVia>(['field', 'feed'])

export interface ReadStats {
  /** Distinct `entity:id` rows read since the last reset, through any door. */
  rows: number
  /**
   * Distinct rows whose DATA was read (a borrowed row's field, a per-row feed
   * read, an adapter's `field` touch): the scale check's rows cell (POD-4746).
   */
  data: number
  /** Distinct rows per entity (or legacy table name). */
  byEntity: Record<string, number>
  /** Raw access counts per door (not distinct). */
  accesses: Record<ReadVia, number>
  /** Up to 8 distinct keys, in first-read order, for failure messages. */
  sample: string[]
}

export type { RelationReader } from '@podium/client-graph/shared/relation-reader'
import type { RelationReader } from '@podium/client-graph/shared/relation-reader'

/** A table the fence can wrap: keyed by id, or an array of rows. */
export type ReadTable = ReadonlyMap<string, unknown> | readonly unknown[]

export interface WrapTablesOptions {
  /**
   * Require every value read from a table to be a row the feed handed out.
   * Default true. Only the legacy control, whose rows come from the store and
   * not from the feed, turns it off.
   */
  borrowed?: boolean
  /** Key of an array element. Default: the schema key of the table's entity, else `id`/`sessionId`/`path`. */
  keyOf?: (row: unknown, index: number) => string
  /**
   * Hand back the one wrapper this fence already made for this raw table.
   * Default true, so identity memos keyed on a table hit exactly as they do
   * unwrapped. False makes a fresh wrapper the caller must cache itself (the
   * legacy adapter caches per store snapshot — see `fenced-store.ts`).
   */
  reuse?: boolean
  /**
   * POD-4746 — an element read from this table is a read of that row's data
   * (`ReadStats.data`), not only of its id. For a harness adapter over raw
   * rows (the legacy control's store), whose rows are read in place rather
   * than through borrowed rows. Default false: an arm's table walk yields ids
   * and borrowed rows, whose fields count when read.
   */
  data?: boolean
}

export interface ReadFence {
  readonly enabled: boolean
  /** Hand the arm the feed through the fence: every row value arrives borrowed. */
  wrapSource(source: RowSource): RowSource
  /** Wrap entity tables, keyed by entity (or table) name. Identity when disabled. */
  wrapTables<T extends Readonly<Record<string, ReadTable>>>(
    tables: T,
    options?: WrapTablesOptions,
  ): T
  /** Wrap the shared relation accessor. Identity when disabled. */
  wrapRelations(reader: RelationReader): RelationReader
  /** Record one read directly (for adapters whose tables are not a map or an array). */
  touch(entity: string, id: string, via: ReadVia): void
  /** True when `value` is a row this fence's feed handed out. */
  isBorrowed(value: unknown): boolean
  /**
   * POD-4563 — walk everything reachable from `root` (the arm handle) and fail
   * on a copy of a fed row held outside the wrapped tables, or when the walk
   * reaches no wrapped table (see "THE COPY SWEEP" above). Returns what it
   * walked. THROWS when the fence is disabled, like `stats()`.
   */
  assertNoCopies(root: object): CopySweep
  /** Reads since the last reset. THROWS when the fence is disabled. */
  stats(): ReadStats
  reset(): void
}

/** What one copy sweep walked. */
export interface CopySweep {
  /** Objects visited (borrowed rows and fenced tables excluded). */
  objects: number
  /** Wrapped tables (raw or fenced view) the walk reached. */
  tables: number
  /** Borrowed rows the walk reached (the arm's stored rows; never walked into). */
  rows: number
}

/**
 * Fields a derived object may legitimately share with a fed row: the row
 * view's vocabulary (`RowView`, `RowOriginTick`), which copies an issue's
 * title, seq, createdAt, sortKey and pinned by contract.
 */
export const COPY_EXEMPT_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'displayRef',
  'title',
  'phase',
  'progressDone',
  'progressTotal',
  'working',
  'asking',
  'band',
  'repoKey',
  'closed',
  'selected',
  'originTick',
  'activityAt',
  'workingSince',
  'pinned',
  'sortKey',
  'createdAt',
  'seq',
  'foldAt',
  'dismissed',
  'ref',
])

/** Own field values a copy must share with its row, beyond the key, to count as one. */
const COPY_THRESHOLD = 2
/** A walk larger than this fails: an arm handle does not reach a million objects. */
const SWEEP_LIMIT = 1_000_000
const ROW_KEYS = ['id', 'sessionId', 'path'] as const

const TABLE_MEMBERS = new Set<PropertyKey>([
  'get',
  'has',
  'size',
  'keys',
  'values',
  'entries',
  'forEach',
  Symbol.iterator,
  // Read by `String(table)`, template literals and test printers; carries no row.
  Symbol.toStringTag,
])

function defaultKeyOf(entity: string): (row: unknown, index: number) => string {
  const schemaKey = (SCHEMA as Readonly<Record<string, { key: string }>>)[entity]?.key
  return (row, index) => {
    if (row !== null && typeof row === 'object') {
      const record = row as Record<string, unknown>
      for (const key of [schemaKey, 'id', 'sessionId', 'path']) {
        if (key === undefined) continue
        const value = record[key]
        if (typeof value === 'string') return value
      }
    }
    return `#${index}`
  }
}

function isIndex(prop: PropertyKey): prop is string {
  return (
    typeof prop === 'string' &&
    prop.length > 0 &&
    String(Number(prop)) === prop &&
    Number(prop) >= 0
  )
}

export function createReadFence(options: { enabled: boolean }): ReadFence {
  const { enabled } = options
  const seen = new Set<string>()
  // Rows whose data was read, as a plain record: the fence's own bookkeeping
  // adds no Map or Set write beyond `seen` (tests that count plain-structure
  // writes from outside see those).
  let dataSeen: Record<string, true> = Object.create(null)
  let dataRows = 0
  const byEntity: Record<string, number> = {}
  const accesses: Record<ReadVia, number> = { get: 0, iterate: 0, relation: 0, field: 0, feed: 0 }
  const sample: string[] = []

  // One proxy per raw object, so identity comparisons (memos keyed by array or
  // row identity, `prev === next` guards) behave exactly as they do unwrapped.
  const borrowedByRaw = new WeakMap<object, object>()
  const borrowed = new WeakSet<object>()
  const tableByRaw = new WeakMap<object, Map<string, object>>()
  // The copy sweep's inputs: fenced table views, and the latest raw value fed
  // under each row key (raw, so comparing against it counts nothing).
  const fencedViews = new WeakSet<object>()
  const rawByKey = new Map<string, object>()
  // Sticky: `reset()` never clears them. The feed swallows a throwing listener
  // (`row-source.ts` `emit`), so a throw alone could vanish; `stats()` re-throws
  // the first violation, and a poisoned fence fails every later count.
  const violations: string[] = []

  function violate(message: string): never {
    violations.push(message)
    throw new Error(message)
  }

  function touch(entity: string, id: string, via: ReadVia, data = DATA_DOORS.has(via)): void {
    accesses[via] += 1
    const key = `${entity}:${id}`
    if (data && dataSeen[key] !== true) {
      dataSeen[key] = true
      dataRows += 1
    }
    if (seen.has(key)) return
    seen.add(key)
    byEntity[entity] = (byEntity[entity] ?? 0) + 1
    if (sample.length < 8) sample.push(key)
  }

  function borrow(kind: RowRecord['kind'], id: string, value: object): object {
    const existing = borrowedByRaw.get(value)
    if (existing !== undefined) return existing
    const proxy = new Proxy(value, {
      get(target, prop, receiver) {
        if (typeof prop !== 'symbol') touch(kind, id, 'field')
        return Reflect.get(target, prop, receiver)
      },
      has(target, prop) {
        touch(kind, id, 'field')
        return Reflect.has(target, prop)
      },
      ownKeys(target) {
        touch(kind, id, 'field')
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, prop) {
        touch(kind, id, 'field')
        return Reflect.getOwnPropertyDescriptor(target, prop)
      },
      set() {
        violate(
          `[reads] borrowed ${kind}:${id} is read-only; the pool stores the row, it does not edit it`,
        )
      },
      deleteProperty() {
        violate(
          `[reads] borrowed ${kind}:${id} is read-only; the pool stores the row, it does not edit it`,
        )
      },
    })
    borrowedByRaw.set(value, proxy)
    borrowed.add(proxy)
    rawByKey.set(id, value)
    return proxy
  }

  function borrowRecord(record: RowRecord): RowRecord {
    if (record.value === undefined) return record
    return {
      kind: record.kind,
      id: record.id,
      value: borrow(record.kind, record.id, record.value) as RowRecord['value'],
    }
  }

  function checkBorrowed(entity: string, id: string, value: unknown, required: boolean): void {
    if (!required || value === undefined || value === null) return
    if (typeof value === 'object' && borrowed.has(value)) return
    violate(
      `[reads] table "${entity}" returned ${entity}:${id}, which the feed did not hand out. ` +
        `The pool must store the borrowed row object, never a copy.`,
    )
  }

  function wrapMap(
    entity: string,
    raw: ReadonlyMap<string, unknown>,
    required: boolean,
    data: boolean,
  ): object {
    const target = raw as ReadonlyMap<string, unknown>
    const counted = (via: ReadVia) =>
      function* entriesOf(): Generator<[string, unknown]> {
        for (const [id, value] of target.entries()) {
          touch(entity, id, via, data)
          checkBorrowed(entity, id, value, required)
          yield [id, value]
        }
      }
    const iterateEntries = counted('iterate')
    const view = {
      get(id: string): unknown {
        touch(entity, id, 'get', data)
        const value = target.get(id)
        checkBorrowed(entity, id, value, required)
        return value
      },
      has(id: string): boolean {
        touch(entity, id, 'get')
        return target.has(id)
      },
      get size(): number {
        return target.size
      },
      // Counts each id without reading its value (POD-4621): under MobX a
      // value read subscribes the enumerating derivation to that row, so a
      // walk over ids would re-run on every row change, not only membership.
      *keys(): Generator<string> {
        for (const id of target.keys()) {
          touch(entity, id, 'iterate')
          yield id
        }
      },
      *values(): Generator<unknown> {
        for (const [, value] of iterateEntries()) yield value
      },
      entries: iterateEntries,
      forEach(
        callback: (value: unknown, id: string, map: unknown) => void,
        thisArg?: unknown,
      ): void {
        for (const [id, value] of iterateEntries()) callback.call(thisArg, value, id, proxy)
      },
      [Symbol.iterator]: iterateEntries,
      [Symbol.toStringTag]: `ReadFenced<${entity}>`,
    }
    const proxy: object = new Proxy(view, {
      get(viewTarget, prop, receiver) {
        if (!TABLE_MEMBERS.has(prop)) {
          violate(
            `[reads] table "${entity}" has no counted member ${String(prop)}; a fenced table is a read-only ReadonlyMap`,
          )
        }
        return Reflect.get(viewTarget, prop, receiver)
      },
    })
    fencedViews.add(proxy)
    return proxy
  }

  function wrapArray(
    entity: string,
    raw: readonly unknown[],
    required: boolean,
    keyOf: (row: unknown, index: number) => string,
    data: boolean,
  ): object {
    // Array methods (`map`, `filter`, `find`, `for…of`) read through [[Get]]
    // on the receiver, so counting index reads counts every element they visit.
    const view = new Proxy(raw as unknown[], {
      get(target, prop, receiver) {
        if (isIndex(prop)) {
          const index = Number(prop)
          const value = Reflect.get(target, prop, receiver)
          if (index < target.length) {
            const id = keyOf(value, index)
            touch(entity, id, 'iterate', data)
            checkBorrowed(entity, id, value, required)
          }
          return value
        }
        return Reflect.get(target, prop, receiver)
      },
      set() {
        violate(`[reads] table "${entity}" is a read-only view`)
      },
    })
    fencedViews.add(view)
    return view
  }

  function wrapTable(entity: string, raw: ReadTable, options: WrapTablesOptions): object {
    const required = options.borrowed ?? true
    const data = options.data ?? false
    const build = (): object =>
      Array.isArray(raw)
        ? wrapArray(entity, raw, required, options.keyOf ?? defaultKeyOf(entity), data)
        : wrapMap(entity, raw as ReadonlyMap<string, unknown>, required, data)
    if (options.reuse === false) return build()
    const cacheKey = `${entity}|${required ? 'b' : 'r'}|${data ? 'd' : 'i'}`
    let perRaw = tableByRaw.get(raw)
    if (perRaw === undefined) {
      perRaw = new Map()
      tableByRaw.set(raw, perRaw)
    }
    const cached = perRaw.get(cacheKey)
    if (cached !== undefined) return cached
    const wrapped = build()
    perRaw.set(cacheKey, wrapped)
    return wrapped
  }

  function relationTarget(from: EntityName, relation: string): EntityName {
    const spec = SCHEMA[from]?.relations[relation]
    if (spec === undefined) {
      violate(`[reads] ${from}.${relation} is not a declared relation (shared/src/schema.ts)`)
    }
    return spec.to
  }

  /** The fed row `value` is a copy of, or null. Reads raw values only. */
  function copyOf(value: object): string | null {
    const own = value as Record<string, unknown>
    for (const keyField of ROW_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, keyField)
      if (descriptor === undefined || typeof descriptor.value !== 'string') continue
      const raw = rawByKey.get(descriptor.value) as Record<string, unknown> | undefined
      if (raw === undefined) continue
      let shared = 0
      for (const field of Object.keys(value)) {
        if (field === keyField || COPY_EXEMPT_FIELDS.has(field)) continue
        if (!Object.hasOwn(raw, field) || raw[field] === undefined) continue
        const mine = Object.getOwnPropertyDescriptor(own, field)
        if (mine !== undefined && 'value' in mine && mine.value === raw[field]) shared += 1
      }
      if (shared >= COPY_THRESHOLD) return `${keyField}=${descriptor.value} (${shared} fields)`
    }
    return null
  }

  function sweep(root: object): CopySweep {
    const seenObjects = new Set<object>()
    const queue: object[] = [root]
    let tables = 0
    let rows = 0
    const copies: string[] = []
    const Node = (globalThis as { Node?: new () => object }).Node
    const push = (value: unknown): void => {
      if ((typeof value === 'object' && value !== null) || typeof value === 'function')
        queue.push(value as object)
    }
    while (queue.length > 0) {
      const current = queue.pop() as object
      if (seenObjects.has(current)) continue
      if (borrowed.has(current)) {
        rows += 1
        seenObjects.add(current)
        continue
      }
      if (fencedViews.has(current) || tableByRaw.has(current)) {
        tables += 1
        seenObjects.add(current)
        continue
      }
      // Functions (closures are invisible anyway), DOM nodes and React roots
      // carry no arm state the sweep could judge.
      if (typeof current === 'function') continue
      if (Node !== undefined && current instanceof Node) continue
      if (Object.hasOwn(current, '_internalRoot')) continue
      seenObjects.add(current)
      if (seenObjects.size > SWEEP_LIMIT) {
        violate(
          `[copies] the sweep passed ${SWEEP_LIMIT} objects without finishing; it cannot vouch for this arm`,
        )
      }
      if (current instanceof Map) {
        for (const [key, value] of Map.prototype.entries.call(current) as Iterable<
          [unknown, unknown]
        >) {
          push(key)
          push(value)
        }
      } else if (current instanceof Set) {
        for (const value of Set.prototype.values.call(current) as Iterable<unknown>) push(value)
      } else if (!Array.isArray(current)) {
        const copy = copyOf(current)
        if (copy !== null && copies.length < 8) copies.push(copy)
      }
      for (const key of Reflect.ownKeys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor !== undefined && 'value' in descriptor) push(descriptor.value)
      }
    }
    if (copies.length > 0) {
      violate(
        `[copies] the arm holds copies of fed rows outside its wrapped tables: ${copies.join('; ')}. ` +
          `The pool stores the borrowed row object; derived objects carry only row-view fields.`,
      )
    }
    if (tables === 0 && rows === 0) {
      violate(
        `[copies] the sweep reached none of the arm's wrapped tables or stored rows from the handle, so it ` +
          `cannot see the arm's state; expose the pool on the handle (e.g. \`handle.pool\`)`,
      )
    }
    return { objects: seenObjects.size - rows, tables, rows }
  }

  const fence: ReadFence = {
    enabled,
    wrapSource(source: RowSource): RowSource {
      if (!enabled) return source
      const row = source.row?.bind(source)
      return {
        snapshot(kind) {
          return source.snapshot(kind).map(borrowRecord)
        },
        ...(source.issueIdByRef ? { issueIdByRef: source.issueIdByRef.bind(source) } : {}),
        // POD-5407: the feed's cold index answers declared questions, never
        // rows; the arm reads every row through `row` below.
        ...(source.cold ? { cold: source.cold.bind(source) } : {}),
        // A per-row read (a cold row's hydration, POD-4567) is a keyed read of
        // that row, and its value arrives borrowed like any other.
        ...(row === undefined
          ? {}
          : {
              row(kind: 'issue' | 'session', id: string) {
                touch(kind, id, 'feed')
                return borrowRecord({ kind, id, value: row(kind, id) }).value
              },
            }),
        subscribe(listener) {
          return source.subscribe((event: RowSourceEvent) => {
            listener({ type: event.type, rows: event.rows.map(borrowRecord) })
          })
        },
      }
    },
    wrapTables(tables, options = {}) {
      if (!enabled) return tables
      const out: Record<string, object> = {}
      for (const [entity, table] of Object.entries(tables))
        out[entity] = wrapTable(entity, table, options)
      return out as typeof tables
    },
    wrapRelations(reader: RelationReader): RelationReader {
      if (!enabled) return reader
      return {
        one(from, id, relation) {
          const to = relationTarget(from, relation)
          const target = reader.one(from, id, relation)
          if (target !== null) touch(to, target, 'relation')
          return target
        },
        many(from, id, relation) {
          const to = relationTarget(from, relation)
          const ids = reader.many(from, id, relation)
          return {
            *[Symbol.iterator]() {
              for (const target of ids) {
                touch(to, target, 'relation')
                yield target
              }
            },
          }
        },
        size(from, id, relation) {
          relationTarget(from, relation)
          return reader.size(from, id, relation)
        },
        subset(from, id, relation, subset) {
          const to = relationTarget(from, relation)
          const ids = reader.subset(from, id, relation, subset)
          return {
            *[Symbol.iterator]() {
              for (const target of ids) {
                touch(to, target, 'relation')
                yield target
              }
            },
          }
        },
      }
    },
    touch(entity, id, via) {
      if (enabled) touch(entity, id, via)
    },
    isBorrowed(value) {
      return typeof value === 'object' && value !== null && borrowed.has(value)
    },
    assertNoCopies(root) {
      if (!enabled) {
        throw new Error(
          '[copies] the read fence is disabled (timing mode); a count run must enable it',
        )
      }
      return sweep(root)
    },
    stats(): ReadStats {
      if (!enabled) {
        throw new Error(
          '[reads] the read fence is disabled (timing mode); a count run must enable it',
        )
      }
      if (violations.length > 0) {
        throw new Error(
          `[reads] fence violated ${violations.length} time(s); first: ${violations[0]}`,
        )
      }
      return {
        rows: seen.size,
        data: dataRows,
        byEntity: { ...byEntity },
        accesses: { ...accesses },
        sample: [...sample],
      }
    },
    reset(): void {
      seen.clear()
      dataSeen = Object.create(null)
      dataRows = 0
      for (const key of Object.keys(byEntity)) delete byEntity[key]
      accesses.get = 0
      accesses.iterate = 0
      accesses.relation = 0
      accesses.field = 0
      accesses.feed = 0
      sample.length = 0
    },
  }
  return fence
}

/**
 * The acceptance's spelling: wrap `tables` through `fence`. Same as
 * `fence.wrapTables(tables, options)`.
 */
export function wrapTables<T extends Readonly<Record<string, ReadTable>>>(
  tables: T,
  fence: ReadFence,
  options?: WrapTablesOptions,
): T {
  return fence.wrapTables(tables, options)
}

/** The fence timing runs use: every wrapper is the identity; `stats()` throws. */
export const DISABLED_READ_FENCE: ReadFence = createReadFence({ enabled: false })
