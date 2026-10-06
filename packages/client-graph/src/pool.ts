import { joinedFields, SESSION_JOIN_FIELDS } from './shared/joined-fields'
import {
  SETUP_SESSION_SUMMARY_FIELDS,
  type SetupSession,
} from './settings-schema'
import { readSetupSession } from './settings-views'
import {
  mergePoolSummaries,
  type PoolSourceRows,
  PoolSources,
  type PoolSummaryFields,
  type SourceEntity,
} from './source-registry'

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

import type { OutboxKinds } from '@podium/client-core/engine'
import {
  compareStructural,
  type IObservableArray,
  type IObservableValue,
  type ObservableMap,
  observable,
  observe,
  runInAction,
  untracked,
} from 'mobx'
import { DeadlineClock } from './clock'
import { debugName } from './debug-name'
import { reseed } from './enumerate'
import { headerEntities } from './header-entities'
import {
  HEADER_ISSUE_SUMMARY_FIELDS,
  HEADER_SESSION_SUMMARY_FIELDS,
  type HeaderEntity,
  isHeaderEntity,
} from './header-schema'
import { referenceViewIfPresent } from './issue-reference'
import {
  type EntityModel,
  type IssueModel,
  MODEL_CLASSES,
  type ModelOf,
  type SessionModel,
} from './models'
import type { PreferenceRow } from './preference-schema'
import { preferenceSource } from './preference-source'
import { ReaderQueries } from './reader-queries'
import { PoolRelations } from './relations'
import { type LoadRow, Residency, type Schedule } from './residency'
import { type ColdIndex, type ColdQueries, createColdIndex } from './shared/cold-index'
import { relationLinks } from './shared/links'
import type { RelationReader } from './shared/relation-reader'
import { COLD_SESSION_FIELDS, type EntityName, type ModelSchema, SCHEMA } from './shared/schema'
import type { LocalsKey, SliceIssue, SliceLocals, SliceSession } from './shared/slice-types'
import { FeedDiagnostics } from './shared/feed-diagnostics'
import type { RowSourceEvent } from './shared/source'
import {
  commandFor,
  type EditPatch,
  type TxId,
  type WritableKind,
  WriteContractError,
} from './write/commands'
import {
  createObservableTables,
  ENTITIES,
  type IngestTarget,
  ingestOut,
  ingestRecord,
  type PoolTables,
} from './tables'
import type { RepoRow, ViewInputs } from './views'
import { worklistGroups } from './worklist/groups'
import { LOADING, type Loaded, type RollupInputs } from './worklist/rollup'
import { SeatVerdicts } from './worklist/seat-verdicts'
import { sidebarView } from './worklist/sidebar'
import { sidebarRosterView } from './worklist/sidebar-roster'
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
function sortedIndex(
  list: { readonly length: number; readonly [i: number]: string },
  id: string,
): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((list[mid] as string) < id) lo = mid + 1
    else hi = mid
  }
  return lo
}

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
  readonly diagnostics?: FeedDiagnostics
  readonly load: LoadRow
  /** The feed's cold index (`RowSource.cold`), holding these declared summary fields. */
  readonly cold?: (summaries: PoolSummaryFields) => ColdQueries
  readonly issueIdByRef?: (ref: string) => string | undefined
  /** Add the header's declared cold summaries only for its startup switch. */
  readonly header?: boolean
  readonly settings?: boolean
  /** Additional named cold fields, declared before the first row ingest. */
  readonly summaries?: PoolSummaryFields
  readonly windowMs?: number
  readonly schedule?: Schedule
  /**
   * POD-5423: `held` (the default) keeps the worklist's lanes filed for the
   * pool's life; `demand` files them only while a screen holds them
   * (`worklist.retain`) or a reader reads a lane, so a pool with no list on
   * screen keeps no per-issue filing reaction or visibility graph.
   */
  readonly worklist?: 'held' | 'demand'
}

/** The transaction log as the pool sees it (`write/transactions.ts`). */
export interface PoolMutator {
  mutate<K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]): TxId
  notSaved?(kind: 'issue' | 'session', id: string): boolean
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
/** What the cold index holds per issue for `readCursor`. */
const READ_CURSOR_FIELDS = ['readAt'] as const

