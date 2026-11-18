/**
 * POD-7094 — THE DEVICE INDEX: the pool's indexes over the rows it holds.
 *
 * History is not on the device (POD-7059): the device holds the policy's
 * collections, the instances open views hold, and the cache, all of it in
 * the pool. So every index covers exactly the rows in memory, and none is
 * sized by history. A row that is not in memory is described by its stub
 * (issues; `pool.stub`) or answers LOADING through the one loader; nothing
 * here describes it.
 *
 * WHAT IT HOLDS, per row the pool applied: the reader index's facet buckets
 * (`reader-questions.ts`), the issue questions and identities, the session
 * questions with the resume-twin collapse (`session-questions.ts`), every
 * declared relation (`relation-index.ts`, which the pool's relation reader
 * views), the sessions' arrival positions and the undeleted counts. It
 * keeps no rule rows, deadlines, keeps or summaries: the active-work rule
 * they served is gone with the cold index this replaces.
 *
 * WHAT IT CONSUMES. The pool's publications, exactly as the pool's tables
 * do: one `replace`, then `update`s, record by record (`value: undefined`
 * removes), applied first in each publication's action.
 *
 * DECLARED QUESTIONS ONLY (POD-4286's cutoff rule). Readers receive
 * {@link DeviceQueries}, never a map.
 */

import type { EntityName, ModelSchema } from './schema'
import type { RowRecord, RowSourceEvent } from './source'
import { createReaderIndex, type IssueScopeFacts, type ReaderQuestion } from './reader-questions'
import {
  createIssueQuestions,
  type IssueQuestionFacts,
  type IssueQuestions,
} from './issue-questions'
import {
  createIssueIdentities,
  type IssueIdentityFact,
  type IssueIdentities,
} from './issue-identities'
import type { SessionActivityQuestion } from './session-activity'
import {
  createSessionQuestions,
  type MachineSession,
  type TriageSession,
  type SessionQuestions,
  type SessionQuestionFacts,
} from './session-questions'
import { createRelationIndex, type RelationDelta, type RelationQueries } from './relation-index'

type Row = Readonly<Record<string, unknown>>

/** The questions the device index answers. The only surface readers get. */
export interface DeviceQueries {
  /** Publications applied so far: a reader's memo key. */
  readonly version: number
  /** Whether the pool holds the row (issues, sessions and lanes). */
  known(entity: EntityName, id: string): boolean
  /** How many rows of `entity` the pool holds (issues, sessions and lanes). */
  count(entity: EntityName): number
  /** Membership/order changes relevant to readers (not heartbeats). */
  readonly readerVersion: number
  readerRevision(question: ReaderQuestion): number
  readerRevisionKeys(question: ReaderQuestion): readonly string[]
  readerChanges(): ReadonlyMap<string, ReadonlySet<string>>
  watchReaderChanges(): () => void
  readonly issueRepoRevision: number
  issueRepoPathRevision(path: string): number
  issueScope(id: string): IssueScopeFacts | undefined
  forkIssueQuestions(): IssueQuestions
  issueQuestionFact(id: string): IssueQuestionFacts | undefined
  forkIssueIdentities(): IssueIdentities
  issueIdentityFact(id: string): IssueIdentityFact | undefined
  issueIdentityRepoPrefix(id: string): string | undefined
  issueIdentityRepoChanges(event: RowSourceEvent): ReadonlySet<string>
  readonly sessionRevision: number
  /** Session presence, issue/path membership and resume-collapse changes; not display metadata or heartbeats. */
  readonly sessionTopologyVersion: number
  readerIds(question: ReaderQuestion): string[]
  /** Membership of one changed identity, without reconstructing the answer. */
  readerContains(question: ReaderQuestion, id: string): boolean
  issueRepoIds(repoPath?: string): string[]
  /** POD-5561 cheap local title/ref scan over the held rows' short strings. */
  localTextIds(needle: string): Set<string>
  localTextRevision(): number
  sessionCollapsed(id: string): boolean
  sessionOrderKey(id: string): string
  readerActivity(question: SessionActivityQuestion): number
  readerActivityRevision(question: SessionActivityQuestion): number
  readonly readerActivityVisits: number
  triageSession(id: string, now: number): TriageSession | undefined
  forkSessionQuestions(
    collapsed: (id: string) => boolean,
    order: (id: string) => string,
  ): SessionQuestions
  sessionQuestionFact(id: string): SessionQuestionFacts | undefined
  nextTriageSession(
    after: TriageSession | undefined,
    now: number,
    excluded?: Pick<ReadonlySet<string>, 'has'>,
  ): TriageSession | undefined
  machineSession(id: string): MachineSession | undefined
  latestMachineSession(
    machineIds: readonly string[],
    excluded?: Pick<ReadonlySet<string>, 'has'>,
  ): MachineSession | undefined
  machineSessionRevision(machineIds: readonly string[]): number
  readonly sessionQuestionVisits: number
  /** Every declared relation over the rows the pool holds. */
  readonly relations: RelationQueries
  /**
   * What applying `event` moved in {@link relations}: the delta of the
   * publication applied last when it is `event`, else nothing.
   */
  changes(event: RowSourceEvent): RelationDelta
  /** How many held rows of `entity` have no `deletedAt`. */
  undeleted(entity: EntityName): number
  /**
   * A session's arrival position: its place in the last `replace`, else after
   * every row before it (the settings list's legacy order). Undefined for a
   * row the pool does not hold.
   */
  position(entity: 'session', id: string): number | undefined
  /** Bumped whenever a position is given or taken. */
  readonly positionVersion: number
}

