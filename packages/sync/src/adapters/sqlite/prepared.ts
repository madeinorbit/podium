/**
 * PREPARED ONCE, REUSED [POD-6147, server data design §3 rule 1].
 *
 * A drizzle builder chain (`db.select().from(t).where(...).get()`) does its
 * expensive work at the terminal call: it serialises the statement through the
 * dialect and generates a row mapper over the selection. POD-3854 measured that
 * as about 89% of a primary-key read. `.prepare()` keeps that work, and what is
 * left per call is filling placeholders and running the statement.
 *
 * WHY ONE INSTANCE PER STORE IS ENOUGH. A prepared query closes over the session
 * of the drizzle instance it was built on. The store hands every repository ONE
 * drizzle instance over the executor's AMBIENT client, whose router resolves the
 * enclosing transaction for each statement as it executes. So a query prepared
 * once runs inside whatever transaction is current when it is executed, exactly
 * like the fluent form did (the sync repository's append statements have
 * relied on this since POD-3494).
 *
 * The helpers here are keyed by that drizzle instance rather than held as plain
 * module constants, because a process can hold several stores (tests, restore)
 * and each store has its own instance. They are generic over the instance type
 * so `apps/server`'s repositories and this package's adapter share one
 * implementation.
 *
 * TABLES COME FROM THE BINDING [POD-6977, POD-6958 design §2.1]. A definition
 * names no table it imports: it is `prepared((db, t) => db.select().from(t.x)…)`,
 * and `t` is the table set bound to the drizzle instance it is built on
 * ({@link bindTables}). On SQLite that set is the SQLite schema, so the SQL is
 * what naming the imported tables produced; an engine with its own tables binds
 * those, and the same definition source builds on them.
 *
 * THREE KINDS OF DEFINITION [POD-6959 design 2.4]. {@link prepared} is a
 * workspace definition: its accessor takes a workspace handle and hands back a
 * bound view that fills the `workspaceId` placeholder from the handle.
 * {@link preparedGlobal} names install tables only and takes any store handle;
 * {@link preparedAcross} is a read across workspaces, allowlisted by name, and
 * takes the fleet handle. Until the repositories take handles (POD-7010), the
 * workspace accessor also takes the bare drizzle instance and returns the
 * statement unbound, as it always did.
 *
 * Rules for a converted query:
 *   - A comparison value is `param(column, 'name')`, never a bare
 *     `sql.placeholder`: drizzle applies the column's encoder (JSON, boolean,
 *     timestamp modes) only to a placeholder wrapped in a column `Param`, which
 *     is what `eq(column, value)` built for a literal value.
 *   - A `.values({...})` or `.set({...})` entry is `sql.placeholder('name')`:
 *     the builder wraps it in the column's `Param` itself.
 *   - A query whose SQL text depends on the call (optional filters, a patch
 *     with varying keys, an IN list) is a {@link preparedFamily} keyed by its
 *     SHAPE. The key comes from a finite domain, never from a value.
 */

import type { WorkspaceId } from '@podium/model'
import {
  and,
  type Column,
  eq,
  inArray,
  notInArray,
  Param,
  type Placeholder,
  type SQL,
  sql,
} from 'drizzle-orm'

// ---------------------------------------------------------------------------
// The definition registry [POD-6148]
// ---------------------------------------------------------------------------

/**
 * One `prepared(...)` or `preparedFamily(...)` call, as the query-plan audit
 * (`apps/server/src/store/query-plan-audit.test.ts`) reads it: the audit calls
 * `build` itself on a drizzle instance that records instead of running (and
 * `build` takes the instance's bound tables as the definition's `t`), so it
 * sees every repository query whether or not a test ever executes it, and
 * `site` names the definition: its stack, formatted when the definition was
 * made, gives the source line of the call (the audit finds the call there).
 */
export interface PreparedDefinition {
  readonly kind: 'prepared' | 'family'
  /** Which of the three definition kinds this is [POD-6959 design 2.4, 2.5]. */
  readonly scope: DefinitionScope
  /** The allowlist entry a cross-workspace definition was made with. */
  readonly entry?: CrossWorkspaceEntry
  readonly build: (db: never, key: never) => unknown
  readonly site: Error
}

