import { createSessionPaneReader } from './session-pane'
import { SettingsSource, type SettingsOwner } from './settings-source'
import { isSettingsEntity, SETTINGS_SCHEMA, SETUP_SESSION_SUMMARY_FIELDS, setupSessionSummary, type SetupSession } from './settings-schema'
import { createSettingsViews } from './settings-views'
import { PoolSources, mergePoolSummaries, type PoolSourceRows, type PoolSummaryFields, type SourceEntity } from './source-registry'
/**
 * POD-4565 (Ma1) — the MobX pool: one per principal. Entity tables from the
 * declared schema (`tables.ts`), models built on first access (`models.ts`),
 * row views (`views.ts`), and the locals as tracked state (selection as a
 * one-entry map, the clock as deadlines, `clock.ts`).
 *
 * WRITE PATH. `apply(event)` is one `runInAction`: an `update` ingests each
 * record (`ingestRecord`; the same object is a no-op, `undefined` removes);
 * a `replace` reseeds every table in the same action (`reseed`,
 * `enumerate.ts`), so no observer sees a half-installed pool. Removed rows
 * drop their model. `applyLocals` is the other action: a click moves two
 * selection keys, a tick fires the deadlines it crosses.
 *
 * RELATIONS (POD-4566, `relations.ts`). Every table write inside that action
 * tells the relation engine, which maintains every declared relation from
 * the schema; the action ends with one `flush`, which applies each touched
 * bucket's net moves once, one element per member added or removed.
 *
 * RESIDENCY (POD-4567, `residency.ts`). With a per-row read (`lazy.load`, the
 * feed's `RowSource.row`), rows the schema lets be cold (closed issues and
 * their sessions) never enter the tables: ingest registers their ids and the
 * relation engine links them. A derivation that reaches one through a lazy
 * relation gets `loading` and queues it; the 50 ms window's batch installs
 * every queued row in ONE action (`hydrate`). A row that stops being cold (a
 * reopen's sessions, an issue a session keeps shown) is installed from the
 * publication when it carries the row, else asked for the same way: the
 * window is the only per-row read (POD-4753). The harness drains the window
 * (`hydrate` in a loop) before it reads. Without `lazy` every row is
 * resident (Ma1/Ma2 tests).
 *
 * READ PATH. Every row a model, view, visibility part, roll-up or group
 * placement reads comes from ONE reader, `row(entity, id, absent)`
 * (POD-4743): the table's row, which is already the visible row (the pool's
 * transaction log writes pending changes into it, POD-5431/POD-5432, so the
 * reader lays nothing over it), and for a row not in memory the answer the
 * caller names (`AbsentRead`: `LOADING` with its load queued,
 * `LOADING` alone, or its current value by id through the feed). Every table
 * read goes through the tables, every relation read through the relation
 * engine. Derivations run lazily: a row field computes when a mounted row
 * reads it and suspends when nothing does (no `keepAlive`).
 *
 * STRICT FLAGS (POD-4760) live only in tests (`harness/src/mobx-enforce.ts`
 * exports them, `harness/src/mobx-trap.ts` applies them): importing the pool
 * never configures MobX.
 */

import type { RoutedUiState } from '@podium/client-core/ui-state'
import { debugName } from './debug-name'
import { PreferenceSource } from './preference-source'
import type { PreferenceRow } from './preference-schema'
import { SidebarIndex } from './worklist/sidebar'
import { MobileWorkIndex } from './worklist/mobile'
import { SidebarRosterIndex } from './worklist/sidebar-roster'
import {
  compareStructural,
  type IObservableArray,
  type IObservableValue,
  makeObservable,
  type ObservableMap,
  observable,
  observe,
  runInAction,
  untracked,
} from 'mobx'
import type { RelationReader } from './shared/relation-reader'
import { relationLinks } from './shared/links'
import { createHeaderViews } from './header-views'
import { HEADER_ISSUE_SUMMARY_FIELDS, HEADER_SESSION_SUMMARY_FIELDS } from './header-schema'
import { createHeaderEntities } from './header-entities'
import { isHeaderEntity, type HeaderEntity } from './header-schema'
import { COLD_SESSION_FIELDS, type EntityName, type ModelSchema, SCHEMA } from './shared/schema'
import type {
  LocalsKey,
  SliceIssue,
  SliceLocals,
  SliceSession,
} from './shared/slice-types'
import type { OutboxKinds } from '@podium/client-core/engine'
import type { RowSourceEvent } from './shared/source'
import {
  commandFor,
  type EditPatch,
  type TxId,
  type WritableKind,
  WriteContractError,
} from './shared/write-contract'
import { DeadlineClock } from './clock'
import { reseed } from './enumerate'
import { ReaderQueries } from './reader-queries'
import type { ColdQueries } from './shared/cold-index'
import {
  type EntityModel,
  type IssueModel,
  MODEL_CLASSES,
  type ModelOf,
  type SessionModel,
} from './models'
import { PoolRelations, type ReadableTables } from './relations'
import { type LoadRow, Residency, type Schedule } from './residency'
import { IssueReferences } from './issue-reference'
import {
  createObservableTables,
  ENTITIES,
  type IngestTarget,
  ingestOut,
  ingestRecord,
  type PoolTables,
} from './tables'
import type { RepoRow, ViewInputs } from './views'
import { WorklistGroups } from './worklist/groups'
import { LOADING, type Loaded, type RollupInputs } from './worklist/rollup'
import {
  type HeldIssue,
  HIDDEN_ISSUE_FIELDS,
  readAtOf,
  rollupInputsOf,
  VisibleCollection,
  type VisibleInputs,
} from './worklist/visible'