export type AbsentRead = 'load' | 'mark' | 'peek' | 'summary' | 'summary-fields'

/** Where a row stands, for a reader that asked for it by id (tracked). */
export type Residence = 'resident' | 'loading' | 'absent'

/** A lazy collection read: the members in memory, and how many are on their way. */
export interface LazyMembers {
  readonly ready: readonly string[]
  readonly pending: number
}

export class MobxPool {
  /** Failure counters and replacement recovery status for this principal. */
  readonly diagnostics: FeedDiagnostics
  /** Each summarised issue's explicit seats, judged per seat change (POD-5423). */
  private readonly seatVerdicts: SeatVerdicts
  readonly sources = new PoolSources()
  /** The index's `positionVersion` the settings rows last saw. */
  private positionsSeen = -1
  private readonly sourcePositionVersion: IObservableValue<number> | undefined
  /** The source index's undeleted issue count, published with each batch. */
  private readonly issueCount = observable.box(0)
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
  /** POD-4678: an issue's maintained SORTED seat list (made on first read). */
  private readonly seatList: (id: string) => readonly string[]
  /** Refresh every seat list made so far (after an attach). */
  private readonly reseatAll: () => void
  /** The pool's own cold index, when its feed has none (fixtures, standalone pools). */
  private ownIndex: ColdIndex | undefined
  private readonly sourceIndex: (() => ColdQueries) | undefined
  /** The index the pool last applied a publication with (a source may replace its index). */
  private indexSeen: ColdQueries | undefined
  /** What a disposed pool answers from: nothing. */
  private emptyIndex: ColdIndex | undefined
  private readonly issueIdByRef: PoolLazyOptions['issueIdByRef']
  private readonly joinedRows = new WeakMap<object, object>()
  private companionMachineRows = observable.map<string, Record<string, unknown>>()
  private disposed = false

  requestReference(ref: string): void {
    if (!this.disposed) this.residency?.requestReference(ref)
  }