/**
 * What a definition may touch: one workspace's rows (`workspace`, the default
 * kind), install tables only (`global`), or a read across workspaces (`across`).
 * The workspace-scope audit (POD-7014) checks the SQL of each against it.
 */
export type DefinitionScope = 'workspace' | 'global' | 'across'

/**
 * One entry of the cross-workspace allowlist (`store/cross-workspace-allowlist.ts`):
 * where the definition is, why it must read across workspaces, the index that
 * serves it and the issue that owns it.
 */
export interface CrossWorkspaceEntry {
  readonly file: string
  readonly name: string
  readonly reason: string
  readonly index: string
  readonly issue: string
}

/**
 * Bound on the registry. Module-level definitions register once per process;
 * a definition made inside a method (a per-repository write, a status move per
 * variant) registers once per repository instance, so a process that opens
 * many stores adds a few per store. Past the bound nothing more is recorded,
 * and the audit fails if it ever sees the bound reached.
 */
const DEFINITION_LIMIT = 20_000
const definitions: PreparedDefinition[] = []

function register(
  kind: PreparedDefinition['kind'],
  scope: DefinitionScope,
  build: PreparedDefinition['build'],
  entry?: CrossWorkspaceEntry,
): void {
  if (definitions.length >= DEFINITION_LIMIT) return
  const site = new Error('query definition')
  // Format the stack now, while the code it names is running [POD-7064]. Left
  // unread, the engine formats it whenever a collection frees that code (Bun
  // does so without `Error.prepareStackTrace`, so the test runner's source map
  // is skipped) or at first read (with it), and one process then holds stacks
  // in two coordinate systems: transformed lines and source lines.
  void site.stack
  definitions.push({
    kind,
    scope,
    ...(entry === undefined ? {} : { entry }),
    build,
    site,
  })
}

/** Every definition made in this process so far, oldest first (audit only). */
export function preparedDefinitions(): readonly PreparedDefinition[] {
  return definitions
}

/** The registry's bound; the audit asserts it was never reached. */
export const PREPARED_DEFINITION_LIMIT = DEFINITION_LIMIT

// ---------------------------------------------------------------------------
// The table binding [POD-6977]
// ---------------------------------------------------------------------------

const bindings = new WeakMap<object, object>()

/**
 * Bind `tables` to the drizzle instance `db`: every definition built on `db`
 * gets them as its `t`. Done once, where the instance is made; a second binding
 * of a different set would leave definitions already built on the first, so it
 * throws.
 */
export function bindTables<D extends object>(db: D, tables: object): D {
  const bound = bindings.get(db)
  if (bound !== undefined && bound !== tables) {
    throw new Error('this drizzle instance is already bound to another table set')
  }
  bindings.set(db, tables)
  return db
}

/** The table set bound to `db`; throws when the instance was never bound. */
export function boundTables(db: object): object {
  const tables = bindings.get(db)
  if (tables === undefined) {
    throw new Error(
      'a query definition was built on a drizzle instance with no table binding (bindTables)',
    )
  }
  return tables
}

// ---------------------------------------------------------------------------
// Query handles [POD-6959 design 2.4]
// ---------------------------------------------------------------------------

/**
 * What a handle, or the transaction a statement runs in, is for: one workspace,
 * or the install as a whole. The store declares the same union as its
 * `StoreContext`, which every transaction frame records.
 */
export type HandleContext =
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }
  | { readonly kind: 'global' }

/** A workspace context, the one a workspace handle carries. */
export type WorkspaceContext = Extract<HandleContext, { readonly kind: 'workspace' }>

/**
 * Marks the objects {@link queryHandle} and {@link fleetHandle} make, so an
 * accessor tells a handle from a bare drizzle instance with one property read.
 */
export const QUERY_HANDLE: unique symbol = Symbol('podium.query-handle')

/**
 * What a repository queries through: the store's one drizzle instance with the
 * context the repository was built for. Global repositories hold one with the
 * global context; a workspace repository's is a {@link WorkspaceHandle}.
 *
 * `openContext` reads the context of the transaction open where a statement
 * runs (undefined outside one). It is the handle's, not a module setting, so this
 * package needs nothing from the store that made it.
 */