/**
 * POD-4678 (item 2): lower bound by id in a sorted seat list (default
 * `.sort()` order, UTF-16 code units via `<`): first index with
 * `list[i] >= id`. Insert there to keep id order; remove there when it holds
 * `id`. Family-small: binary search + splice shifting is trivial.
 */
function sortedIndex(list: { readonly length: number; readonly [i: number]: string }, id: string): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((list[mid] as string) < id) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** POD-4678 (item 2): no seats (shared frozen, never written; `seatList` absent case). */
const EMPTY_SEAT_LIST: readonly string[] = Object.freeze([])

/**
 * Whether the hot issue update `previous` → `next` moves only the read
 * cursor: the cursor differs (as a value) and every other field is equal.
 * Content-equal, so a new identity for an unchanged `deps` array still
 * counts; a new value anywhere else does not.
 */
function cursorOnlyChange(previous: object, next: object): boolean {
  const a = previous as Record<string, unknown>
  const b = next as Record<string, unknown>
  if (Object.is(a['readAt'], b['readAt'])) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  keys.delete('readAt')
  for (const key of keys) {
    if (!compareStructural(a[key], b[key])) return false
  }
  return true
}

/** Residency options: the per-row read, and (tests) the window and timer. */
export interface PoolLazyOptions {
  readonly load: LoadRow
  readonly cold?: () => ColdQueries
  readonly issueIdByRef?: (ref: string) => string | undefined
  /** Add the header's declared cold summaries only for its startup switch. */
  readonly header?: boolean
  readonly settings?: boolean
  /** Additional named cold fields, declared before the first row ingest. */
  readonly summaries?: PoolSummaryFields
  readonly windowMs?: number
  readonly schedule?: Schedule
}

/** The transaction log as the pool sees it (`write/transactions.ts`). */
export interface PoolMutator {
  mutate<K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]): TxId
  /** TRACKED: sessions painted as spawn placeholders, and their first turns. */
  readonly spawnPrompts: ReadonlyMap<string, string | null>
}

/**
 * What `MobxPool.row` answers for a row that is not in memory (a cold row):
 * - `load`: `LOADING`, and the row is queued for the next load window (a
 *   derivation's first access);
 * - `mark`: `LOADING`, nothing queued (maintenance inside an action, which
 *   must not arm the window);
 * - `peek`: the row's current value, read by id through the feed and counted,
 *   nothing queued (the visibility parts decide a cold row without loading it).
 * - `summary`: the resident row or the declared cold fields, with pending
 *   edits overlaid; a missing cold summary queues the normal batched load.
 * - `summary-fields`: the same declared fields and pending edits, without
 *   the worklist-only flatUntil decoration or copying the cold summary.
 * Unknown rows answer undefined in every mode.
 */
export type AbsentRead = 'load' | 'mark' | 'peek' | 'summary' | 'summary-fields'

/** Where a row stands, for a reader that asked for it by id (tracked). */
export type Residence = 'resident' | 'loading' | 'absent'

/** A lazy collection read: the members in memory, and how many are on their way. */
export interface LazyMembers {
  readonly ready: readonly string[]
  readonly pending: number
}

export class MobxPool {
  /** The tables: every read and write in the pool goes here. */
  readonly sidebar: SidebarIndex
  readonly mobileWork: MobileWorkIndex
  readonly sidebarRosters: SidebarRosterIndex
  private preferenceSource: PreferenceSource | undefined
  readonly sources = new PoolSources()
  readonly sessionPanes = createSessionPaneReader(this)
  private settingsSequence = 0
  private readonly settingsEnabled: boolean
  private readonly setupOrders: Map<string, number> | undefined
  private readonly setupOrderVersion: IObservableValue<number> | undefined
  readonly settingsViews = createSettingsViews(this)
  private readonly firstTaskCount = observable.box(0)
  private readonly firstTaskPending = observable.box(0)
  private headerState: ReturnType<typeof createHeaderEntities> | undefined
  /** Off means no extra observable maps, relations or sidebar census objects. */
  get header() {
    this.headerState ??= createHeaderEntities()
    return this.headerState
  }
  readonly headerViews = createHeaderViews(this)
  readonly tables: PoolTables
  readonly queries: ReaderQueries
  readonly relations: RelationReader
  /** The relation engine itself. */
  readonly graph: PoolRelations
  /** The selection local: at most one entry, the selected issue id. */
  readonly selection: ObservableMap<string, true>
  /**
   * The read-state lane (POD-4686): each known issue's read cursor, per-key
   * tracked, readable by id only. A mark-read writes one key; only that row's
   * `unread` (and a decay row's `flat`) re-runs. It is derived state populated
   * from the row the update arrived on, read like a cached computed.
   */
  readonly readStates: ObservableMap<string, string | null>
  readonly clock: DeadlineClock
  readonly inputs: ViewInputs
  /** What the visibility parts read (`worklist/visible.ts`). */
  readonly visibleInputs: VisibleInputs
  /** What the roll-up parts read (`worklist/rollup.ts`), over the visibility inputs. */
  readonly rollupInputs: RollupInputs
  /** The visible collection and its order. */
  readonly worklist: VisibleCollection
  /** The groups and closed folds over that order. */
  readonly groups: WorklistGroups
  /** `SliceLocals.selectedIssueWasFolded` (the R-GROUP 5 latch). */
  readonly foldLatch: IObservableValue<boolean>
  /** Residency (POD-4567); null when the pool holds every row. */
  readonly residency: Residency | null
  /**
   * The pool's transaction log (POD-5431, `write/transactions.ts`), attached
   * after construction because it repaints through the row source the pool is
   * built from. Null without one (a read-only pool). It writes visible rows
   * into the tables, so the one reader has nothing to lay over them.
   */
  private transactions: PoolMutator | null = null
  /** The log whose spawn placeholders pool screens read (it owns sessions). */
  private spawnLog: PoolMutator | null = null
  /** The one object per row, by entity: built on first request, never twice. */
  private readonly models: { readonly [E in EntityName]: Map<string, EntityModel> }
  private readonly target: IngestTarget
  private selectedId: string | null
  /**
   * POD-4678 — clears the maintained seat mirror (a closure over it, so the
   * copy sweep never walks the mirror: it holds only ids, never rows).
   * Functions are skipped by the sweep; closures stay a review item.
   */
  private readonly clearSeats: () => void
  private referenceReader: IssueReferences | undefined
  private readonly issueIdByRef: PoolLazyOptions['issueIdByRef']
  private disposed = false

