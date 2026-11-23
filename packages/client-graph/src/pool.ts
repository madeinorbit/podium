import type { LiveStore } from '@podium/client-core/live'
import type { NotificationSession, SessionPhaseChange } from '@podium/client-core/sound'
import type { UiStore } from '@podium/client-core/ui'
import { createDemandAtoms, lazy } from '@podium/mobx-helpers'
import {
  asSessionId,
  type CheckoutWire,
  type CredentialView,
  canonicalIssueCloseReason,
  type GitRepositoryWire,
  type LayoutWire,
  type MemberView,
  type PinKind,
  repositoriesFromCheckouts,
} from '@podium/model'
import type { DeviceSignInView, PendingInteractionWire } from '@podium/protocol'
import type { MessagePoolRow } from './message-models'
import { isPinned } from './per-user-records'
import type { SetupSession } from './settings-schema'
import { readSetupSession } from './settings-views'
import {
  type IssueSessionFactReader,
  type IssueSessionFacts,
  IssueSessionFactsIndex,
} from './shared/issue-session-facts'
import { ISSUE_JOIN_FIELDS, joinedFields, SESSION_JOIN_FIELDS } from './shared/joined-fields'
import { type PoolSourceRows, PoolSources, type SourceEntity } from './source-registry'

/**
 * POD-4565 (Ma1) — the MobX pool: one per principal. Entity tables from the
 * declared schema (`tables.ts`), models built on first access (`models.ts`),
 * row views (`views.ts`), and the locals as tracked state (selection in
 * Worklist, the clock as deadlines, `clock.ts`).
 *
 * WRITE PATH. `apply(event)` is one `runInAction`: an `update` ingests each
 * record (`ingestRecord`; the same object is a no-op, `undefined` removes);
 * a `replace` reseeds every table in the same action (`reseed`,
 * `enumerate.ts`), so no observer sees a half-installed pool. Removed rows
 * drop their model. `applyLocals` is the other action: selection delegates to
 * Worklist, and a tick fires the deadlines it crosses.
 *
 * RELATIONS (POD-4566, `relations.ts`). Every table write inside that action
 * tells the relation engine, which maintains every declared relation from
 * the schema; the action ends with one `flush`, which applies each touched
 * bucket's net moves once, one element per member added or removed.
 *
 * EVERY ROW ON THE DEVICE IS IN MEMORY (POD-7094, design POD-7059 "Memory,
 * cache and leaving"). History is not on the device, so the pool places
 * every row its feed carries and every index covers exactly those rows (the
 * device index, `shared/device-index.ts`). A row the pool does not hold
 * answers through `residency.ts`: REMOVED, LOADING while the one loader
 * fetches it, or gone; an issue's reference, state and parent come from its
 * stub (`stub`). Typed references resolve in one short window (`hydrate`).
 *
 * READ PATH. Every row a model, view, visibility part, roll-up or group
 * placement reads comes from ONE reader, `row(entity, id, absent)`
 * (POD-4743): the table's row, which is already the visible row (the pool's
 * transaction log writes pending changes into it, POD-5431/POD-5432, so the
 * reader lays nothing over it), and for a row not in memory the answer the
 * caller names (`AbsentRead`: `LOADING` with its load started, or the answer
 * alone without starting one). Every table
 * read goes through the tables, every relation read through the relation
 * engine. Derivations run lazily: a row field computes when a mounted row
 * reads it and suspends when nothing does (no `keepAlive`).
 *
 * STRICT FLAGS (POD-4760) live only in tests (`harness/src/mobx-enforce.ts`
 * exports them, `harness/src/mobx-trap.ts` applies them): importing the pool
 * never configures MobX.
 */

import type { OutboxKinds } from '@podium/client-core/runtime-root'
import type {
  AgentProfileWire,
  AutomationRunWire,
  AutomationWire,
  EffectRecordWire,
  InstancePreferences,
  IssueBriefWire,
  IssueDescriptionWire,
  IssuePanelArtifactWire,
  IssuePanelDeferredWire,
  IssuePanelStateWire,
  IssuePanelTodoWire,
  MachineAccessWire,
  MachineProjection,
  NoticeWire,
  PersonalPreferences,
  PinWire,
  ReadPositionWire,
  SubscriptionWire,
  SuperagentThreadWire,
  TabOrderWire,
  WorkflowBindingWire,
  WorkflowRevisionWire,
  WorkflowRunRecord,
  WorkflowWire,
} from '@podium/model'
import { NO_INTERACTIONS, type SeatInteractions } from '@podium/model/browser'
import {
  action,
  compareShallow,
  compareStructural,
  type IObservableArray,
  type ObservableMap,
  observable,
  observableRef,
  observe,
  runInAction,
  untracked,
} from 'mobx'
import { DeadlineClock, deadlineClock } from './clock'
import { type IssueStub, PoolCollections } from './collections'
import { debugName } from './debug-name'
import { headerIds, reseed } from './enumerate'
import { headerEntities } from './header-entities'
import { type HeaderEntity, isHeaderEntity } from './header-schema'
import { referenceViewIfPresent } from './issue-reference'
import { here, isGone, type Lookup, NOT_VISIBLE, omitGone, REMOVED } from './lookup'
import {
  type EntityModel,
  type IssueModel,
  MODEL_CLASSES,
  type ModelOf,
  modelClass,
  type SessionModel,
} from './models'
import type { NoticeRows } from './notice-schema'
import type { PreferenceRow } from './preference-schema'
import { ReaderQueries } from './reader-queries'
import { PoolRelations } from './relations'
import { type LoadRow, Residency, type Schedule } from './residency'
import { type SeatRelation, sessionSeats } from './session-seats'
import { createDeviceIndex, type DeviceIndex, type DeviceQueries } from './shared/device-index'
import { FeedDiagnostics } from './shared/feed-diagnostics'
import { relationLinks } from './shared/links'
import type { RelationReader } from './shared/relation-reader'
import { type EntityName, type ModelSchema, SCHEMA } from './shared/schema'
import type {
  LocalsKey,
  SliceIssue,
  SliceLocals,
  SliceSession,
  SliceWorktree,
} from './shared/slice-types'
import type { CollectionLoaderPort, RowSourceEvent } from './shared/source'
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
import { projectIndex } from './worklist/projects'
import { LOADING, type Loaded, type RollupInputs } from './worklist/rollup'
import { SeatVerdicts } from './worklist/seat-verdicts'
import { worklistView } from './worklist/view-model'
import {
  type HeldIssue,
  isSidebarCandidate,
  readAtOf,
  rollupInputsOf,
  sidebarKeeperOf,
  VisibleCollection,
  type VisibleInputs,
} from './worklist/visible'
import {
  commandFor,
  type EditPatch,
  type TxId,
  type WritableKind,
  WriteContractError,
} from './write/commands'

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