  constructor(locals: SliceLocals, schema?: ModelSchema, lazy?: PoolLazyOptions) {
    this.diagnostics = lazy?.diagnostics ?? new FeedDiagnostics()
    this.issueIdByRef = lazy?.issueIdByRef
    this.sourcePositionVersion = lazy?.settings === true
      ? observable.box(0, {
          name: debugName(() => 'pool.sourcePositionVersion'),
        })
      : undefined
    this.tables = createObservableTables()
    // POD-5407: the cold index holds every relation and the cold rule's
    // inputs for every row the feed carries. A source's own index is used as
    // it stands (the source applies each publication before the pool sees
    // it); a feed without one gets the pool's, applied first in each
    // publication's action.
    // What visibility reads of a hidden issue (POD-4753), never the row, and
    // what the screens declared. The cold index holds these fields per row,
    // so a cold row's declared summary costs no row read (POD-5407).
    const summaries =
      lazy === undefined
        ? undefined
        : mergePoolSummaries(
            {
              issue: lazy.header
                ? [...HIDDEN_ISSUE_FIELDS, ...HEADER_ISSUE_SUMMARY_FIELDS]
                : HIDDEN_ISSUE_FIELDS,
              session: [
                ...COLD_SESSION_FIELDS,
                ...(lazy.header ? HEADER_SESSION_SUMMARY_FIELDS : []),
                ...(lazy.settings ? SETUP_SESSION_SUMMARY_FIELDS : []),
              ],
            },
            lazy.summaries ?? {},
          )
    // The index also holds each issue's read cursor (`readCursor`).
    const held = mergePoolSummaries(summaries ?? {}, { issue: ['readAt'] })
    const sourceCold = lazy?.cold
    this.sourceIndex = sourceCold === undefined ? undefined : () => sourceCold(held)
    this.ownIndex =
      this.sourceIndex === undefined ? createColdIndex(schema ?? SCHEMA, held) : undefined
    this.queries = new ReaderQueries(this, schema ?? SCHEMA, () => this.coldIndex())
    const tables = this.tables
    const residency =
      lazy === undefined
        ? null
        : new Residency({
            schema: schema ?? SCHEMA,
            hot: tables,
            index: () => this.coldIndex(),
            load: (entity, id) => lazy.load(entity, id),
            // Read at ingest, after the constructor has built the clock.
            now: () => this.clock.peekNow(),
            ...(lazy.windowMs === undefined ? {} : { windowMs: lazy.windowMs }),
            ...(lazy.schedule === undefined ? {} : { schedule: lazy.schedule }),
            summaries: summaries ?? {},
          })
    this.residency = residency
    /**
     * The explicit seats (`issue.sessions`), maintained SORTED from the
     * relation's own bucket deltas (one element per move: binary search +
     * splice at its id-order position, never the family). The rule is declared
     * once in the schema (`issue.sessions`); this mirror follows the index's
     * delta in the same action. POD-5407: a list is made on its first read,
     * from the relation index (sorted once), and only lists something has
     * read are kept up: no list exists for an issue nobody asked about. Held
     * in a closure (not a field) so the copy sweep never walks it: it holds
     * only ids, never rows (closures stay a review item).
     *
     * The maintained SORTED array itself is returned without iterating it. A
     * membership change yields the new member only: O(1) for real.
     * `seatIdsPartOf` / `sessionIdsPartOf` read it, never the relation.
     */
    const seats = new Map<string, IObservableArray<string>>()
    this.clearSeats = () => {
      seats.clear()
    }
    this.seatList = (id) => {
      let list = seats.get(id)
      if (list === undefined) {
        list = observable.array<string>(
          // untracked-read: pool-seat-seed
          [...untracked(() => this.graph.members('issue', id, 'sessions'))],
          {
            deep: false,
            name: debugName(() => 'pool.seats.bucket'),
          },
        )
        seats.set(id, list)
      }
      return list
    }
    this.reseatAll = () => {
      for (const [id, list] of seats) {
        const members = this.graph.members('issue', id, 'sessions')
        if (members.length !== list.length || members.some((member, at) => list[at] !== member))
          list.replace([...members])
      }
    }
    this.graph = new PoolRelations({
      index: () => this.coldIndex().relations,
      // A target is present when it is in memory, or known and cold (tracked).
      present: (entity, id) => tables[entity].has(id) || (residency?.known(entity, id) ?? false),
      ...(schema === undefined ? {} : { schema }),
      // File the explicit seat delta (one element) into a list something has
      // read, in the same action that moved the bucket: binary search by id
      // (default `.sort()` order, UTF-16 code units) + splice at its position.
      onBucket: (collection, target, member, added) => {
        if (collection === 'worktree.sessions') sidebarRosters.queueSession(member)
        if (collection !== 'issue.sessions') return
        this.seatVerdicts.queueMember(target, member, added)
        const list = seats.get(target)
        if (list === undefined) return
        const at = sortedIndex(list, member)
        const present = at < list.length && list[at] === member
        if (added && !present) list.splice(at, 0, member)
        else if (!added && present) list.splice(at, 1)
      },
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
    const sidebarRosters = sidebarRosterView(this)
    // Maintenance reads: untracked, so a summary never depends on a seat's row.
    this.seatVerdicts = new SeatVerdicts({
      // untracked-read: seat-membership-maintenance
      seats: (id) => untracked(() => this.graph.members('issue', id, 'sessions')),
      // untracked-read: seat-session-maintenance
      session: (id) => untracked(() => this.row('session', id, 'peek')) as SliceSession | undefined,
      // untracked-read: seat-issue-maintenance
      issue: (id) => untracked(() => this.row('issue', id, 'peek')) as SliceIssue | undefined,
      now: () => this.clock.peekNow(),
    })
    sidebarView(this)
    this.selectedId = null
    // Every row below comes from the one reader (`row`); none of these
    // functions is replaced after construction (pending changes arrive as
    // rows, from the transaction log). A view reads rows in memory: a row that
    // is not answers undefined, its load queued.
    const inMemory = (row: Loaded<object>): object | undefined =>
      row === LOADING ? undefined : row
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
      seatList: (id) => this.seatList(id),
      selected: (id) => this.selection.has(id),
      reached: (t) => this.clock.reached(t),
      passed: (t) => this.clock.passed(t),
    }
    this.visibleInputs = {
      links,
      // Hot or cold: a cold row is read by id through the feed, never loaded.
      // untracked-read: visibility-issue-peek
      issueRow: (id) => this.row('issue', id, 'peek') as SliceIssue | undefined,
      // untracked-read: visibility-session-peek
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
      seatList: (id) => this.seatList(id),
      seatSummary: (id) => this.seatVerdicts.summary(id),
    }
    this.rollupInputs = rollupInputsOf(this.visibleInputs)
    this.worklist = new VisibleCollection({
      issue: (id) => this.issueObject(id),
      fileGroups: (id, filing) => worklistGroups(this).file(id, filing),
    })
    worklistGroups(this, locals.selectedIssueWasFolded === true)
    // Every issue in memory is a filing candidate: taken when its row enters
    // the table, released when it leaves (inside the action that moved it).
    // Its filing reaction runs only while the list is live (POD-5423).
    observe(this.tables.issue, (change) => {
      this.followTable(change.type, change.name)
      this.seatVerdicts.queueIssue(change.name)
    })
    observe(this.tables.session, (change) => {
      this.seatVerdicts.queueSession(change.name)
    })
    runInAction(() => this.select(locals.selectedIssueId))
    residency?.onDue(() => this.hydrate())
    if (lazy?.worklist !== 'demand') this.worklist.retain()
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
  row<E extends SourceEntity>(entity: E, id: string): Loaded<PoolSourceRows[E]>
  row(entity: 'setupSession', id: string): Loaded<SetupSession>
  row(entity: 'preference', id: string): Loaded<PreferenceRow>
  row(entity: HeaderEntity, id: string): object | undefined
  row(entity: EntityName, id: string, absent: 'peek'): object | undefined
  row(
    entity: EntityName,
    id: string,
    absent?: 'load' | 'mark' | 'summary' | 'summary-fields',
  ): Loaded<object>
  row(
    entity: EntityName | HeaderEntity | SourceEntity | 'setupSession' | 'preference',
    id: string,
    absent: AbsentRead = 'load',
  ): Loaded<object> {
    if (entity === 'setupSession') return readSetupSession(this, id)
    if (isHeaderEntity(entity)) return headerEntities(this).get(entity, id)
    if (!Object.hasOwn(this.tables, entity)) return this.sources.read(entity as SourceEntity, id)
    const core = entity as EntityName
    if (core === 'repo') {
      // The stable repo facade observes fields independently. Row presence
      // stays addressed; the map value atom belongs to the prefix field.
      const table = this.tables.repo
      // untracked-read: pool-auxiliary-presence
      return table.has(id) ? untracked(() => table.get(id)) : undefined
    }
    const residency = this.residency
    // The residency key already reports cold-summary changes, hydration and
    // removal. Do not also subscribe to an absent table slot for that row.
    const coldSummary =
      (absent === 'summary' || absent === 'summary-fields') &&
      residency?.isCold(core, id) === true &&
      // untracked-read: pool-cold-presence
      !untracked(() => this.tables[core].has(id))
    let server = coldSummary ? undefined : (this.tables[core].get(id) as object | undefined)
    if (server === undefined) {
      if (residency === null) return undefined
      if (absent === 'load') return residency.loading(core, id) ? LOADING : undefined
      if (!residency.known(core, id)) return undefined
      if (absent === 'mark') return LOADING
      if (absent === 'summary' || absent === 'summary-fields') {
        server = residency.summary(core, id, absent === 'summary')
        if (server === undefined) return residency.loading(core, id) ? LOADING : undefined
      } else
        server =
          core === 'session'
            ? (residency.summary(core, id) ?? residency.read(core, id))
            : residency.read(core, id)
      if (server === undefined) return undefined
    }
    if ((core === 'session' || core === 'issue') && (core === 'session' ? 'machineId' in server || 'refRepoId' in server || 'handoffTargetMachineId' in server : 'repoId' in server)) {
      let view = this.joinedRows.get(server)
      if (!view) {
        view = joinedFields(core, server as Readonly<Record<string, unknown>>, core === 'session' ? SESSION_JOIN_FIELDS : ['repoPath'], (kind, key) => {
          const companion = kind === 'machine' ? this.row('machine', key) : this.row('repo', key)
          return companion === LOADING ? undefined : companion as Readonly<Record<string, unknown>> | undefined
        })
        this.joinedRows.set(server, view)
      }
      return view
    }
    return server
  }

  get undeletedIssueCount(): number { return this.issueCount.get() }

  /** Source ordering is tracked independently from the named row payload. */
  sourcePosition(entity: 'session', id: string): number | undefined {
    this.sourcePositionVersion?.get()
    // untracked-read: pool-session-position
    return untracked(() => this.coldIndex().position(entity, id))
  }

  /**
   * POD-5407 — the cold index: every relation and the cold rule's inputs for
   * every row the feed carries (the source's, or the pool's own). Declared
   * questions only (`ColdQueries`).
   */
  coldIndex(): ColdQueries {
    if (this.disposed) {
      this.emptyIndex ??= createColdIndex(this.graph.schema)
      return this.emptyIndex
    }
    return this.sourceIndex?.() ?? (this.ownIndex as ColdIndex)
  }

  rosterCandidates(path: string): Iterable<string> {
    return sidebarRosterView(this).candidates(path)
  }

  /**
   * TRACKED: an issue's read cursor, from the read-state lane (POD-4686: per
   * key, so a mark-read re-validates only its own row). A pending mark-read is
   * already in it: the lane follows the visible row the log painted.
   *
   * The lane holds resident issues only (POD-5407: the pool keeps nothing per
   * cold row). A cold issue's cursor is the one the cold index holds for it,
   * tracked by its residency key, which every publication of the row reports.
   */
  readCursor(id: string): string | null | undefined {
    const cursor = this.readStates.get(id)
    if (cursor !== undefined) return cursor
    if (this.residency === null || !this.residency.known('issue', id)) return undefined
    const held = this.coldIndex().heldFields('issue', id, READ_CURSOR_FIELDS)
    return held === undefined ? undefined : readAtOf(held['readAt'])
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
   * `ownsSessions`: the transaction log paints
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
   * otherwise, for a read-only fixture pool.
   */
  spawnPlaceholders(): ReadonlyMap<string, string | null> | null {
    return this.spawnLog?.spawnPrompts ?? null
  }

  /** TRACKED: the row has a refused or expired change kept by the outbox.
   * This reads the transaction index only; it never loads the target's row. */
  notSaved(kind: 'issue' | 'session', id: string): boolean {
    return this.transactions?.notSaved?.(kind, id) ?? false
  }

  /** TRACKED: the feed's replicated display name for a machine with a
   * companion, undefined otherwise (POD-5661). Reads the stored companion,
   * never the merged live row, so live overwrites cannot move it; renames
   * re-run only this id's readers. */
  machineHomeName(id: string): string | undefined {
    const companion = this.companionMachineRows.get(id)
    return typeof companion?.name === 'string' ? companion.name : undefined
  }

  /** Install live machine rows under their feed companions (POD-5661,
   * POD-5704): the same merge as the companion path, so either arrival order
   * converges on live presence with live display facts. The live row wins;
   * companion-only facts (loggedOutHarnesses) survive because the live row
   * never carries them. The offline banner never reads this row — it reads
   * the stored companion via machineHomeName, so replicated renames still
   * reach the banner. Companion removals and row deletions pass through
   * untouched. */
  ingestLiveMachines(records: readonly { id: string; value: unknown }[]): void {
    const merged = records.map((record) => {
      if (record.value === undefined || typeof record.value !== 'object') return record
      const companion = this.companionMachineRows.get(record.id)
      if (!companion) return record
      return { ...record, value: { ...companion, ...(record.value as Record<string, unknown>) } }
    })
    headerEntities(this).apply(merged as never)
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
    // untracked-read: pool-formal-parent
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
    // untracked-read: pool-hidden-presence
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
   * A row it installs enters the issue table, which makes it a filing
   * candidate (`followTable`); the rows it no longer keeps cold are asked for
   * in turn, and the lanes it moved are settled (`Residency.install`).
   */
  hydrate(): number {
    const residency = this.residency
    if (residency === null) return 0
    const batch = residency.take()
    const refs = residency.takeReferences().filter((ref) => referenceViewIfPresent(this)?.hasRequest(ref))
    const identities = refs.map((ref) => [ref, this.issueIdByRef?.(ref) ?? null] as const)
    const queuedIssues = new Set(batch.filter(([entity]) => entity === 'issue').map(([, id]) => id))
    for (const [, id] of identities) {
      if (id !== null && residency.isCold('issue', id) && !queuedIssues.has(id)) {
        queuedIssues.add(id)
        batch.push(['issue', id])
      }
    }
    if (batch.length === 0 && identities.length === 0) return 0
    const out = ingestOut()
    return runInAction(() => {
      for (const [ref, id] of identities) referenceViewIfPresent(this)?.resolved(ref, id)
      const rows = residency.install(this.target, batch, out)
      sidebarRosterView(this).flush()
      this.seatVerdicts.flush()
      return rows
    })
  }

  /**
   * One feed publication, one action. The cold index holds it first (the
   * source's own applied it before calling; the pool's own applies it here),
   * then the tables follow: an update ingests its records; a `replace`
   * attaches (POD-5407: the resident candidates only). The relation reader
   * reports what the index's delta moved.
   */
  apply(event: RowSourceEvent): void {
    if (this.disposed) return
    const out = ingestOut()
    runInAction(() => {
      const machineRows = event.rows.filter(record => record.kind === 'machine')
      if (event.type === 'replace') {
        const next = new Set(machineRows.filter(record => record.value !== undefined).map(record => record.id))
        for (const id of this.companionMachineRows.keys())
          if (!next.has(id)) machineRows.push({ kind: 'machine', id, value: undefined })
        // Replace tracked companions in place so existing readers keep
        // watching the same observable across publications.
        for (const id of [...this.companionMachineRows.keys()]) if (!next.has(id)) this.companionMachineRows.delete(id)
        for (const record of machineRows) {
          if (record.value !== undefined && typeof record.value === 'object')
            this.companionMachineRows.set(record.id, record.value as Record<string, unknown>)
        }
      } else for (const record of machineRows) {
        if (record.value === undefined) this.companionMachineRows.delete(record.id)
        else if (typeof record.value === 'object') this.companionMachineRows.set(record.id, record.value as Record<string, unknown>)
      }
      // Feed companions carry replicated display facts without live presence.
      // Merge them over the live rows they accompany: a wholesale replace
      // drops online/availability and every presence reader goes blind until
      // the next hub emit (POD-5661). Companion fields win; live-only fields
      // survive. Removals still delete. The live path merges the same stored
      // companions the other way (ingestLiveMachines keeps the live rename,
      // POD-5704), so a fresh live row is never clobbered by its own ingest;
      // a later feed publication still carries the replicated facts session
      // summaries join from. The offline banner reads the stored companion
      // via machineHomeName, never this merged row, so replicated renames
      // still reach it.
      const mergedMachineRows = machineRows.map((record) => {
        if (record.value === undefined || typeof record.value !== 'object') return record
        const live = headerEntities(this).get('machine', record.id)
        if (!live || typeof live !== 'object') return record
        return {
          ...record,
          value: { ...(live as Record<string, unknown>), ...(record.value as Record<string, unknown>) },
        }
      })
      if (mergedMachineRows.length) headerEntities(this).apply(mergedMachineRows as never)
      this.queries.beginPublication(event)
      this.ownIndex?.apply(event)
      const index = this.coldIndex()
      // A source that explicitly reseeded its failed index is a new
      // slice to the pool: attach to it, whatever this publication carries.
      const fresh = this.indexSeen !== undefined && this.indexSeen !== index
      this.indexSeen = index
      if (event.type === 'replace') {
        referenceViewIfPresent(this)?.resetUnresolved()
        reseed(this.target, event.rows, out, this.ownIndex === undefined)
        this.graph.reset()
        this.reseatAll()
        this.seatVerdicts.reset()
      } else {
        if (fresh) {
          // The source rebuilt its index (it holds this publication already):
          // the cold-capable rows follow it again; lanes and repos stay.
          this.residency?.attach(this.target, null, out)
          this.graph.reset()
          this.reseatAll()
          this.seatVerdicts.reset()
        }
        // POD-4753: a row this update carries is installed from it; any
        // other row it warms is asked for (the load window).
        this.residency?.publication(event.rows)
        for (const record of event.rows) ingestRecord(this.target, record, out)
        const delta = index.changes(event)
        // POD-4745: a row the rule no longer keeps cold is warmed, once every
        // row of the update is in.
        this.residency?.settle(this.target, out, fresh ? undefined : delta)
        if (!fresh) this.graph.publish(delta)
      }
      this.issueCount.set(index.undeleted('issue'))
      if (this.sourcePositionVersion !== undefined && this.positionsSeen !== index.positionVersion) {
        this.positionsSeen = index.positionVersion
        this.sourcePositionVersion.set(this.sourcePositionVersion.get() + 1)
      }
      // An attach files its resident sessions as they enter the table
      // (`observe` above); a history row it carries is never visited.
      // A cold row's update reaches no table slot; the seat verdicts read it
      // as the members group does (hot or cold).
      for (const record of event.type === 'replace' ? [] : event.rows) {
        if (record.kind === 'session') {
          sidebarRosterView(this).queueSession(record.id)
          this.seatVerdicts.queueSession(record.id)
        }
        if (record.kind === 'issue') {
          this.seatVerdicts.queueIssue(record.id)
          if (record.value && this.residency?.isCold('issue', record.id))
            referenceViewIfPresent(this)?.arrived(record.value as SliceIssue)
        }
      }
      sidebarRosterView(this).flush()
      this.seatVerdicts.flush()
      this.queries.publish(event)
    })
    for (const [entity, id] of out.removed) this.release(entity, id)
  }

  /**
   * Archived/deleted rows stop being filing candidates and become one again
   * on return. Stage exclusions retain theirs: pending edits can change stage
   * through the one reader without an authoritative table publication.
   */
  private followTable(type: 'add' | 'update' | 'delete', id: string): void {
    const row =
      type === 'delete'
        ? undefined
        : (this.row('issue', id, 'mark') as Readonly<Record<string, unknown>> | undefined)
    if (row === undefined || row['archived'] === true || row['deletedAt'] != null) {
      this.worklist.untrack(id)
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
        worklistGroups(this).foldLatch.set(
          locals.selectedIssueId !== null &&
            worklistGroups(this).placementOf(locals.selectedIssueId)?.closed === true,
        )
      }
      if (selection) this.select(locals.selectedIssueId)
      if (latch) worklistGroups(this).foldLatch.set(locals.selectedIssueWasFolded === true)
      if (clock) {
        this.clock.advance(locals.coarseNow)
        sidebarRosterView(this).advanceClock(locals.coarseNow)
        this.seatVerdicts.advanceClock(locals.coarseNow)
      }
    })
  }

  /** Empty every table, model cache, selection and clock registration. */
  dispose(): void {
    this.queries.dispose()
    this.disposed = true
    runInAction(() => {
      this.worklist.clear()
      this.sources.dispose()
      for (const entity of ENTITIES) this.tables[entity].clear()
      this.graph.clear()
      this.clearSeats()
      this.selection.clear()
      this.readStates.clear()
      this.seatVerdicts.clear()
      this.issueCount.set(0)
    })
    for (const entity of ENTITIES) this.models[entity].clear()
    this.residency?.clear()
    this.clock.clear()
    this.selectedId = null
    // A retired pool may outlive its switch (POD-5402); it must not hold the
    // retired feed's cold index, which carries every row's relations.
    this.indexSeen = undefined
    this.ownIndex = undefined
  }

  private select(id: string | null): void {
    if (id === this.selectedId) return
    if (this.selectedId !== null) this.selection.delete(this.selectedId)
    if (id !== null) this.selection.set(id, true)
    this.selectedId = id
  }
}