export interface QueryHandle<D> {
  readonly [QUERY_HANDLE]: 'store'
  readonly drizzle: D
  readonly context: HandleContext
  readonly openContext: () => HandleContext | undefined
  /**
   * How a workspace statement runs when no transaction is open, if the engine needs
   * to know its workspace there [POD-6979]: Postgres takes the workspace's lock in
   * the root write's own pipeline. Absent (SQLite), the statement just runs.
   */
  readonly runAtRoot?: RootRunner
}

/** Runs one root statement of a workspace with that workspace known to the engine. */
export type RootRunner = <T>(context: WorkspaceContext, run: () => T) => T

/** A handle for one workspace: the only thing a workspace definition runs on. */
export interface WorkspaceHandle<D> extends QueryHandle<D> {
  readonly context: WorkspaceContext
}

/**
 * The handle a fleet job reads across workspaces with: the only thing a
 * {@link preparedAcross} definition runs on, and nothing else runs on it.
 */
export interface FleetHandle<D> {
  readonly [QUERY_HANDLE]: 'fleet'
  readonly drizzle: D
}

/** A handle over `drizzle` for `context`. Made once per repository set, never per call. */
export function queryHandle<D>(
  drizzle: D,
  context: WorkspaceContext,
  openContext: () => HandleContext | undefined,
  runAtRoot?: RootRunner,
): WorkspaceHandle<D>
export function queryHandle<D>(
  drizzle: D,
  context: HandleContext,
  openContext: () => HandleContext | undefined,
  runAtRoot?: RootRunner,
): QueryHandle<D>
export function queryHandle<D>(
  drizzle: D,
  context: HandleContext,
  openContext: () => HandleContext | undefined,
  runAtRoot?: RootRunner,
): QueryHandle<D> {
  return Object.freeze({
    [QUERY_HANDLE]: 'store' as const,
    drizzle,
    context,
    openContext,
    ...(runAtRoot === undefined ? {} : { runAtRoot }),
  })
}

/** The fleet handle over `drizzle`. */
export function fleetHandle<D>(drizzle: D): FleetHandle<D> {
  return Object.freeze({ [QUERY_HANDLE]: 'fleet' as const, drizzle })
}

// ---------------------------------------------------------------------------
// The workspace fill [POD-6959 design 2.4]
// ---------------------------------------------------------------------------

/** A refusal of the workspace rule: a statement would read or write another workspace. */
export class WorkspaceScopeError extends Error {
  override readonly name: string = 'WorkspaceScopeError'
}

/**
 * A workspace statement ran inside a transaction of a different workspace. The
 * transaction holds its own workspace's write slot (and on Postgres its lock),
 * so the statement would touch a workspace nobody locked.
 */
export class CrossWorkspaceStatementError extends WorkspaceScopeError {
  override readonly name = 'CrossWorkspaceStatementError'
  constructor(
    readonly handleWorkspaceId: WorkspaceId,
    readonly transactionWorkspaceId: WorkspaceId,
  ) {
    super(
      `a statement for workspace ${handleWorkspaceId} ran inside a transaction of workspace ` +
        `${transactionWorkspaceId}: a repository of one workspace was reached from another's work`,
    )
  }
}

/**
 * A workspace statement ran inside a global transaction. A global transaction
 * holds no workspace, so it may not run a workspace definition.
 */
export class WorkspaceStatementInGlobalTransactionError extends WorkspaceScopeError {
  override readonly name = 'WorkspaceStatementInGlobalTransactionError'
  constructor(readonly handleWorkspaceId: WorkspaceId) {
    super(
      `a statement for workspace ${handleWorkspaceId} ran inside a global transaction: open the ` +
        "transaction through the workspace's own queries instead",
    )
  }
}

/** A caller handed a bound view its own `workspaceId`; only the handle names the workspace. */
export class CallerWorkspaceValueError extends WorkspaceScopeError {
  override readonly name = 'CallerWorkspaceValueError'
  constructor() {
    super(
      'a caller passed a value named workspaceId to a workspace statement: the workspace comes ' +
        "from the repository's handle, never from a caller",
    )
  }
}