  /** Built only for a screen that uses references. Its identity index covers
   * resident rows; cold identities are resolved through the same load window. */
  get references(): IssueReferences {
    this.referenceReader ??= new IssueReferences(this, ref => {
      if (!this.disposed) this.residency?.requestReference(ref)
    })
    return this.referenceReader
  }

  constructor(
    locals: SliceLocals,
    schema?: ModelSchema,
    lazy?: PoolLazyOptions,
  ) {
    this.issueIdByRef = lazy?.issueIdByRef
    this.settingsEnabled = lazy?.settings === true
    this.setupOrders = this.settingsEnabled ? new Map() : undefined
    this.setupOrderVersion = this.settingsEnabled ? observable.box(0, {
      name: debugName(() => 'pool.setupOrderVersion'),
    }) : undefined
    this.tables = createObservableTables()
    this.queries = new ReaderQueries(this, schema ?? SCHEMA, lazy?.cold)
    const tables = this.tables
    const residency =
      lazy === undefined
        ? null
        : new Residency({
            schema: schema ?? SCHEMA,
            hot: tables,
            residentRow: (entity, id) => {
              const row = this.row(entity, id, 'mark')
              return row === LOADING ? undefined : row
            },
            load: (entity, id) => lazy.load(entity, id),
            // Read at ingest, after the constructor has built the clock.
            now: () => this.clock.current,
            ...(lazy.windowMs === undefined ? {} : { windowMs: lazy.windowMs }),
            ...(lazy.schedule === undefined ? {} : { schedule: lazy.schedule }),
            // What visibility reads of a hidden issue (POD-4753), never the row.
            summaries: mergePoolSummaries({ issue: lazy.header ? [...HIDDEN_ISSUE_FIELDS, ...HEADER_ISSUE_SUMMARY_FIELDS] : HIDDEN_ISSUE_FIELDS, session: [...COLD_SESSION_FIELDS, ...(lazy.header ? HEADER_SESSION_SUMMARY_FIELDS : []), ...(lazy.settings ? SETUP_SESSION_SUMMARY_FIELDS : [])] }, lazy.summaries ?? {}),
            // The rule's lane source (R3, POD-4745) reads the engine, built below.
            lanes: () => this.graph,
          })
    this.residency = residency
    /**
     * The explicit seats (`issue.sessions`), maintained SORTED from the
     * relation's own bucket deltas (one element per move: binary search +
     * splice at its id-order position, never the family). The rule is declared
     * once in the schema (`issue.sessions`); this mirror follows the engine's
     * delta in the same action. Held in a closure (not a field) so the copy
     * sweep never walks it: it holds only ids, never rows (closures stay a
     * review item).
     *
     * The maintained SORTED array itself is returned without iterating it. A
     * membership change yields the new member only: O(1) for real.
     * `seatIdsPartOf` / `sessionIdsPartOf` read it, never the relation.
     */
    const seats = observable.map<string, IObservableArray<string>>(undefined, {
      deep: false,
      name: debugName(() => 'pool.seats'),
    })
    this.clearSeats = () => {
      seats.clear()
    }
    // The engine knows every KNOWN row (a target is present hot or cold) and
    // reads only resident ones: a cold row's fields it needs again it keeps
    // itself, from the row ingest hands it (POD-4753), never read by id.
    const known =
      residency === null
        ? tables
        : (Object.fromEntries(
            ENTITIES.map((entity) => [
              entity,
              {
                get: (id: string) => tables[entity].get(id),
                has: (id: string) => tables[entity].has(id) || residency.known(entity, id),
              },
            ]),
          ) as ReadableTables)
    this.graph = new PoolRelations({
      tables: known,
      probe: this.tables,
      ...(schema === undefined ? {} : { schema }),
      // File the explicit seat delta (one element) into the maintained SORTED
      // list, in the same action that moved the bucket: binary search by id
      // (default `.sort()` order, UTF-16 code units) + splice at its position.
      // No per-session reactions; the schema declares the rule once.
      // Family-small (2-3 ids): splice shifting is trivial.
      onBucket: (collection, target, member, added) => {
        if (collection === 'worktree.sessions') this.sidebarRosters.queueSession(member)
        if (collection !== 'issue.sessions') return
        if (added) {
          let list = seats.get(target)
          if (list === undefined) {
            list = observable.array<string>([], {
              deep: false,
              name: debugName(() => 'pool.seats.bucket'),
            })
            seats.set(target, list)
          }
          list.splice(sortedIndex(list, member), 0, member)
        } else {
          const list = seats.get(target)
          if (list === undefined) return
          const at = sortedIndex(list, member)
          if (at < list.length && list[at] === member) list.splice(at, 1)
          if (list.length === 0) seats.delete(target)
        }
      },
      ...(residency === null
        ? {}
        : {
            cold: {
              resident: (entity: EntityName, id: string) =>
                !residency.capable(entity) || tables[entity].has(id),
              observe: (entity: EntityName, id: string) => {
                residency.known(entity, id)
              },
              changed: (entity: EntityName, id: string) => residency.notify(entity, id),
            },
            onSubsetJoin: (collection: string, subset: string, _target: string, member: string) =>
              residency.laneJoined(collection, subset, member),
          }),
    })
    this.relations = this.graph
    this.selection = observable.map<string, true>(undefined, {
      deep: false,
      name: debugName(() => 'pool.selection'),
    })
    this.readStates = observable.map<string, string | null>(undefined, {
      deep: false,
      name: debugName(() => 'pool.reads'),
    })
    this.clock = new DeadlineClock(locals.coarseNow)
    this.models = Object.fromEntries(
      ENTITIES.map((entity) => [entity, new Map()]),
    ) as MobxPool['models']
    this.target = {
      read: this.tables,
      write: this.tables,
      relations: this.graph,
      volatile: {
        absorbIssueRead: (id, previous, next) => {
          if (!cursorOnlyChange(previous, next)) return false
          this.readStates.set(id, readAtOf((next as { readAt?: unknown }).readAt))
          return true
        },
        setIssueRead: (id, row) => {
          this.readStates.set(id, readAtOf((row as { readAt?: unknown }).readAt))
        },
        removeIssueRead: (id) => {
          this.readStates.delete(id)
        },
      },
      ...(residency === null ? {} : { residency }),
    }
    this.sidebarRosters = new SidebarRosterIndex(this)
    this.sidebar = new SidebarIndex(this)
    this.mobileWork = new MobileWorkIndex(this)
    this.selectedId = null
    // Every row below comes from the one reader (`row`); none of these
    // functions is replaced after construction (pending changes arrive as
    // rows, from the transaction log). A view reads rows in memory: a row that
    // is not answers undefined, its load queued.
    const inMemory = (row: Loaded<object>): object | undefined => (row === LOADING ? undefined : row)
    const links = relationLinks(this.relations, this.graph.schema)
    this.inputs = {
      links,
      issue: (id) => inMemory(this.row('issue', id)) as SliceIssue | undefined,
      session: (id) => inMemory(this.row('session', id)) as SliceSession | undefined,
      // The member's cached stamp (its object's, hot or cold): no row read.
      sessionActivity: (id) => (this.object('session', id) as SessionModel).activityMs,
      repo: (id) => inMemory(this.row('repo', id)) as RepoRow | undefined,
      // An issue answers from its object's cached in-memory read (no table
      // probe per run); other entities from the table.
      present: (entity, id) =>
        entity === 'issue'
          ? this.issueObject(id).loaded.facts.state === 'ready'
          : tables[entity].has(id),
      loading: (entity, id) => residency?.loading(entity, id) ?? false,
      // Only asked for an issue in memory (`originTickPartOf`): its object.
      parts: (id) => this.issueObject(id),
      rollup: (id) => this.knownIssue(id)?.rollup,
      retainedSeats: (id) => this.knownIssue(id)?.retainedSeatIds ?? [],
      // The maintained SORTED list itself, returned without iterating it. A
      // membership change yields the new member only; the family is never
      // yielded here. Closure-held, ids only.
      seatList: (id) => seats.get(id) ?? EMPTY_SEAT_LIST,
      selected: (id) => this.selection.has(id),
      reached: (t) => this.clock.reached(t),
      passed: (t) => this.clock.passed(t),
    }
    this.visibleInputs = {
      links,
      // Hot or cold: a cold row is read by id through the feed, never loaded.
      issueRow: (id) => this.row('issue', id, 'peek') as SliceIssue | undefined,
      sessionRow: (id) => this.row('session', id, 'peek') as SliceSession | undefined,
      issue: (id) => this.knownIssue(id),
      session: (id) => this.object('session', id) as SessionModel,
      passed: (t) => this.clock.passed(t),
      reached: (t) => this.clock.reached(t),
      loadedIssue: (id) => this.row('issue', id) as Loaded<SliceIssue>,
      loadedSession: (id) => this.row('session', id) as Loaded<SliceSession>,
      issueRead: (id) => this.readCursor(id),
      nested: (id) => this.issueObject(id).nested,
      formalChildren: (id) => links.issue.children.ids(id),
      // The maintained SORTED list itself, returned without iterating it — a
      // membership change yields the new member only. `seatIdsPartOf` reads
      // it, never the relation.
      seatList: (id) => seats.get(id) ?? EMPTY_SEAT_LIST,
    }
    this.rollupInputs = rollupInputsOf(this.visibleInputs)
    this.worklist = new VisibleCollection({
      issue: (id) => this.issueObject(id),
      fileGroups: (id, filing) => this.groups.file(id, filing),
      fileSidebarOwner: (id, owner) => this.sidebarRosters.fileOwner(id, owner),
    })
    this.foldLatch = observable.box(locals.selectedIssueWasFolded === true, {
      name: debugName(() => 'pool.foldLatch'),
    })
    this.groups = new WorklistGroups({
      node: (id) => this.knownIssue(id),
      // At most one entry (`select`): the key walk is the selection itself.
      selectedId: () => this.selection.keys().next().value ?? null,
      foldLatch: () => this.foldLatch.get(),
    })
    makeObservable<
      MobxPool,
      | 'models'
      | 'headerState'
      | 'preferenceSource'
      | 'settingsSequence'
      | 'settingsEnabled'
      | 'setupOrders'
      | 'setupOrderVersion'
      | 'firstTaskCount'
      | 'firstTaskPending'
      | 'firstTaskState'
      | 'updateFirstTaskCount'
      | 'target'
      | 'selectedId'
      | 'select'
      | 'followTable'
      | 'clearSeats'
      | 'referenceReader'
      | 'issueIdByRef'
      | 'disposed'
      | 'object'
      | 'release'
      | 'hidden'
      | 'transactions'
      | 'spawnLog'
    >(this, {
      sidebar: false,
      mobileWork: false,
      references: false,
      referenceReader: false,
      issueIdByRef: false,
      disposed: false,
      sidebarRosters: false,
      tables: false,
      queries: false,
      header: false,
      headerState: false,
      preferenceSource: false,
      sources: false,
      sessionPanes: false,
      settingsSequence: false,
      settingsEnabled: false,
      setupOrders: false,
      setupOrderVersion: false,
      settingsViews: false,
      firstTaskCount: false,
      firstTaskPending: false,
      firstTaskState: false,
      updateFirstTaskCount: false,
      attachSettings: false,
      attachPreferences: false,
      preferenceKeys: false,
      preferenceCounts: false,
      headerViews: false,
      relations: false,
      graph: false,
      selection: false,
      readStates: false,
      clock: false,
      inputs: false,
      visibleInputs: false,
      worklist: false,
      groups: false,
      foldLatch: false,
      rollupInputs: false,
      object: false,
      issueObject: false,
      knownIssue: false,
      hasFirstTask: false,
      release: false,
      edit: false,
      transactions: false,
      spawnLog: false,
      attachTransactions: false,
      spawnPlaceholders: false,
      mutate: false,
      row: false,
      rosterCandidates: false,
      rosterColdPending: false,
      readCursor: false,
      models: false,
      target: false,
      selectedId: false,
      clearSeats: false,
      residency: false,
      resident: false,
      lazyMany: false,
      hidden: false,
      hydrate: false,
      model: false,
      issue: false,
      apply: false,
      applyLocals: false,
      dispose: false,
      select: false,
      // Maintenance called inside actions, never observed.
      followTable: false,
    })
    // Every issue in memory holds its filing reaction: taken when its row
    // enters the table, released when it leaves (inside the action that
    // moved it; the reaction first runs when that action ends).
    observe(this.tables.issue, (change) => this.followTable(change.type, change.name))
    observe(this.tables.session, (change) => this.sidebarRosters.queueSession(change.name))
    observe(this.tables.worktree, (change) => this.sidebarRosters.fileWorktree(change.name))
    runInAction(() => this.select(locals.selectedIssueId))
    residency?.onDue(() => this.hydrate())
  }