export interface DeviceIndex extends DeviceQueries {
  apply(event: RowSourceEvent): void
}

/** The entities whose ids the index tracks for `known`, `count` and `undeleted`. */
const TRACKED: readonly EntityName[] = ['issue', 'session', 'worktree']

export function createDeviceIndex(schema: ModelSchema): DeviceIndex {
  const readers = createReaderIndex()
  const issueQuestions = createIssueQuestions()
  const relations = createRelationIndex(schema)
  const issueIdentities = createIssueIdentities((id) => relations.members('repo', id, 'worktrees'))
  let identityRepoChanges: ReadonlySet<string> = new Set()
  let identityEvent: RowSourceEvent | undefined
  const sessionQuestions = createSessionQuestions(
    (id) => relations.collapsed('session', id),
    (id) => relations.orderKey('session', id),
    undefined,
    (id) => positions.get(id) ?? 0,
  )
  let collapseVersion = 0
  let sessionTopologyVersion = 0
  let topologyMoved = false
  const navigationPath = schema.session.relations.worktree?.kind === 'prefix'
  const noDelta: RelationDelta = {
    forwards: [],
    buckets: [],
    subsets: [],
    flips: [],
    orders: [],
    roots: [],
  }
  let delta = noDelta
  /** The publication `delta` belongs to. */
  let deltaOf: RowSourceEvent | null = null
  /** Tracked entity → held ids. */
  const held = new Map<EntityName, Set<string>>(TRACKED.map((entity) => [entity, new Set()]))
  /** Tracked entity declaring `deletedAt` → the held ids that carry one. */
  const deleted = new Map<EntityName, Set<string>>(
    TRACKED.filter((entity) => Object.hasOwn(schema[entity].fields, 'deletedAt')).map((entity) => [
      entity,
      new Set(),
    ]),
  )
  let version = 0
  /** Sessions' arrival positions (`position`). */
  const positions = new Map<string, number>()
  let positionSeq = 0
  let positionVersion = 0

  function ingest(record: RowRecord): void {
    if (record.kind === 'machine') return
    const entity = record.kind as EntityName
    const row = record.value as Row | undefined
    const ids = held.get(entity)
    const existed = ids?.has(record.id) === true
    const previousIssue =
      entity === 'session' ? relations.forward('session', record.id, 'issue') : null
    const previousPath =
      entity === 'session' && navigationPath
        ? relations.prefixPath('session', record.id, 'worktree')
        : null
    if (ids !== undefined) {
      if (row === undefined) ids.delete(record.id)
      else ids.add(record.id)
    }
    const gone = deleted.get(entity)
    if (gone !== undefined) {
      if (row !== undefined && row['deletedAt'] != null) gone.add(record.id)
      else gone.delete(record.id)
    }
    relations.changed(entity, record.id, existed, row)
    if (
      entity === 'session' &&
      (existed !== (row !== undefined) ||
        previousIssue !== ((row?.['issueId'] as string | null | undefined) ?? null) ||
        (navigationPath && previousPath !== relations.prefixPath('session', record.id, 'worktree')))
    )
      topologyMoved = true
  }

  function clear(): void {
    collapseVersion++
    relations.clear()
    for (const ids of held.values()) ids.clear()
    for (const ids of deleted.values()) ids.clear()
  }

  return {
    readerActivity: (question) => sessionQuestions.activity(question),
    readerActivityRevision: (question) => sessionQuestions.activityRevision(question),
    get readerActivityVisits() {
      return sessionQuestions.activityVisits
    },
    triageSession: (id, now) => sessionQuestions.triageFact(id, now),
    forkSessionQuestions: (collapsed, order) => sessionQuestions.fork(collapsed, order),
    sessionQuestionFact: (id) => sessionQuestions.fact(id),
    nextTriageSession: (after, now, excluded) => sessionQuestions.next(after, now, excluded),
    machineSession: (id) => sessionQuestions.machineFact(id),
    latestMachineSession: (ids, excluded) => sessionQuestions.latest(ids, excluded),
    machineSessionRevision: (ids) => sessionQuestions.machineRevision(ids),
    get sessionQuestionVisits() {
      return sessionQuestions.visits
    },
    get readerVersion() {
      return readers.version + collapseVersion
    },
    readerRevision: (question) => readers.revision(question),
    readerRevisionKeys: (question) => readers.revisionKeys(question),
    readerChanges: () => readers.changes,
    watchReaderChanges: () => readers.watchChanges(),
    get issueRepoRevision() {
      return readers.repoRevision
    },
    issueRepoPathRevision: (path) => readers.repoPathRevision(path),
    issueScope: (id) => readers.issueScope(id),
    forkIssueQuestions: () => issueQuestions.fork(),
    issueQuestionFact: (id) => issueQuestions.fact(id),
    forkIssueIdentities: () => issueIdentities.fork(),
    issueIdentityFact: (id) => issueIdentities.fact(id),
    issueIdentityRepoPrefix: (id) => issueIdentities.repoPrefix(id),
    issueIdentityRepoChanges: (event) =>
      identityEvent === event ? identityRepoChanges : new Set<string>(),
    get sessionRevision() {
      return collapseVersion
    },
    get sessionTopologyVersion() {
      return sessionTopologyVersion
    },
    readerIds: (question) => readers.ids(question),
    readerContains: (question, id) => readers.contains(question, id),
    issueRepoIds: (path) => readers.repoIds(path),
    localTextIds: (needle) => readers.localTextIds(needle),
    localTextRevision: () => readers.localTextRevision(),
    sessionCollapsed: (id) => relations.collapsed('session', id),
    sessionOrderKey: (id) => relations.orderKey('session', id),
    relations,
    changes: (event) => (event === deltaOf ? delta : noDelta),
    undeleted: (entity) => (held.get(entity)?.size ?? 0) - (deleted.get(entity)?.size ?? 0),
    position: (_entity, id) => positions.get(id),
    get positionVersion() {
      return positionVersion
    },
    get version() {
      return version
    },
    known(entity, id) {
      return held.get(entity)?.has(id) ?? false
    },
    count(entity) {
      return held.get(entity)?.size ?? 0
    },
    apply(event) {
      version += 1
      topologyMoved = event.type === 'replace'
      if (event.type === 'replace') {
        clear()
        issueQuestions.clear()
        positions.clear()
        positionSeq = 0
        positionVersion += 1
      }
      for (const record of event.rows) {
        if (record.kind !== 'session') continue
        if (record.value === undefined) {
          if (positions.delete(record.id)) positionVersion += 1
        } else if (!positions.has(record.id)) {
          positions.set(record.id, ++positionSeq)
          positionVersion += 1
        }
      }
      relations.begin()
      for (const record of event.rows) ingest(record)
      delta = relations.flush()
      deltaOf = event
      if (
        topologyMoved ||
        delta.forwards.some(([key]) => key.startsWith('session.')) ||
        delta.flips.some(([entity]) => entity === 'session') ||
        delta.orders.some(([entity]) => entity === 'session')
      )
        sessionTopologyVersion++
      if (delta.flips.length > 0 || delta.orders.length > 0) collapseVersion++
      readers.apply(event)
      identityRepoChanges = issueIdentities.apply(event)
      identityEvent = event
      for (const record of event.rows)
        if (record.kind === 'issue') issueQuestions.set(record.id, record.value as Row | undefined)
      if (event.type === 'replace') {
        // Relations are final before seeding; collapse and order need no replay.
        sessionQuestions.replace(
          (function* () {
            for (const record of event.rows)
              if (record.kind === 'session')
                yield [record.id, record.value as Row | undefined] as const
          })(),
        )
      } else {
        for (const record of event.rows)
          if (record.kind === 'session')
            sessionQuestions.set(record.id, record.value as Row | undefined)
        const flipped = new Set<string>()
        for (const [entity, id] of delta.flips)
          if (entity === 'session') {
            flipped.add(id)
            sessionQuestions.visibilityChanged(id)
          }
        for (const [entity, id] of delta.orders)
          if (entity === 'session' && !flipped.has(id)) sessionQuestions.orderChanged(id)
      }
    },
  }
}