type Values = Readonly<Record<string, unknown>>

/** The values a caller hands a bound view: anything but the workspace, which the handle fills. */
export type FillValues = Values & { readonly workspaceId?: never }

const RUN_METHODS = ['get', 'all', 'run', 'values', 'execute'] as const
type RunMethod = (typeof RUN_METHODS)[number]

/**
 * A statement bound to one workspace handle: the statement's own `get`, `all`,
 * `run`, `values` and `execute` (whichever it has; a raw statement has only
 * `execute`, which `executeRaw` calls), each filling `workspaceId` from the
 * handle. Anything a definition returns that is not a statement (builders,
 * terms another definition composes) is composed on the drizzle instance and
 * has no bound form.
 */
export type Bound<P> = P extends { execute(...args: never[]): unknown }
  ? {
      readonly [K in RunMethod & keyof P]: P[K] extends (...args: never[]) => infer R
        ? (values?: FillValues) => R
        : never
    }
  : never

/**
 * The values a statement of `handle` runs with: the caller's, plus the
 * handle's workspace. One own-key check, one context read and one spread per
 * call (POD-6959 design 2.10 bounds the fill at under a microsecond).
 */
function fillFor(
  handle: WorkspaceHandle<unknown>,
  values: Values | undefined,
): { readonly values: Values; readonly atRoot: boolean } {
  if (values !== undefined && 'workspaceId' in values) throw new CallerWorkspaceValueError()
  const workspaceId = handle.context.workspaceId
  const open = handle.openContext()
  if (open !== undefined) {
    if (open.kind === 'global') throw new WorkspaceStatementInGlobalTransactionError(workspaceId)
    if (open.workspaceId !== workspaceId) {
      throw new CrossWorkspaceStatementError(workspaceId, open.workspaceId)
    }
  }
  return {
    values: values === undefined ? { workspaceId } : { ...values, workspaceId },
    atRoot: open === undefined,
  }
}

/** The bound view of `statement` for `handle`; made once per handle (the accessors cache it). */
function bindView<P>(statement: P, handle: WorkspaceHandle<unknown>): Bound<P> {
  const target = statement as Partial<Record<RunMethod, (values?: Values) => unknown>> | null
  if (target === null || typeof target !== 'object' || typeof target.execute !== 'function') {
    throw new TypeError(
      'a workspace handle runs prepared statements only: a definition that returns builders or ' +
        'terms is composed on the drizzle instance inside another definition',
    )
  }
  const view: Partial<Record<RunMethod, (values?: Values) => unknown>> = {}
  for (const method of RUN_METHODS) {
    const run = target[method]
    if (typeof run !== 'function') continue
    const own = run.bind(statement)
    const runAtRoot = handle.runAtRoot
    view[method] =
      runAtRoot === undefined
        ? (values) => own(fillFor(handle, values).values)
        : (values) => {
            const fill = fillFor(handle, values)
            return fill.atRoot
              ? runAtRoot(handle.context, () => own(fill.values))
              : own(fill.values)
          }
  }
  return Object.freeze(view) as Bound<P>
}

const handleKind = (db: object): unknown => (db as { [QUERY_HANDLE]?: unknown })[QUERY_HANDLE]

/** The drizzle instance of a workspace handle; refuses a global or fleet handle at runtime too. */
function workspaceDrizzle<D>(handle: QueryHandle<D> | FleetHandle<D>): D {
  if (handle[QUERY_HANDLE] !== 'store' || handle.context.kind !== 'workspace') {
    throw new TypeError('a workspace definition runs on a workspace handle only')
  }
  return handle.drizzle
}

/** One built value per drizzle instance. */
function perInstance<D extends object, P>(make: (db: D) => P): (db: D) => P {
  const cache = new WeakMap<D, P>()
  return (db) => {
    const hit = cache.get(db)
    if (hit !== undefined) return hit
    const made = make(db)
    cache.set(db, made)
    return made
  }
}

// ---------------------------------------------------------------------------
// The three kinds of definition [POD-6959 design 2.4]
// ---------------------------------------------------------------------------