  /**
   * TRACKED: THE row reader (POD-4743). Every row a model, view, visibility
   * part, roll-up or placement reads comes from here, so they all see one
   * value.
   *
   * In memory: the table's row as it stands, the same object on every read.
   * Pending changes are already in it: the transaction log rebases a row and
   * writes the result into the table (POD-5432), so there is no read-time
   * overlay, no Proxy and no per-read pending lookup. Resident readers
   * subscribe to the table slot.
   *
   * Not in memory (cold, POD-4567): what `absent` names (`AbsentRead`). A
   * cold row's value is read by id through the feed; it is tracked by
   * residency's per-id atom, which reports every relink and the load.
   * Unknown rows answer undefined. Never blocks.
   */
  attachPreferences(ui: RoutedUiState): void {
    if (this.preferenceSource) throw new Error('Preferences already attached to this pool')
    this.preferenceSource = new PreferenceSource(ui)
  }

  preferenceKeys(): readonly string[] { return this.preferenceSource?.keys() ?? [] }
  preferenceCounts() { return this.preferenceSource?.counts ?? null }

  attachSettings(owner: SettingsOwner): void {
    this.sources.register(Object.keys(SETTINGS_SCHEMA).filter(isSettingsEntity), new SettingsSource(owner))
  }

  row<E extends SourceEntity>(entity: E, id: string): Loaded<PoolSourceRows[E]>
  row(entity: 'setupSession', id: string): Loaded<SetupSession>
  row(entity: 'preference', id: string): Loaded<PreferenceRow>
  row(entity: HeaderEntity, id: string): object | undefined
  row(entity: EntityName, id: string, absent: 'peek'): object | undefined
  row(entity: EntityName, id: string, absent?: 'load' | 'mark' | 'summary' | 'summary-fields'): Loaded<object>
  row(entity: EntityName | HeaderEntity | SourceEntity | 'setupSession' | 'preference', id: string, absent: AbsentRead = 'load'): Loaded<object> {
    if (entity === 'setupSession') {
      const row = this.row('session', id, 'summary')
      // Only source-order changes wake this metadata dependency. No tracking
      // object or full-row copy is installed for a cold session at ingest.
      this.setupOrderVersion?.get()
      return row && row !== LOADING ? setupSessionSummary(row as Readonly<Record<string, unknown>>, this.setupOrders?.get(id)) : row
    }
    if (entity === 'preference') return this.preferenceSource?.read(id) ?? LOADING
    if (isHeaderEntity(entity)) return this.header.get(entity, id)
    if (!Object.hasOwn(this.tables, entity)) return this.sources.read(entity as SourceEntity, id)
    const core = entity as EntityName
    const residency = this.residency
    // The residency key already reports cold-summary changes, hydration and
    // removal. Do not also subscribe to an absent table slot for that row.
    const coldSummary = (absent === 'summary' || absent === 'summary-fields') &&
      residency?.isCold(core, id) === true && !untracked(() => this.tables[core].has(id))
    let server = coldSummary ? undefined : this.tables[core].get(id) as object | undefined
    if (server === undefined) {
      if (residency === null) return undefined
      if (absent === 'load') return residency.loading(core, id) ? LOADING : undefined
      if (!residency.known(core, id)) return undefined
      if (absent === 'mark') return LOADING
      if (absent === 'summary' || absent === 'summary-fields') {
        server = residency.summary(core, id, absent === 'summary')
        if (server === undefined) return residency.loading(core, id) ? LOADING : undefined
      } else server = core === 'session' ? residency.summary(core, id) ?? residency.read(core, id) : residency.read(core, id)
      if (server === undefined) return undefined
    }
    return server
  }