/** A live pool's options: the per-row read, the loader, and (tests) the window and timer. */
export interface PoolLazyOptions {
  /** Explicit deterministic clock for corpus/replay fixtures. */
  readonly clock?: DeadlineClock
  readonly diagnostics?: FeedDiagnostics
  readonly issueSessionFact?: IssueSessionFactReader
  /**
   * The feed's per-row read (`RowSource.row`). Since POD-7094 the pool reads
   * no row through it (the feed publishes every row the device holds); it
   * marks a live pool, one with a feed, apart from a pool fed rows directly.
   */
  readonly load?: LoadRow
  readonly exitKind?: (entity: EntityName, id: string) => 'removed' | 'evicted' | undefined
  readonly issueIdByRef?: (ref: string) => string | undefined
  /**
   * POD-7087 — the one loader (`RowSource.loader`): a record the device does
   * not hold whole is asked for through it, from the server.
   */
  readonly loader?: () => CollectionLoaderPort | undefined
  /** Keep the sessions' arrival positions readable (the settings list's order). */
  readonly settings?: boolean
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
  /** The person the log writes for (a mark-read lands on their own row). */
  readonly userId?: string
  mutate<K extends keyof OutboxKinds & string>(kind: K, input: OutboxKinds[K]): TxId
  notSaved?(kind: 'issue' | 'session', id: string): boolean
  /** TRACKED: sessions painted as spawn placeholders, and their first turns. */
  readonly spawnPrompts: ReadonlyMap<string, string | null>
}

/**
 * What `MobxPool.row` answers for a row that is not in memory, which since
 * POD-7094 means a row the device does not hold:
 * - `load`: `LOADING`, and its load starts through the one loader (a
 *   derivation's first access), or gone;
 * - `mark` and `peek`: the answer without starting a load (maintenance
 *   inside an action, and the visibility parts): REMOVED or NOT_VISIBLE, or
 *   `LOADING` for a row the feed is about to publish.
 */
export type AbsentRead = 'load' | 'mark' | 'peek'

/** Where a row stands, for a reader that asked for it by id (tracked). */
export type Residence = 'resident' | 'loading' | 'absent'

export interface PoolRows {
  issueBrief: Readonly<IssueBriefWire> & Readonly<Record<string, unknown>>
  issueDescription: Readonly<IssueDescriptionWire> & Readonly<Record<string, unknown>>
  issuePanelTodo: Readonly<IssuePanelTodoWire> & Readonly<Record<string, unknown>>
  issuePanelArtifact: Readonly<IssuePanelArtifactWire> & Readonly<Record<string, unknown>>
  issuePanelDeferred: Readonly<IssuePanelDeferredWire> & Readonly<Record<string, unknown>>
  issuePanelState: Readonly<IssuePanelStateWire> & Readonly<Record<string, unknown>>
  /** Credential management Task 4: a credential I own or was given, from `credentials.list`. */
  credential: CredentialView & Readonly<Record<string, unknown>>
  member: MemberView & Readonly<Record<string, unknown>>
  device: DeviceSignInView & Readonly<Record<string, unknown>>
  repository: GitRepositoryWire & Readonly<Record<string, unknown>>
  messageRecord: MessagePoolRow & Readonly<Record<string, unknown>>
  pendingInteraction: PendingInteractionWire & Readonly<Record<string, unknown>>
  /** The machine record joined with my access row (POD-6644). Live facts
   *  (online, presence) are the model's, never the row's. */
  machine: Readonly<MachineProjection & Partial<Omit<MachineAccessWire, 'userId' | 'machineId'>>> &
    Readonly<Record<string, unknown>>
  automation: Readonly<AutomationWire> & Readonly<Record<string, unknown>>
  automationRun: Readonly<AutomationRunWire> & Readonly<Record<string, unknown>>
  /** Stamped at the row-source boundary: a session target's id (POD-6397). */
  effect: Readonly<EffectRecordWire> & {
    readonly sessionId?: string
    readonly forViewer?: boolean
  } & Readonly<Record<string, unknown>>
  /** POD-6673's per-user records, each with its feed id stamped as `id`. */
  pin: Readonly<PinWire> & { readonly id: string } & Readonly<Record<string, unknown>>
  userLayout: Readonly<LayoutWire> & { readonly id: string } & Readonly<Record<string, unknown>>
  tabOrder: Readonly<TabOrderWire> & { readonly id: string } & Readonly<Record<string, unknown>>
  userPreferences: Readonly<PersonalPreferences> & { readonly id: string } & Readonly<
      Record<string, unknown>
    >
  userReadPosition: Readonly<ReadPositionWire> & { readonly id: string } & Readonly<
      Record<string, unknown>
    >
  /** POD-6675: one of my superagent threads, its feed id stamped as `id`. */
  /** POD-6881: one of my open notices, its feed id stamped as `id`. */
  inboxNotice: Readonly<NoticeWire> & { readonly id: string } & Readonly<Record<string, unknown>>
  superagentThread: Readonly<SuperagentThreadWire> & { readonly id: string } & Readonly<
      Record<string, unknown>
    >
  /** POD-6676: profiles, workflows and trigger subscriptions, each keyed by its
   *  feed id (a binding's and a subscription's stamped as `id`). */
  agentProfile: Readonly<AgentProfileWire> & Readonly<Record<string, unknown>>
  workflow: Readonly<WorkflowWire> & Readonly<Record<string, unknown>>
  workflowRevision: Readonly<WorkflowRevisionWire> & Readonly<Record<string, unknown>>
  workflowBinding: Readonly<WorkflowBindingWire> & { readonly id: string } & Readonly<
      Record<string, unknown>
    >
  workflowRun: Readonly<WorkflowRunRecord> & Readonly<Record<string, unknown>>
  subscription: Readonly<SubscriptionWire> & { readonly subscriptionId: string } & Readonly<
      Record<string, unknown>
    >
  /** POD-6677: the instance settings, resolved, its feed id stamped as `id`. */
  instancePreferences: Readonly<InstancePreferences> & { readonly id: string } & Readonly<
      Record<string, unknown>
    >
  issue: SliceIssue & Readonly<Record<string, unknown>>
  session: SliceSession & Readonly<Record<string, unknown>>
  worktree: SliceWorktree & Readonly<Record<string, unknown>>
  repo: RepoRow & Readonly<Record<string, unknown>>
}