/** The accessor of a workspace definition. */
export interface PreparedAccessor<D, P> {
  /**
   * LEGACY until POD-7010 moves the repositories onto handles: the bare drizzle
   * instance, and the statement unbound, exactly as before.
   */
  (db: D): P
  /** The statement bound to the handle's workspace. */
  (db: WorkspaceHandle<D>): Bound<P>
}

/** The accessor of a workspace family. */
export interface PreparedFamilyAccessor<D, K, P> {
  /** LEGACY until POD-7010; see {@link PreparedAccessor}. */
  (db: D, key: K): P
  (db: WorkspaceHandle<D>, key: K): Bound<P>
}

/**
 * One query, prepared on first use and reused for the drizzle instance's life.
 * `build` gets the instance and the tables bound to it.
 *
 * A WORKSPACE DEFINITION. The statement is prepared once per drizzle instance,
 * so every workspace shares it; a workspace handle gets a bound view of it, made
 * once per handle, that fills `workspaceId` and refuses a statement of another
 * workspace (see {@link Bound}). Drizzle ignores a value no placeholder names, so
 * a definition that does not name the workspace yet runs unchanged with the fill.
 */
export function prepared<D extends object, T, P>(
  build: (db: D, t: T) => P,
): PreparedAccessor<D, P> {
  const make = (db: D): P => build(db, boundTables(db) as T)
  register('prepared', 'workspace', make as PreparedDefinition['build'])
  const statementOn = perInstance(make)
  const views = new WeakMap<object, Bound<P>>()
  return ((db: D | WorkspaceHandle<D>) => {
    if (handleKind(db) === undefined) return statementOn(db as D)
    const handle = db as WorkspaceHandle<D>
    const hit = views.get(handle)
    if (hit !== undefined) return hit
    const view = bindView(statementOn(workspaceDrizzle(handle)), handle)
    views.set(handle, view)
    return view
  }) as PreparedAccessor<D, P>
}

/**
 * How many shapes one family keeps per drizzle instance. A family's keys come
 * from a finite domain by construction (flags, IN-list sizes, the column set of
 * a typed patch), so this is a backstop against a key that accidentally carries
 * a value, not a working limit. Overflow evicts the oldest shape and is counted,
 * so the guard test can see it.
 */
const FAMILY_LIMIT = 128
let familyOverflowCount = 0

/** Times any family evicted a shape since the process started (guard tests read it). */
export function preparedFamilyOverflows(): number {
  return familyOverflowCount
}

/** Remember `value` under `key` in a family's map, evicting the oldest shape past the limit. */
function keepShape<K, V>(family: Map<K, V>, key: K, value: V): V {
  if (family.size >= FAMILY_LIMIT) {
    const oldest = family.keys().next().value as K
    family.delete(oldest)
  }
  family.set(key, value)
  return value
}

/**
 * A bounded set of prepared queries, one per SHAPE.
 *
 * For a query whose SQL text varies by call: which optional filters are set,
 * which columns a patch writes, how many values an IN list holds. Each shape is
 * prepared once, the first time it is asked for, and the SQL text of every
 * shape is the text the fluent form produced for the same call.
 *
 * A workspace definition, like {@link prepared}: a workspace handle gets one
 * bound view per shape, over the shape's shared statement.
 */
export function preparedFamily<D extends object, T, K extends string | number, P>(
  build: (db: D, t: T, key: K) => P,
): PreparedFamilyAccessor<D, K, P> {
  const make = (db: D, key: K): P => build(db, boundTables(db) as T, key)
  register('family', 'workspace', make as PreparedDefinition['build'])
  const cache = new WeakMap<D, Map<K, P>>()
  const statementOn = (db: D, key: K): P => {
    let family = cache.get(db)
    if (family === undefined) {
      family = new Map()
      cache.set(db, family)
    }
    const hit = family.get(key)
    if (hit !== undefined) return hit
    if (family.size >= FAMILY_LIMIT) familyOverflowCount += 1
    return keepShape(family, key, make(db, key))
  }
  const views = new WeakMap<object, Map<K, Bound<P>>>()
  return ((db: D | WorkspaceHandle<D>, key: K) => {
    if (handleKind(db) === undefined) return statementOn(db as D, key)
    const handle = db as WorkspaceHandle<D>
    let family = views.get(handle)
    if (family === undefined) {
      family = new Map()
      views.set(handle, family)
    }
    const hit = family.get(key)
    if (hit !== undefined) return hit
    // A view evicted here only drops the wrapper; the statement cache above
    // counts the overflow, once, for the shape.
    return keepShape(family, key, bindView(statementOn(workspaceDrizzle(handle), key), handle))
  }) as PreparedFamilyAccessor<D, K, P>
}