  /** Scalar maintained at issue deltas and hydration, including archived and
   * draft rows. Getter cost is independent of both hot and cold history. */
  get hasFirstTask(): Loaded<boolean> {
    return this.firstTaskCount.get() > 0 ? true : this.firstTaskPending.get() > 0 ? LOADING : false
  }

  private firstTaskState(id: string): Loaded<boolean> {
    const resident = this.row('issue', id, 'mark') as Loaded<SliceIssue>
    if (resident !== LOADING) return resident && !resident.deletedAt
    const summary = this.hidden('issue', id)
    if (summary && 'stage' in summary) return !summary['deletedAt']
    // Missing declared summary: the existing window loads it in one batch.
    void this.row('issue', id)
    return LOADING
  }

  private updateFirstTaskCount(before: Loaded<boolean>, after: Loaded<boolean>): void {
    this.firstTaskCount.set(this.firstTaskCount.get() + Number(after === true) - Number(before === true))
    this.firstTaskPending.set(this.firstTaskPending.get() + Number(after === LOADING) - Number(before === LOADING))
  }

  rosterCandidates(path: string): Iterable<string> { return this.sidebarRosters.candidates(path) }
  rosterColdPending(path: string): boolean { return this.sidebarRosters.coldPending(path) }

  /**
   * TRACKED: an issue's read cursor, from the read-state lane (POD-4686: per
   * key, so a mark-read re-validates only its own row). A pending mark-read is
   * already in it: the lane follows the visible row the log painted.
   */
  readCursor(id: string): string | null | undefined {
    return this.readStates.get(id)
  }