/** A lazy collection read: the members in memory, and how many are on their way. */
export interface LazyMembers {
  readonly ready: readonly string[]
  readonly pending: number
}

export class MobxPool {
  @observableRef private accessor layoutPort:
    | {
        read: (key: string) => unknown
        ready?: (key: string) => boolean
        write: (key: string, value: unknown) => void
      }
    | undefined = undefined
  @action bindLayout(port: {
    read: (key: string) => unknown
    ready?: (key: string) => boolean
    write: (key: string, value: unknown) => void
  }): void {
    this.layoutPort = port
  }
  layoutValue(key: string): unknown {
    return this.layoutPort?.read(key)
  }
  @action setLayoutValue(key: string, value: unknown): void {
    this.layoutPort?.write(key, value)
  }
  layoutReady(key: string): boolean {
    return this.layoutPort?.ready?.(key) ?? this.hasLayout
  }
  get hasLayout(): boolean {
    return this.layoutPort !== undefined
  }

  @observableRef accessor ui: UiStore | undefined = undefined
  @observableRef private accessor readCheckouts: (() => readonly CheckoutWire[]) | undefined =
    undefined
  @observable private accessor checkoutRevision = 0
  /** A read port to the one replica; checkout facts are never copied here. */
  @action bindCheckouts(read: () => readonly CheckoutWire[]): () => void {
    this.readCheckouts = read
    return () =>
      runInAction(() => {
        if (this.readCheckouts === read) this.readCheckouts = undefined
      })
  }
  @action checkoutRecordsChanged(): void {
    this.checkoutRevision++
  }
  /** The repository derivation belongs to this pool and ends with it. */
  @lazy get checkoutRepositories() {
    this.checkoutRevision
    return repositoriesFromCheckouts(this.disposed ? [] : (this.readCheckouts?.() ?? []))
  }
  @action bindUi(ui: UiStore): void {
    this.ui = ui
  }

  /**
   * This user's LiveStore (POD-5798), bound by the runtime that owns both. The
   * machine model's online, since and metrics fields read it; a pool with no
   * runtime (fixtures, harness) answers every one of them unknown.
   */
  @observableRef accessor live: LiveStore | undefined = undefined
  @action bindLive(live: LiveStore): void {
    if (this.live && this.live !== live) throw new Error('The LiveStore already has an owner')
    this.live = live
  }
  @observableRef accessor sessionDrafts: import('./models').SessionDrafts | undefined = undefined
  @action bindSessionDrafts(drafts: import('./models').SessionDrafts): void {
    if (this.sessionDrafts && this.sessionDrafts !== drafts)
      throw new Error('Session drafts already have an owner')
    this.sessionDrafts = drafts
  }

  /** Failure counters and replacement recovery status for this principal. */
  readonly diagnostics: FeedDiagnostics
  readonly issueSessionFact: IssueSessionFactReader
  private readonly sessionFactsIndex: IssueSessionFactsIndex | undefined
  /** Each summarised issue's explicit seats, judged per seat change (POD-5423). */
  private readonly seatVerdicts: SeatVerdicts
  /**
   * POD-7148: per issue, the held sessions that can keep it on the sidebar
   * (`SIDEBAR_CANDIDATES.keeper`), so a finished issue that only a session makes
   * showable stays a filing candidate. Maintenance only, never read by a
   * derivation; kept from the session table's own changes.
   */
  private readonly keepers = new Map<string, Set<string>>()
  /** The issue each session was last judged to keep (`keepers`, inverted): what it lets go of. */
  private readonly keeperOf = new Map<string, string>()
  readonly sources = new PoolSources(this)
  /** The index's `positionVersion` the settings rows last saw. */
  private positionsSeen = -1
  /** Only demanded positions are retained; the device index owns the values. */
  private readonly sourcePositions = new Map<string, number | undefined>()
  private readonly sourcePositionDemand: ReturnType<typeof createDemandAtoms<string>> | undefined
  /** The device index's undeleted issue count, published with each batch. */
  private readonly issueCount = observable.box(0)
  readonly tables: PoolTables
  /** The last addressed phase batch. Replacements are silent; no history scan. */
  @observableRef accessor issueStageChanges: readonly string[] = []
  readonly sessionPhaseChanges = observable.box<readonly SessionPhaseChange[]>([], { deep: false })
  readonly queries: ReaderQueries
  readonly relations: RelationReader
  /** The relation engine itself. */
  readonly graph: PoolRelations
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
  /** Where a row the pool does not hold stands; null for a pool fed rows directly. */
  readonly residency: Residency | null
  /** POD-7087 — the device's collections and the one loader, tracked. */
  readonly collections: PoolCollections
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
  /** The device index: the pool's indexes over the rows it holds (POD-7094). */
  private ownIndex: DeviceIndex | undefined
  /** What a disposed pool answers from: nothing. */
  private emptyIndex: DeviceIndex | undefined
  private readonly issueIdByRef: PoolLazyOptions['issueIdByRef']
  private readonly joinedRows = new WeakMap<object, object>()
  private disposed = false

  requestReference(ref: string): void {
    if (!this.disposed) this.residency?.requestReference(ref)
  }