/**
 * A GLOBAL DEFINITION: one query over install tables only.
 *
 * `build` receives the install tables (the store types `t` as `GlobalTables`),
 * so a global definition that names a workspace table does not compile. Its
 * accessor takes any store handle: a global repository's, or a workspace
 * repository's, since a workspace may read and write install tables. There is
 * no fill, and no bare-instance form.
 */
export function preparedGlobal<D extends object, T, P>(
  build: (db: D, t: T) => P,
): (db: QueryHandle<D>) => P {
  const make = (db: D): P => build(db, boundTables(db) as T)
  register('prepared', 'global', make as PreparedDefinition['build'])
  const statementOn = perInstance(make)
  return (db) => {
    if (handleKind(db) !== 'store')
      throw new TypeError('a global definition runs on a store handle')
    return statementOn(db.drizzle)
  }
}

/**
 * A CROSS-WORKSPACE DEFINITION: a read a fleet job makes to find work in every
 * workspace, then does that work through each workspace's own repositories.
 *
 * Named by its allowlist `entry`, which the registry keeps; the workspace-scope
 * audit (POD-7014) requires the definition to be a `SELECT` and the entry to be
 * on the allowlist. Its accessor takes the fleet handle only. Nothing writes
 * across workspaces.
 */
export function preparedAcross<D extends object, T, P>(
  entry: CrossWorkspaceEntry,
  build: (db: D, t: T) => P,
): (db: FleetHandle<D>) => P {
  const make = (db: D): P => build(db, boundTables(db) as T)
  register('prepared', 'across', make as PreparedDefinition['build'], entry)
  const statementOn = perInstance(make)
  return (db) => {
    if (handleKind(db) !== 'fleet') {
      throw new TypeError('a cross-workspace definition runs on the fleet handle')
    }
    return statementOn(db.drizzle)
  }
}

// ---------------------------------------------------------------------------
// Naming the workspace in a definition [POD-6959 design 2.4]
// ---------------------------------------------------------------------------

/** A table that carries the workspace column. */
interface WorkspaceTable {
  readonly workspaceId: Column
}

/**
 * The `workspaceId` placeholder, for `.values({ workspaceId: WORKSPACE, … })`.
 * A bound view fills it from the handle.
 */
export const WORKSPACE: Placeholder<'workspaceId'> = sql.placeholder('workspaceId')

/**
 * `table.workspace_id = :workspaceId AND …conditions`, as one flat `AND`, so the
 * workspace term is a top-level conjunct the audit (POD-7014) can see.
 */
export function inWorkspace(table: WorkspaceTable, ...conditions: (SQL | undefined)[]): SQL {
  return and(eq(table.workspaceId, param(table.workspaceId, 'workspaceId')), ...conditions) as SQL
}

/** `a.workspace_id = b.workspace_id`, for a join condition. */
export function sameWorkspace(a: WorkspaceTable, b: WorkspaceTable): SQL {
  return eq(a.workspaceId, b.workspaceId)
}

/**
 * A named placeholder bound to `column`'s encoder, for the right-hand side of a
 * comparison. Renders `?`, exactly as `eq(column, value)` does, and fills with
 * the value encoded the way that literal would have been.
 */
export function param(column: Column, name: string): Param {
  return new Param(sql.placeholder(name), column)
}

/**
 * The shape key of a patch: the names of the keys it actually sets, in a fixed
 * order. Drizzle's `.set()` and `.values()` skip a key whose value is
 * `undefined`, so a key that is present but undefined is not part of the shape.
 */
export function shapeOf(patch: object): string {
  return Object.keys(patch)
    .filter((key) => (patch as Record<string, unknown>)[key] !== undefined)
    .sort()
    .join(',')
}