  /** The model of a row in memory, built on first request; undefined when absent (tracked). */
  model<E extends EntityName>(entity: E, id: string): ModelOf[E] | undefined {
    if (!this.tables[entity].has(id)) return undefined
    return this.object(entity, id) as ModelOf[E]
  }

  /**
   * The one object of `entity:id`, built on first request, whether or not its
   * row is in memory (the worklist holds cold issues too; their visibility
   * reads the cold row by id). Untracked: an identity memo.
   */
  private object(entity: EntityName, id: string): EntityModel {
    const models = this.models[entity]
    let model = models.get(id)
    if (model === undefined) {
      model = new MODEL_CLASSES[entity](id, this)
      models.set(id, model)
    }
    return model
  }

  /**
   * Forget the object of `entity:id` once nothing can ask for it again as
   * the same row: an issue neither in memory nor tracked by the worklist, a
   * session no longer known, any other row no longer in memory.
   */
  private release(entity: EntityName, id: string): void {
    if (this.tables[entity].has(id)) return
    if (entity === 'issue' && this.worklist.tracks(id)) return
    if (entity === 'session' && this.residency?.isCold('session', id) === true) return
    this.models[entity].delete(id)
  }

  /** The one object of issue `id`, built on first request (untracked: an identity memo). */
  issueObject(id: string): IssueModel {
    return this.object('issue', id) as IssueModel
  }

  /**
   * TRACKED: the object of issue `id` while the pool knows the issue (in
   * memory or cold), else undefined: a cross-issue read (a parent, a child,
   * a starter's owner) that reaches an unknown id re-runs when it becomes
   * known. A presence probe, not a row read.
   */
  knownIssue(id: string): HeldIssue | undefined {
    const known = this.tables.issue.has(id) || this.residency?.known('issue', id) === true
    return known ? this.issueObject(id) : undefined
  }