  constructor(locals: SliceLocals, schema?: ModelSchema, lazy?: PoolLazyOptions) {
    this.diagnostics = lazy?.diagnostics ?? new FeedDiagnostics()
    this.sessionFactsIndex = lazy?.issueSessionFact ? undefined : new IssueSessionFactsIndex()
    this.issueSessionFact = lazy?.issueSessionFact ?? this.sessionFactsIndex!.read
    this.issueIdByRef = lazy?.issueIdByRef
    this.sourcePositionDemand =
      lazy?.settings === true
        ? createDemandAtoms<string>((id) => `pool.sourcePosition:${id}`, {
            onObserved: (id) =>
              this.sourcePositions.set(id, this.deviceIndex().position('session', id)),
            onUnobserved: (id) => this.sourcePositions.delete(id),
          })
        : undefined
    this.tables = createObservableTables()
    // POD-7094: the device index holds every relation and every reader
    // index over the rows the pool holds, applied first in each
    // publication's action.
    this.ownIndex = createDeviceIndex(schema ?? SCHEMA)
    this.queries = new ReaderQueries(this, schema ?? SCHEMA, () => this.deviceIndex())
    const tables = this.tables
    const residency =
      lazy === undefined
        ? null
        : new Residency({
            schema: schema ?? SCHEMA,
            hot: tables,
            absent: (entity, id) => this.collections.absent(entity, id),
            exitKind: lazy.exitKind,
            unloaded: (entity, id) => this.collections.unloaded(entity, id),
            reload: (entity, id) => this.collections.reload(entity, id),
            ...(lazy.windowMs === undefined ? {} : { windowMs: lazy.windowMs }),
            ...(lazy.schedule === undefined ? {} : { schedule: lazy.schedule }),
          })
    this.residency = residency
    this.collections = new PoolCollections(lazy?.loader ?? (() => undefined))
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
      index: () => this.deviceIndex().relations,
      // A target is present when it is in memory (tracked).
      present: (entity, id) => tables[entity].has(id),
      ...(schema === undefined ? {} : { schema }),
      // File the explicit seat delta (one element) into a list something has
      // read, in the same action that moved the bucket: binary search by id
      // (default `.sort()` order, UTF-16 code units) + splice at its position.
      onBucket: (collection, target, member, added) => {
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
    this.readStates = observable.map<string, string | null>(undefined, {
      deep: false,
      name: debugName(() => 'pool.reads'),
    })
    this.clock =
      lazy?.clock ??
      (locals.coarseNow === undefined ? deadlineClock : new DeadlineClock(locals.coarseNow))
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
    }
    projectIndex(this)
    // Maintenance reads: untracked, so a summary never depends on a seat's row.
    this.seatVerdicts = new SeatVerdicts({
      // untracked-read: seat-membership-maintenance
      seats: (id) => untracked(() => this.graph.members('issue', id, 'sessions')),
      session: (id) =>
        // untracked-read: seat-session-maintenance
        untracked(() => omitGone(this.row('session', id, 'peek'))) as SliceSession | undefined,
      issue: (id) =>
        // untracked-read: seat-issue-maintenance
        untracked(() => omitGone(this.row('issue', id, 'peek'))) as SliceIssue | undefined,
      now: () => this.clock.peekNow(),
      at: (t, due) => this.clock.at(t, due),
    })
    worklistView(this)
    // Every row below comes from the one reader (`row`); none of these
    // functions is replaced after construction (pending changes arrive as
    // rows, from the transaction log). A view reads rows in memory: a row that
    // is not answers undefined, its load queued.
    const inMemory = (row: Loaded<object>) => (row === LOADING ? undefined : row)
    const links = relationLinks(this.relations, this.graph.schema)
    this.inputs = {
      links,
      issue: (id) => inMemory(omitGone(this.row('issue', id))) as SliceIssue | undefined,
      session: (id) => inMemory(omitGone(this.row('session', id))) as SliceSession | undefined,
      // The member's cached stamp (its object's): no row read.
      sessionActivity: (id) => (this.object('session', id) as SessionModel).activityMs,
      repo: (id) => inMemory(omitGone(this.row('repo', id))) as RepoRow | undefined,
      // An issue answers from its object's cached in-memory read (no table
      // probe per run); other entities from the table.
      present: (entity, id) =>
        entity === 'issue' ? this.issueObject(id).inMemory : tables[entity].has(id),
      loading: (entity, id) => residency?.loading(entity, id) ?? false,
      // Only asked for an issue in memory (`originTickPartOf`): its object.
      parts: (id) => worklistView(this).row(this.issueObject(id)),
      rollup: (id) => this.knownIssue(id)?.rollup,
      retainedSeats: (id) => this.knownIssue(id)?.retainedSeatIds ?? [],
      // The maintained SORTED list itself, returned without iterating it. A
      // membership change yields the new member only; the family is never
      // yielded here. Closure-held, ids only.
      seatList: (id) => this.seatList(id),
      selected: (id) => worklistView(this).row(this.issueObject(id)).selected,
      issuePinned: (id) => this.issueObject(id).pinned,
      reached: (t) => this.clock.reached(t),
      passed: (t) => this.clock.passed(t),
    }
    this.visibleInputs = {
      missionBucket: (id) => this.issueObject(id).missionBucket,
      links,
      issueSessionFact: (id, field) => {
        const issue = this.issueObject(id)
        return (
          field === 'replicaActivityAt'
            ? issue.lastActivityAt
            : field === 'tipActivityAt'
              ? issue.tipActivityAt
              : field === 'headlessStaffed'
                ? issue.headlessStaffed
                : issue.headlessOccupied
        ) as IssueSessionFacts[typeof field]
      },
      // A row the pool does not hold is not loaded for visibility.
      // untracked-read: visibility-issue-peek
      issueRow: (id) => omitGone(this.row('issue', id, 'peek')) as SliceIssue | undefined,
      // untracked-read: visibility-session-peek
      sessionRow: (id) => omitGone(this.row('session', id, 'peek')) as SliceSession | undefined,
      issue: (id) => this.knownIssue(id),
      session: (id) => worklistView(this).session(this.sessionObject(id)),
      passed: (t) => this.clock.passed(t),
      reached: (t) => this.clock.reached(t),
      loadedIssue: (id) => omitGone(this.row('issue', id)) as Loaded<SliceIssue>,
      loadedSession: (id) => omitGone(this.row('session', id)) as Loaded<SliceSession>,
      // The model's @lazy fact (ADR 12 D1): rows stay as stored (frontend-data rules 1, 3).
      sessionReconnecting: (id) => this.sessionObject(id).reconnecting,
      // The model's live reading (POD-6764): the LiveStore, never the row.
      sessionBusy: (id) => this.sessionObject(id).busy === true,
      openInteractions: (id) => this.sessionOpenInteractions(id),
      interactionSessions: () => this.sessionsWithOpenInteractions(),
      issueRead: (id) => this.readCursor(id),
      issuePinned: (id) => this.issueObject(id).pinned,
      nested: (id) => worklistView(this).row(this.issueObject(id)).nested,
      formalChildren: (id) => links.issue.children.ids(id),
      // The maintained SORTED list itself, returned without iterating it — a
      // membership change yields the new member only. `seatIdsPartOf` reads
      // it, never the relation.
      seatList: (id) => this.seatList(id),
      seatSummary: (id) => this.seatVerdicts.summary(id),
    }
    this.rollupInputs = rollupInputsOf(this.visibleInputs)
    this.worklist = new VisibleCollection({
      issue: (id) => worklistView(this).row(this.issueObject(id)),
      fileGroups: (id, filing) => worklistGroups(this).file(id, filing),
    })
    worklistGroups(this, locals.selectedIssueWasFolded === true)
    // An issue in memory the sidebar can show is a filing candidate
    // (POD-7148): judged when its row enters, changes or leaves the table, and
    // when a session that can keep it does (inside the action that moved
    // it). Its filing reaction runs only while the list is live (POD-5423).
    observe(this.tables.issue, (change) => {
      this.followTable(change.type, change.name)
      this.seatVerdicts.queueIssue(change.name)
    })
    observe(this.tables.session, (change) => {
      this.followKeeper(
        change.name,
        change.type === 'add' ? undefined : (change.oldValue as SliceSession),
        change.type === 'delete' ? undefined : (change.newValue as SliceSession),
      )
      this.seatVerdicts.queueSession(change.name)
    })
    // Restoring saved selection must not derive placement before rows attach.
    runInAction(() => {
      worklistView(this).selectedId = locals.selectedIssueId
      worklistView(this).setFolded(locals.selectedIssueWasFolded === true)
    })
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
   * Not in memory: what `absent` names (`AbsentRead`). Unknown addressed
   * rows load once through the one loader, then answer Gone if not visible.
   * Never blocks.
   */
  row<E extends SourceEntity>(entity: E, id: string): Lookup<PoolSourceRows[E]>
  row(entity: 'setupSession', id: string): Lookup<SetupSession>
  row(entity: 'preference', id: string): Lookup<PreferenceRow>
  row(entity: HeaderEntity, id: string): Lookup<object>
  row(entity: EntityName, id: string, absent: 'peek'): Lookup<object>
  row<E extends EntityName>(entity: E, id: string, absent?: 'load' | 'mark'): Lookup<PoolRows[E]>
  row(
    entity: EntityName | HeaderEntity | SourceEntity | 'setupSession' | 'preference',
    id: string,
    absent: AbsentRead = 'load',
  ): Lookup<object> {
    if (entity === 'setupSession') return readSetupSession(this, id) ?? NOT_VISIBLE
    if (isHeaderEntity(entity) && entity !== 'machine')
      return headerEntities(this).get(entity, id) ?? NOT_VISIBLE
    if (!Object.hasOwn(this.tables, entity))
      return this.sources.read(entity as SourceEntity, id) ?? NOT_VISIBLE
    const core = entity as EntityName
    // Exit evidence arrives before a deferred row publication. A resident
    // payload must not keep a formally removed record readable in that gap.
    if (this.residency?.removed(core, id)) return REMOVED
    if (core === 'repo') {
      // The stable repo facade observes fields independently. Row presence
      // stays addressed; the map value atom belongs to the prefix field.
      const table = this.tables.repo
      // untracked-read: pool-auxiliary-presence
      return table.has(id) ? untracked(() => table.get(id))! : NOT_VISIBLE
    }
    const server = this.tables[core].get(id) as object | undefined
    if (server === undefined) {
      // Resident readers finish teardown, but missing rows must not restart a retired loader.
      if (this.disposed) return NOT_VISIBLE
      const residency = this.residency
      if (residency === null) {
        // A pool fed rows directly that reads a device store (POD-7088): a
        // record the device does not hold is on its way like any lookup,
        // never "gone" because history is not here. Maintenance modes start
        // no load.
        return (
          (absent === 'load' && (core === 'issue' || core === 'session')
            ? this.collections.absent(core, id)
            : undefined) ?? NOT_VISIBLE
        )
      }
      return residency.lookup(core, id, absent === 'load')
    }
    // A record a view looked up keeps its hold while it is read (POD-7158).
    if (absent === 'load' && (core === 'issue' || core === 'session'))
      this.collections.keepRecord(core, id)
    if (
      (core === 'session' || core === 'issue') &&
      (core === 'session'
        ? 'machineId' in server || 'refRepoId' in server || 'handoffTargetMachineId' in server
        : 'repoId' in server)
    ) {
      let view = this.joinedRows.get(server)
      if (!view) {
        view = joinedFields(
          core,
          server as Readonly<Record<string, unknown>>,
          core === 'session' ? SESSION_JOIN_FIELDS : ISSUE_JOIN_FIELDS,
          (kind, key) => {
            const companion =
              kind === 'machine'
                ? here(this.row('machine', key))
                : here(this.model('repo', key))?.row
            return companion === undefined
              ? undefined
              : (here(companion) as Readonly<Record<string, unknown>> | undefined)
          },
        )
        this.joinedRows.set(server, view)
      }
      return view
    }
    return server
  }

  /**
   * TRACKED (POD-7087, design "Lookup"): an issue's STUB, its reference,
   * state and parent. A stub is "here" for a reader of stub fields: the
   * device holds every issue at least as a stub, so this never fetches when
   * the stub is on the device. An issue the device does not hold at all
   * answers like any lookup (LOADING and one batched load, or gone).
   */
  stub(id: string): Lookup<IssueStub> {
    if (this.residency?.removed('issue', id)) return REMOVED
    const resident = this.tables.issue.get(id) as Readonly<Record<string, unknown>> | undefined
    if (resident !== undefined) return pickStub(id, resident)
    const stub = this.collections.stubOf(id)
    if (stub !== undefined) return stub
    if (this.disposed) return NOT_VISIBLE
    if (this.residency === null) return this.collections.absent('issue', id) ?? NOT_VISIBLE
    return this.residency.lookup('issue', id)
  }

  /**
   * TRACKED: undeleted issues over all history. A pool that reads a device
   * store counts them from the stubs, LOADING until those are complete
   * (POD-7088, design "Counts"); the rows in memory are not all history.
   */
  get undeletedIssueCount(): number | typeof LOADING {
    if (!this.collections.available) return this.issueCount.get()
    const byDeleted = this.collections.countBy('deletedAt')
    return byDeleted === LOADING ? LOADING : (byDeleted.get(null) ?? 0)
  }

  /** Successful top-level tasks over all history, without loading their bodies. */
  @lazy get finishedTaskCount(): number | typeof LOADING {
    // A pre-upgrade stub cannot distinguish tasks from phases until its shape reloads.
    if (this.collections.someIssue((stub) => stub.type === undefined) !== false) return LOADING
    return this.collections.countStubs('finished-tasks', (stub) => {
      if (stub.stage !== 'done' || stub.deletedAt != null || stub.parentId != null) return false
      if (stub.isDraftVessel || stub.type === 'phase' || stub.type === 'milestone') return false
      const reason = canonicalIssueCloseReason(stub.closedReason)
      return reason === null || reason === 'done'
    })
  }

  /** TRACKED: undeleted issues the device holds whole; a lower bound of the count above. */
  get heldUndeletedIssueCount(): number {
    return this.issueCount.get()
  }

  /** Source ordering is tracked independently from the named row payload. */
  sourcePosition(entity: 'session', id: string): number | undefined {
    if (!this.disposed) this.sourcePositionDemand?.observe(id)
    // untracked-read: pool-session-position
    return untracked(() => this.deviceIndex().position(entity, id))
  }

  /**
   * POD-7094 — the device index: every relation and reader index over the
   * rows the pool holds. Declared questions only (`DeviceQueries`).
   */
  deviceIndex(): DeviceQueries {
    if (this.disposed || this.ownIndex === undefined) {
      this.emptyIndex ??= createDeviceIndex(this.graph.schema)
      return this.emptyIndex
    }
    return this.ownIndex
  }

  /**
   * TRACKED: an issue's read cursor, from the read-state lane (POD-4686: per
   * key, so a mark-read re-validates only its own row). A pending mark-read is
   * already in it: the lane follows the visible row the log painted.
   * Undefined for an issue the pool does not hold.
   */
  readCursor(id: string): string | null | undefined {
    return this.readStates.get(id)
  }

  /** The addressed model, a batched load, or a terminal absence (tracked). */
  model<E extends EntityName>(entity: E, id: string): Lookup<ModelOf[E]> {
    // A resident identity observes presence; fields observe their own values.
    // Reading its payload here would wake every model join on any row update.
    if (!this.tables[entity].has(id)) {
      const row = this.row(entity, id)
      if (row === LOADING || isGone(row)) return row
    }
    const Model = modelClass(entity)
    return Model === LOADING ? LOADING : (this.object(entity, id, Model) as ModelOf[E])
  }

  /**
   * The one object of `entity:id`, built on first request, whether or not its
   * row is in memory. Untracked: an identity memo.
   */
  private object(entity: EntityName, id: string, Model = MODEL_CLASSES[entity]!): EntityModel {
    const models = this.models[entity]
    let model = models.get(id)
    if (model === undefined) {
      model = new Model(id, this)
      models.set(id, model)
    }
    return model
  }

  /**
   * Forget the object of `entity:id` once nothing can ask for it again as
   * the same row: an issue neither in memory nor tracked by the worklist,
   * any other row no longer in memory.
   */
  private release(entity: EntityName, id: string): void {
    if (this.tables[entity].has(id)) return
    if (entity === 'issue' && this.worklist.tracks(id)) return
    this.models[entity].delete(id)
  }

  /** Did I pin this thing? My `pin` record of that kind (POD-6692). */
  isPinned(kind: PinKind, entityId: string): boolean {
    return isPinned(this, kind, entityId)
  }

  /** The one object of issue `id`, built on first request (untracked: an identity memo). */
  issueObject(id: string): IssueModel {
    return this.object('issue', id) as IssueModel
  }

  /** The same session object whether its row is resident or loading. */
  sessionObject(id: string): SessionModel {
    return this.object('session', id) as SessionModel
  }

  sessionArchiveField(id: string): boolean | undefined {
    return this.queries.sessionStoredField(id, 'archived')
  }

  /** The sessions holding an open (asked) pending interaction, in id order: where an exited seat may still ask (POD-2171). */
  sessionsWithOpenInteractions(): readonly string[] {
    this.openInteractionSessions ??= new OpenInteractionSessions(this)
    return this.openInteractionSessions.ids
  }
  private openInteractionSessions: OpenInteractionSessions | undefined

  /** Open (asked) pending interactions addressed to session `id`, and when the earliest was asked: a seat fact (`coordinatedSeat`). */
  sessionOpenInteractions(id: string): SeatInteractions {
    const membership = omitGone(
      this.row('noticeSession', id) as Lookup<NoticeRows['noticeSession']>,
    )
    if (membership === undefined || membership === LOADING) return NO_INTERACTIONS
    let count = 0
    let since: number | null = null
    for (const interaction of membership.interactions) {
      const row = omitGone(this.row('pendingInteraction', interaction))
      if (row === undefined || row === LOADING || row.sessionId !== id || row.status !== 'asked')
        continue
      count++
      const at = Date.parse(row.askedAt)
      if (Number.isFinite(at) && (since === null || at < since)) since = at
    }
    return count === 0 ? NO_INTERACTIONS : { count, since }
  }

  issueExitKind(id: string) {
    const exit = omitGone(this.row('issueExit', id))
    if (exit === LOADING) throw LOADING
    return exit?.kind
  }

  sessionSeatIds(
    relation: SeatRelation,
    issueId: string,
    archived: boolean,
  ): readonly string[] | typeof LOADING {
    const partition = sessionSeats(this).partition(relation, issueId)
    return partition === LOADING ? LOADING : archived ? partition.archived : partition.present
  }

  /**
   * TRACKED: the object of issue `id` while the pool holds the issue, else
   * undefined: a cross-issue read (a parent, a child, a starter's owner)
   * that reaches an unknown id re-runs when it arrives. A presence probe,
   * not a row read.
   */
  knownIssue(id: string): HeldIssue | undefined {
    return this.tables.issue.has(id) ? worklistView(this).row(this.issueObject(id)) : undefined
  }

  /** A model's edit (`issue.title = x`): one transaction of the pool's log. */
  edit<K extends WritableKind>(entity: K, id: string, patch: EditPatch<K>): TxId {
    if (this.transactions === null) {
      throw new WriteContractError(`the pool has no transaction log: cannot edit ${entity} ${id}`)
    }
    const command = commandFor(entity, id, patch, this.transactions.userId)
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

  /** TRACKED: the machine's name, from its synced record; undefined when the
   * record is not here. Renames re-run only this id's readers. */
  machineHomeName(id: string): string | undefined {
    const row = this.tables.machine.get(id) as { name?: unknown } | undefined
    return typeof row?.name === 'string' ? row.name : undefined
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

  issue(id: string): Lookup<ModelOf['issue']> {
    return this.model('issue', id)
  }

  /** The worklist companion of a resident issue, shared by both screens. */
  worklistRow(id: string) {
    const issue = this.issue(id)
    return issue === LOADING || isGone(issue) ? undefined : worklistView(this).row(issue)
  }

  /** TRACKED: the declared parent key, without reading either row's fields.
   * Only the source changes this relation: its table slot already reports
   * those writes, including removal and arrival. */
  formalParent(id: string): string | null {
    this.tables.issue.has(id)
    // untracked-read: pool-formal-parent
    return untracked(() => this.graph.forwardTarget('issue', id, 'parent'))
  }

  /**
   * TRACKED: where the row `entity:id` stands. A row the pool does not hold
   * answers `loading` and its load starts (first access); a reader renders
   * that as loading, never as an empty row.
   */
  resident(entity: EntityName, id: string): Residence {
    // Availability observes presence; payload changes belong to field readers.
    if (this.tables[entity].has(id)) return 'resident'
    const answer = this.row(entity, id)
    return answer === LOADING ? 'loading' : isGone(answer) ? 'absent' : 'resident'
  }

  /**
   * TRACKED: a lazy collection (Rule L) as its resident members plus the
   * count still loading, each absent one asked for. The shape a roll-up reads
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
   * Close the reference window now: resolve every queued typed reference
   * against the device's identities in ONE action. The window's timer calls
   * this; the harness drains it before it reads. Returns how many
   * references it resolved.
   */
  hydrate(): number {
    const residency = this.residency
    if (residency === null) return 0
    const refs = residency
      .takeReferences()
      .filter((ref) => referenceViewIfPresent(this)?.hasRequest(ref))
    if (refs.length === 0) return 0
    const identities = refs.map((ref) => [ref, this.issueIdByRef?.(ref) ?? null] as const)
    return runInAction(() => {
      for (const [ref, id] of identities) referenceViewIfPresent(this)?.resolved(ref, id)
      return identities.length
    })
  }

  /**
   * One feed publication, one action. The device index applies it first,
   * then the tables follow: an update ingests its records; a `replace`
   * reseeds every table. The relation reader reports what the index's delta
   * moved.
   */
  apply(event: RowSourceEvent): void {
    if (this.disposed) return
    const out = ingestOut()
    runInAction(() => {
      const stages: string[] = []
      if (event.type === 'update')
        for (const record of event.rows) {
          if (record.kind !== 'issue') continue
          const previous = this.tables.issue.get(record.id) as SliceIssue | undefined
          const current = record.value as SliceIssue | undefined
          if (previous && current && previous.stage !== current.stage) stages.push(record.id)
        }
      const phases: SessionPhaseChange[] = []
      if (event.type === 'update')
        for (const record of event.rows) {
          if (record.kind !== 'session') continue
          const previous = this.tables.session.get(record.id) as NotificationSession | undefined
          const current = record.value as NotificationSession | undefined
          if (!previous || !current) continue
          if (
            previous.agentState?.phase === current.agentState?.phase &&
            previous.agentState?.idle?.kind === current.agentState?.idle?.kind &&
            previous.agentState?.need?.kind === current.agentState?.need?.kind &&
            previous.agentKind === current.agentKind &&
            previous.headless === current.headless &&
            previous.archived === current.archived
          )
            continue
          phases.push({ sessionId: asSessionId(record.id), previous, current })
        }
      if (this.sessionFactsIndex) {
        if (event.type === 'replace') this.sessionFactsIndex.clear()
        for (const record of event.rows)
          if (record.kind === 'session')
            this.sessionFactsIndex.install(
              record.id,
              record.value as Record<string, unknown> | undefined,
            )
      }
      // Machines are records like any other (POD-6644): the feed's row is the
      // machine record joined with my access row. The header's indexes over the
      // same table follow the rows the feed carries.
      const machineRows = event.rows.filter((record) => record.kind === 'machine')
      if (machineRows.length) headerEntities(this).apply(machineRows as never)
      const tableRows = event.rows
      const reseedRows = event.rows
      this.queries.beginPublication(event)
      this.ownIndex?.apply(event)
      const index = this.deviceIndex()
      if (event.type === 'replace') {
        referenceViewIfPresent(this)?.resetUnresolved()
        reseed(this.target, reseedRows, out, (entity) => this.sources.ownsRecords(entity))
        this.graph.reset()
        this.reseatAll()
        this.seatVerdicts.reset()
      } else {
        for (const record of tableRows) ingestRecord(this.target, record, out)
        this.graph.publish(index.changes(event))
      }
      this.issueCount.set(index.undeleted('issue'))
      if (
        this.sourcePositionDemand !== undefined &&
        (event.type === 'replace' || this.positionsSeen !== index.positionVersion)
      ) {
        this.positionsSeen = index.positionVersion
        // Ordinary publications address only their session ids. A replacement
        // can move any demanded position, even at the same version; compare
        // those keys without opening the session catalog.
        if (event.type === 'replace') {
          for (const id of this.sourcePositionDemand.keys()) this.refreshSourcePosition(index, id)
        } else
          for (const record of event.rows) {
            if (record.kind === 'session') this.refreshSourcePosition(index, record.id)
          }
      }
      // An attach files its sessions as they enter the table (`observe`
      // above).
      for (const record of event.type === 'replace' ? [] : event.rows) {
        if (record.kind === 'session') this.seatVerdicts.queueSession(record.id)
        if (record.kind === 'issue') this.seatVerdicts.queueIssue(record.id)
      }
      this.seatVerdicts.flush()
      this.queries.publish(event)
      for (const record of machineRows)
        if (record.value === undefined) this.release('machine', record.id)
      if (stages.length || event.type === 'replace') this.issueStageChanges = stages
      if (phases.length || event.type === 'replace') this.sessionPhaseChanges.set(phases)
    })
    for (const [entity, id] of out.removed) this.release(entity, id)
  }

  /**
   * Issue `id` is a filing candidate while its row is one of the sidebar's
   * declared candidates or a held session can keep it (`SIDEBAR_CANDIDATES`);
   * otherwise it files nothing, whatever collection brought it to the device.
   * Pending edits are in the row (the log writes the rebased row into the
   * table), so they arrive here like any other change.
   */
  private followTable(type: 'add' | 'update' | 'delete', id: string): void {
    const row =
      type === 'delete'
        ? undefined
        : (omitGone(this.row('issue', id, 'mark')) as Loaded<SliceIssue>)
    if (row !== undefined && row !== LOADING && (isSidebarCandidate(row) || this.keepers.has(id))) {
      this.worklist.track(id)
    } else {
      this.worklist.untrack(id)
    }
  }

  /** A session moved: the issues it could and can keep are judged again (inside its action). */
  private followKeeper(
    sessionId: string,
    _before: SliceSession | undefined,
    after: SliceSession | undefined,
  ): void {
    // What it kept when last judged, not its old row judged now: a window
    // that lapsed since must still let go of the issue.
    const was = this.keeperOf.get(sessionId)
    const now = sidebarKeeperOf(after, this.clock.peekNow())
    if (was === now) return
    if (now === undefined) this.keeperOf.delete(sessionId)
    else this.keeperOf.set(sessionId, now)
    if (was !== undefined) {
      const seats = this.keepers.get(was)
      seats?.delete(sessionId)
      if (seats?.size === 0) this.keepers.delete(was)
      if (this.tables.issue.has(was)) this.followTable('update', was)
    }
    if (now !== undefined) {
      const seats = this.keepers.get(now)
      if (seats === undefined) this.keepers.set(now, new Set([sessionId]))
      else seats.add(sessionId)
      if (this.tables.issue.has(now)) this.followTable('update', now)
    }
  }

  /** One locals notification, one action: only the keys it names. */
  applyLocals(locals: SliceLocals, changed: ReadonlySet<LocalsKey>): void {
    worklistView(this).applyLocals(locals, changed)
  }

  private refreshSourcePosition(index: DeviceQueries, id: string): void {
    const atom = this.sourcePositionDemand?.get(id)
    if (!atom) return
    const position = index.position('session', id)
    if (Object.is(this.sourcePositions.get(id), position)) return
    this.sourcePositions.set(id, position)
    atom.reportChanged()
  }

  /** The per-pool clock cleared at retirement; the process clock belongs to the app. */
  get ownedClock(): DeadlineClock | null {
    return this.clock === deadlineClock ? null : this.clock
  }

  /** Empty every table, model cache, selection and clock registration. */
  dispose(): void {
    this.queries.dispose()
    this.collections.dispose()
    this.disposed = true
    this.sessionFactsIndex?.clear()
    runInAction(() => {
      this.worklist.clear()
      this.keepers.clear()
      this.keeperOf.clear()
      this.sources.dispose()
      for (const entity of ENTITIES) this.tables[entity].clear()
      this.graph.clear()
      this.clearSeats()
      worklistView(this).select(null)
      this.readStates.clear()
      this.seatVerdicts.clear()
      this.issueCount.set(0)
      for (const [id, position] of this.sourcePositions) {
        if (position !== undefined) this.sourcePositionDemand?.get(id)?.reportChanged()
      }
      this.sourcePositionDemand?.clear()
      this.sourcePositions.clear()
    })
    for (const entity of ENTITIES) this.models[entity].clear()
    this.residency?.clear()
    this.ownedClock?.clear()
    // A retired pool may outlive its switch (POD-5402); it must not hold the
    // retired feed's device index, which carries every row's relations.
    this.ownIndex = undefined
  }

  private select(id: string | null): void {
    worklistView(this).select(id)
  }
}

/**
 * The sessions holding an open pending interaction (POD-2171): one shared
 * value for every row, scanned once per catalog or interaction change and
 * compared shallowly, so an unrelated notice leaves the rows that read it
 * alone.
 */
class OpenInteractionSessions {
  constructor(private readonly pool: MobxPool) {}

  @lazy({ equals: compareShallow })
  get ids(): readonly string[] {
    const catalog = omitGone(
      this.pool.row('noticeCatalog', 'catalog') as Lookup<NoticeRows['noticeCatalog']>,
    )
    if (catalog === undefined || catalog === LOADING) return NO_SESSIONS
    const sessions = new Set<string>()
    for (const interaction of catalog.interactions) {
      const row = omitGone(this.pool.row('pendingInteraction', interaction))
      if (row !== undefined && row !== LOADING && row.status === 'asked')
        sessions.add(row.sessionId)
    }
    return sessions.size === 0 ? NO_SESSIONS : [...sessions].sort()
  }
}
const NO_SESSIONS: readonly string[] = Object.freeze([])

/** The stub fields of a resident issue row (the declaration's: reference, state, parent). */
function pickStub(id: string, row: Readonly<Record<string, unknown>>): IssueStub {
  const known = stubsOfRows.get(row)
  if (known !== undefined) return known
  const stub: IssueStub = {
    id,
    repoId: row['repoId'] as string | null | undefined,
    seq: row['seq'] as number | undefined,
    type: row['type'] as string | undefined,
    stage: row['stage'] as string | undefined,
    closedReason: row['closedReason'] as string | null | undefined,
    archived: row['archived'] as boolean | undefined,
    deletedAt: row['deletedAt'] as string | null | undefined,
    isDraftVessel: row['isDraftVessel'] as boolean | undefined,
    audience: row['audience'] as string | null | undefined,
    parentId: row['parentId'] as string | null | undefined,
  }
  stubsOfRows.set(row, stub)
  return stub
}

/** One stub object per row object, so a reader sees the same answer until the row changes. */
const stubsOfRows = new WeakMap<object, IssueStub>()