/**
 * Placeholder-valued copy of a patch's set keys, for `.set()` or `.values()`
 * inside a family's builder: `{ title: sql.placeholder('title'), ... }`.
 */
export function placeholdersFor(shape: string): Record<string, Placeholder> {
  const out: Record<string, Placeholder> = {}
  if (shape === '') return out
  for (const key of shape.split(',')) out[key] = sql.placeholder(key)
  return out
}

// ---------------------------------------------------------------------------
// Bounded IN lists
// ---------------------------------------------------------------------------

/**
 * The size an IN list of `count` values is prepared at: 0, 1, then the next
 * power of two. A query keyed by this size has at most
 * log2(largest list) + 2 shapes, however many distinct lengths its callers pass,
 * where the fluent form made one SQL text (and one cached driver statement) per
 * distinct length.
 *
 * Above SQLite's portable bound-parameter ceiling the exact count is used: a
 * list that large is not chunked by its caller today, and rounding it up could
 * cross the limit. Every chunked caller (500 per chunk) stays bucketed.
 */
export function inListSize(count: number): number {
  if (count <= 1) return count
  let size = 2
  while (size < count) size *= 2
  return size > IN_LIST_BUCKET_CEILING ? count : size
}

/** Lists longer than this keep their exact length (see {@link inListSize}). */
export const IN_LIST_BUCKET_CEILING = 16384

/**
 * `column IN (?, ?, ...)` with `size` placeholders named `${prefix}0`,
 * `${prefix}1`, ...; `size` 0 renders drizzle's own `false`, as an empty list
 * always did.
 */
export function inListOf(column: Column, size: number, prefix = 'in'): SQL {
  return inArray(column, inListParams(column, size, prefix))
}

/** `column NOT IN (...)`, the same way; `size` 0 renders drizzle's `true`. */
export function notInListOf(column: Column, size: number, prefix = 'in'): SQL {
  return notInArray(column, inListParams(column, size, prefix))
}

function inListParams(column: Column, size: number, prefix: string): Param[] {
  return Array.from({ length: size }, (_, index) => param(column, `${prefix}${index}`))
}

/**
 * The placeholder values for an IN list prepared at `size`. Padding REPEATS the
 * last value: a duplicate in an IN list matches nothing a single copy does not,
 * so the rows (and the count of changed rows) are the ones the exact list gave,
 * and no sentinel value can ever collide with real data.
 */
export function inListValues(
  values: readonly unknown[],
  size: number,
  prefix = 'in',
  into: Record<string, unknown> = {},
): Record<string, unknown> {
  if (values.length > size) {
    throw new RangeError(`IN list of ${values.length} values prepared at size ${size}`)
  }
  const last = values[values.length - 1]
  for (let index = 0; index < size; index++) {
    into[`${prefix}${index}`] = index < values.length ? values[index] : last
  }
  return into
}

// ---------------------------------------------------------------------------
// Key prefixes
// ---------------------------------------------------------------------------

/**
 * THE KEYS THAT START WITH A PREFIX, AS A RANGE AN INDEX CAN SEEK [POD-6173].
 * Here since POD-6156, so the sync adapter and the server share it.
 *
 * `key LIKE 'prefix%'` reads every row: SQLite's LIKE optimisation needs a
 * literal pattern and a case-insensitive index, and a bound pattern has
 * neither. `key >= prefix AND key < prefixUpperBound(prefix)` selects exactly
 * the same keys through any index on `key`, and compares case-sensitively, as
 * an equality does.
 *
 * The bound is the prefix with its last character raised by one. That is exact
 * when the last character is ASCII: its UTF-8 form is one byte, so a key sorts
 * at or above the prefix and below the bound exactly when it starts with the
 * prefix. Every caller's prefix ends in a separator (`/`, `:`, `|`), so a prefix
 * that does not end in ASCII is a mistake and throws.
 */
export function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1)
  if (!(last < 0x7f)) {
    throw new Error(`a key prefix must end in an ASCII character: ${JSON.stringify(prefix)}`)
  }
  return prefix.slice(0, -1) + String.fromCharCode(last + 1)
}