  /** A model's edit (`issue.title = x`): one transaction of the pool's log. */
  edit<K extends WritableKind>(entity: K, id: string, patch: EditPatch<K>): TxId {
    if (this.transactions === null) {
      throw new WriteContractError(`the pool has no transaction log: cannot edit ${entity} ${id}`)
    }
    const command = commandFor(entity, id, patch)
    return this.transactions.mutate(command.kind, command.input)
  }

  /** Attach the transaction log (POD-5431); one per pool, before any change.
   * `ownsSessions` (POD-5432, plan step 6): the log, not the ledger, paints
   * session rows, so the spawn placeholders are read from it too. */
  attachTransactions(transactions: PoolMutator, ownsSessions = true): void {
    if (this.transactions !== null) {
      throw new WriteContractError('the pool already has a transaction log')
    }
    this.transactions = transactions
    this.spawnLog = ownsSessions ? transactions : null
  }

  /**
   * TRACKED: the sessions painted as spawn placeholders and their first turns
   * (null when none), while the pool owns session optimism (POD-5432); null
   * otherwise, and readers keep the ledger's `pendingSpawnIds`.
   */
  spawnPlaceholders(): ReadonlyMap<string, string | null> | null {
    return this.spawnLog?.spawnPrompts ?? null
  }

  /**
   * One change, any queued command (POD-5431): the model and every reader of
   * it see the new visible row in the same action, and the outbox takes the
   * command. Refused without the transaction log (the switch is off).
   */
  mutate<K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]): TxId {
    if (this.transactions === null) {
      throw new WriteContractError(`the pool has no transaction log: cannot ${kind}`)
    }
    return this.transactions.mutate(kind, input)
  }

  issue(id: string): ModelOf['issue'] | undefined {
    return this.model('issue', id)
  }

  /** TRACKED: the declared parent key, without reading either row's fields.
   * Only the source changes this relation: its table slot or cold residency
   * address already reports those writes, including removal and promotion. */
  formalParent(id: string): string | null {
    if (this.tables.issue.get(id) === undefined) this.residency?.known('issue', id)
    return untracked(() => this.graph.forwardTarget('issue', id, 'parent'))
  }

  /**
   * TRACKED: where the row `entity:id` stands. A cold row answers `loading`
   * and is queued (first access); a reader renders that as loading, never as
   * an empty row.
   */
  resident(entity: EntityName, id: string): Residence {
    if (this.tables[entity].has(id)) return 'resident'
    return this.residency?.loading(entity, id) === true ? 'loading' : 'absent'
  }

  /**
   * TRACKED: the declared summary of a row the cold rule keeps hidden
   * (POD-4753): a hidden issue's visibility reads it instead of its row.
   * Undefined for a row in memory, one held out beside the rule, or unknown.
   */
  private hidden(entity: EntityName, id: string): Readonly<Record<string, unknown>> | undefined {
    const residency = this.residency
    if (residency === null) return undefined
    // A row in memory is never hidden, and its reader already tracks its
    // table slot (a `replace` that makes it cold rewrites that slot): asked
    // untracked, so no residency atom is made per issue in memory.
    if (untracked(() => this.tables[entity].has(id))) return undefined
    if (!residency.hidden(entity, id)) return undefined
    return residency.summary(entity, id) ?? {}
  }

  /**
   * TRACKED: a lazy collection (Rule L) as its resident members plus the
   * count still loading, every cold one queued. The shape a roll-up reads
   * (Mb3): it derives from `ready` and reports loading while `pending > 0`.
   * `ready` is in bucket order, which is unordered (M3 F1).
   */
  lazyMany(from: EntityName, id: string, relation: string): LazyMembers {
    const to = this.graph.schema[from].relations[relation]?.to
    if (to === undefined) throw new Error(`[pool] ${from}.${relation} is not a declared relation`)
    const ready: string[] = []
    let pending = 0
    for (const member of this.relations.many(from, id, relation)) {
      if (this.tables[to].has(member)) ready.push(member)
      else if (this.residency?.loading(to, member) === true) pending += 1
    }
    return { ready, pending }
  }

  /**
   * Close the load window now: install every queued cold row, read by id
   * through the feed, in ONE action. The window's timer calls this; the
   * harness drains it in a loop before it reads. Returns how many rows the
   * window installed.
   *
   * A row it installs enters the issue table, which gives it its filing
   * reaction (`followTable`); the rows it no longer keeps cold are asked for
   * in turn, and the lanes it moved are settled (`Residency.install`).
   */
  hydrate(): number {
    const residency = this.residency
    if (residency === null) return 0
    const batch = residency.take()
    const refs = residency.takeReferences()
    const identities = refs.map(ref => [ref, this.issueIdByRef?.(ref) ?? null] as const)
    const queuedIssues = new Set(batch.filter(([entity]) => entity === 'issue').map(([, id]) => id))
    for (const [, id] of identities) {
      if (id !== null && residency.isCold('issue', id) && !queuedIssues.has(id)) {
        queuedIssues.add(id)
        batch.push(['issue', id])
      }
    }
    if (batch.length === 0 && identities.length === 0) return 0
    const out = ingestOut()
    this.graph.begin()
    return runInAction(() => {
      for (const [ref, id] of identities) this.referenceReader?.resolved(ref, id)
      const before = new Map<string, Loaded<boolean>>(batch.filter(([entity]) => entity === 'issue').map(([, id]) => [id, this.firstTaskState(id)]))
      const rows = residency.install(this.target, batch, out)
      for (const [id, previous] of before) this.updateFirstTaskCount(previous, this.firstTaskState(id))
      this.graph.flush()
      this.sidebarRosters.flush()
      return rows
    })
  }

  /** One feed publication, one action. */
  apply(event: RowSourceEvent): void {
    const out = ingestOut()
    this.graph.begin()
    runInAction(() => {
      const orders = this.setupOrders
      if (orders) {
        let changed = false
        if (event.type === 'replace') {
          this.settingsSequence = 0
          const present = new Set(event.rows.filter(row => row.kind === 'session' && row.value).map(row => row.id))
          for (const id of orders.keys()) if (!present.has(id)) changed = orders.delete(id) || changed
        }
        for (const record of event.rows) {
          if (record.kind !== 'session') continue
          if (!record.value) changed = orders.delete(record.id) || changed
          else if (event.type === 'replace' || !orders.has(record.id)) {
            const order = ++this.settingsSequence
            if (orders.get(record.id) !== order) { orders.set(record.id, order); changed = true }
          }
        }
        if (changed) this.setupOrderVersion?.set(this.setupOrderVersion.get() + 1)
      }
      // Only this publication's ids are retained, until its action finishes.
      // Cold values come from the declared summary; no all-issue index.
      const before = new Map<string, Loaded<boolean>>()
      for (const record of event.rows) {
        if (record.kind === 'issue' && !before.has(record.id)) before.set(record.id,
          event.type === 'replace' ? undefined : this.firstTaskState(record.id))
      }
      if (event.type === 'replace') {
        this.firstTaskCount.set(0)
        this.firstTaskPending.set(0)
        this.referenceReader?.resetUnresolved()
        reseed(this.target, event.rows, out)
      }
      else {
        // POD-4753: a row this update carries is installed from it; any
        // other row it warms is asked for (the load window).
        this.residency?.publication(event.rows)
        for (const record of event.rows) ingestRecord(this.target, record, out)
        // POD-4745: a member or a lane member that can now keep a cold row
        // shown warms it, once every row of the update is in.
        this.residency?.settle(this.target, out)
      }
      for (const [id, previous] of before) this.updateFirstTaskCount(previous, this.firstTaskState(id))
      this.graph.flush()
      for (const record of event.rows) {
        if (record.kind === 'session') this.sidebarRosters.queueSession(record.id)
        if (record.kind === 'issue') {
          this.sidebarRosters.queueIssue(record.id)
          if (record.value && this.residency?.isCold('issue', record.id))
            this.referenceReader?.arrived(record.value as SliceIssue)
        }
      }
      this.sidebarRosters.flush()
      this.queries.publish(event)
    })
    for (const [entity, id] of out.removed) this.release(entity, id)
  }

  /**
   * Archived/deleted rows release their filing reaction and take it again on
   * return. Stage exclusions retain theirs: pending edits can change stage
   * through the one reader without an authoritative table publication.
   */
  private followTable(type: 'add' | 'update' | 'delete', id: string): void {
    const row = type === 'delete' ? undefined : this.row('issue', id, 'mark') as Readonly<Record<string, unknown>> | undefined
    if (row === undefined || row['archived'] === true || row['deletedAt'] != null) {
      this.worklist.untrack(id)
      const summary = row ?? this.hidden('issue', id)
      if (summary && (summary['archived'] === true || summary['deletedAt'] != null)) {
        this.sidebarRosters.fileOwner(id, { represented: false, excluded: true, unownedIds: [] })
      }
    } else {
      this.worklist.track(id)
    }
  }

  /** One locals notification, one action: only the keys it names. */
  applyLocals(locals: SliceLocals, changed: ReadonlySet<LocalsKey>): void {
    const selection = changed.has('selectedIssueId')
    const latch = changed.has('selectedIssueWasFolded')
    const clock = changed.has('coarseNow')
    if (!selection && !latch && !clock) return
    runInAction(() => {
      if (selection && locals.selectedIssueWasFolded === undefined) {
        this.foldLatch.set(locals.selectedIssueId !== null && this.groups.placementOf(locals.selectedIssueId)?.closed === true)
      }
      if (selection) this.select(locals.selectedIssueId)
      if (latch) this.foldLatch.set(locals.selectedIssueWasFolded === true)
      if (clock) {
        this.clock.advance(locals.coarseNow)
        this.sidebarRosters.advanceClock(locals.coarseNow)
      }
    })
  }

  /** Empty every table, model cache, selection and clock registration. */
  dispose(): void {
    this.queries.dispose()
    this.disposed = true
    this.preferenceSource?.dispose()
    this.sources.dispose()
    this.settingsViews.clear()
    this.referenceReader?.dispose()
    runInAction(() => {
      this.worklist.clear()
      this.groups.clear()
      for (const entity of ENTITIES) this.tables[entity].clear()
      this.graph.clear()
      this.headerState?.clear()
      this.headerViews.clear()
      this.clearSeats()
      this.selection.clear()
      this.readStates.clear()
      this.sidebarRosters.clear()
      this.firstTaskCount.set(0)
      this.firstTaskPending.set(0)
      this.setupOrders?.clear()
    })
    for (const entity of ENTITIES) this.models[entity].clear()
    this.residency?.clear()
    this.clock.clear()
    this.selectedId = null
  }

  private select(id: string | null): void {
    if (id === this.selectedId) return
    if (this.selectedId !== null) this.selection.delete(this.selectedId)
    if (id !== null) this.selection.set(id, true)
    this.selectedId = id
  }
}
