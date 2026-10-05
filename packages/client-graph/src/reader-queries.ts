import type { NavigationTopologyDelta } from '@podium/client-core/engine'
import type { IssueCloseMemberCounts } from '@podium/client-core/values'
import { parseSessionRef } from '@podium/protocol'
import { createAtom, type IAtom, observe, untracked } from 'mobx'
import { residentIds } from './enumerate'
import type { MobxPool } from './pool'
import { createKeyedAnswer, createQueryResult } from './query-result'
import type { ColdQueries } from './shared/cold-index'
import type { IssueIdentities } from './shared/issue-identities'
import type { IssueChildCounts, IssueQuestions } from './shared/issue-questions'
import {
  createReaderIndex,
  type IssueScopeFacts,
  questionEntity,
  type ReaderQuestion,
} from './shared/reader-questions'
import type { ModelSchema } from './shared/schema'
import type { SessionActivityQuestion } from './shared/session-activity'
import type { SessionQuestions } from './shared/session-questions'
import { referenceKey } from './shared/session-reference'
import type { RowSourceEvent } from './shared/source'
import { createWorktreeQuestions } from './shared/worktree-questions'
import { LOADING, type Loaded } from './worklist/rollup'

interface IdentityResult {
  question: ReaderQuestion
  source: ColdQueries
  answer: ReturnType<typeof createKeyedAnswer<string>>
  nextOrder: number
}

/** Query bridge, not a history index in the pool. Production questions go to
 * the row source's cold index; a directly-fed pool (fixtures, standalone
 * consumers) answers from its own (`MobxPool.coldIndex`). */
export class ReaderQueries {
  private readonly sessionAtoms = new Map<string, IAtom>()
  private readonly issueScopeAtoms = new Map<string, { atom: IAtom; bits: number }>()
  private readonly issueCloseAtoms = new Map<
    string,
    { atom: IAtom; value: IssueCloseMemberCounts }
  >()
  private readonly issueChildAtoms = new Map<string, { atom: IAtom; value: IssueChildCounts }>()
  private readonly containingIssueAtoms = new Map<
    string,
    { atom: IAtom; value: string | undefined }
  >()
  private readonly containingIssuePaths = new Map<string, Set<string>>()
  private effectiveIssues: IssueQuestions | undefined
  private effectiveIssueSource: ColdQueries | undefined
  private effectiveIssueIdentities: IssueIdentities | undefined
  private effectiveIdentitySource: ColdQueries | undefined
  private readonly linkedIssueAtoms = new Map<
    string,
    { atom: IAtom; value: string | undefined; identifier: string; referenceOnly: boolean }
  >()
  private readonly issuePrefixAtoms = new Map<
    string,
    { atom: IAtom; value: boolean; prefix: string; includeDeleted: boolean }
  >()
  private readonly linkedAliases = new Map<string, Set<string>>()
  private readonly linkedPrefixes = new Map<string, Set<string>>()
  private readonly repoOverrides = new Map<string, string | undefined>()
  private readonly repoPrefixCounts = new Map<string, number>()
  private readonly repoPrefixes: string[] = []
  private readonly repoPrefixAtom = createAtom('history.repositoryPrefixKey')
  private repoPrefixValue = ''
  private readonly referenceTokens = new Map<string, Set<string>>()
  private readonly sessionReferenceAtoms = new Map<
    string,
    { atom: IAtom; value: string | undefined; keys: readonly string[] }
  >()
  private readonly sessionPathAtoms = new Map<string, { atom: IAtom; value: boolean }>()
  private readonly topologyListeners = new Set<(delta: NavigationTopologyDelta) => void>()
  private readonly worktrees = createWorktreeQuestions()
  private readonly firstWorktreeAtom = createAtom('history.firstWorktree')
  private effectiveSessions: SessionQuestions | undefined
  private effectiveSource: ColdQueries | undefined
  private readonly observed = new Map<
    string,
    { atom: IAtom; version: number; revision(index: ColdQueries): number }
  >()
  private readonly listeners = new Set<(event: RowSourceEvent) => void>()
  private readonly memberListeners = new Map<string, Set<(id: string | undefined) => void>>()
  private sourceSeen: ColdQueries | undefined
  private readonly identities = new Map<string, IdentityResult>()
  /** Resident edits shadow the source by address. Predicate membership is
   * maintained at ingestion, never discovered by walking resident history. */
  private readonly residents = createReaderIndex({ targetSearch: false, recent: false })
  private readonly residentIssueIds = new Set<string>()
  private readonly residentOrder = {
    issue: new Map<string, number>(),
    session: new Map<string, number>(),
  }
  private residentSequence = 0
  private readonly results = new Map<string, ReturnType<typeof createQueryResult<unknown>>>()
  // Only residents unknown to the effective source contribute this correction.
  // Existing question atoms publish changes; these sets add no tracking objects.
  // Hydration, eviction and optimistic table writes all pass these observers.
  private readonly extras = {
    issue: new Set<string>(),
    session: new Set<string>(),
  }
  private readonly stopTables: (() => void)[] = []
  readonly counts = { questions: 0, returnedIds: 0, scalarVisits: 0 }
  constructor(
    private readonly pool: MobxPool,
    _schema: ModelSchema,
    private readonly source: () => ColdQueries,
  ) {
    for (const entity of ['issue', 'session'] as const)
      this.stopTables.push(
        observe(pool.tables[entity], (change) => {
          this.updateResident(entity, change.name)
          this.correctCount(entity, change.name)
          this.updateIdentity(entity, change.name)
        }),
      )
    this.stopTables.push(
      observe(pool.tables.repo, (change) => {
        const row =
          change.type === 'delete'
            ? undefined
            : (pool.row('repo', change.name) as Readonly<Record<string, unknown>> | undefined)
        this.changeRepoIdentity(
          change.name,
          typeof row?.prefix === 'string' ? row.prefix : undefined,
        )
      }),
    )
    this.stopTables.push(
      observe(pool.tables.worktree, (change) => {
        const row = pool.tables.worktree.get(change.name) as
          | Readonly<Record<string, unknown>>
          | undefined
        this.changeWorktree(change.name, row)
        if (change.type === 'add' || change.type === 'delete')
          this.publishTopology({ reset: false, sessions: [] })
      }),
    )
  }
  private changeWorktree(id: string, row: Readonly<Record<string, unknown>> | undefined): void {
    const before = this.worktrees.first()
    this.worktrees.set(id, row)
    if (before !== this.worktrees.first()) {
      this.firstWorktreeAtom.reportChanged()
      this.publishTopology({ reset: false, sessions: [] })
    }
  }
  firstWorktreePath(): string | null {
    this.firstWorktreeAtom.reportObserved()
    this.counts.scalarVisits++
    return this.worktrees.first()
  }
  /** Presence is independent of an activity timestamp, including epoch zero. */
  hasSessionWithin(path: string): boolean {
    const value = this.sessionQuestions().hasWithin(path),
      state = this.sessionPathAtoms.get(path)
    if (state) state.atom.reportObserved()
    else {
      const atom = createAtom(`history.sessionPath:${path}`, undefined, () =>
        this.sessionPathAtoms.delete(path),
      )
      if (atom.reportObserved()) this.sessionPathAtoms.set(path, { atom, value })
    }
    this.counts.scalarVisits++
    return value
  }
  private publishSessionPath(path: string): void {
    const state = this.sessionPathAtoms.get(path)
    if (!state) return
    const value = this.sessionQuestions().hasWithin(path)
    if (value === state.value) return
    state.value = value
    state.atom.reportChanged()
  }
  onTopology(listener: (delta: NavigationTopologyDelta) => void): () => void {
    // Fork the already maintained source roots before its next publication.
    this.sessionQuestions()
    this.topologyListeners.add(listener)
    return () => this.topologyListeners.delete(listener)
  }
  private publishTopology(delta: NavigationTopologyDelta): void {
    for (const listener of this.topologyListeners) listener(delta)
  }
  sessionTopology(id: string): NavigationTopologyDelta['sessions'][number]['after'] {
    const questions = this.sessionQuestions(),
      fact = questions.fact(id)
    return fact && questions.present(id)
      ? { cwd: fact.cwd, issueId: fact.issueId, order: fact.order }
      : undefined
  }
  private updateResident(entity: 'issue' | 'session', id: string): void {
    const present = this.pool.tables[entity].has(id)
    if (!present) this.residentOrder[entity].delete(id)
    else if (!this.residentOrder[entity].has(id))
      this.residentOrder[entity].set(id, ++this.residentSequence)
    if (entity === 'issue') {
      if (present) this.residentIssueIds.add(id)
      else this.residentIssueIds.delete(id)
    }
    const row = present ? untracked(() => this.pool.row(entity, id, 'summary-fields')) : undefined
    this.residents.apply({
      type: 'update',
      rows: [
        {
          kind: entity,
          id,
          value: row && row !== LOADING ? row : undefined,
        } as RowSourceEvent['rows'][number],
      ],
    })
    if (entity === 'session') {
      this.changeSessionFacts(id, (questions) => {
        if (present)
          questions.set(
            id,
            row && row !== LOADING ? (row as Readonly<Record<string, unknown>>) : undefined,
          )
        else questions.setFacts(id, this.index().sessionQuestionFact(id))
      })
    } else {
      this.changeIssueIdentity(id, (identities) => {
        if (present)
          identities.set(
            id,
            row && row !== LOADING ? (row as Readonly<Record<string, unknown>>) : undefined,
          )
        else identities.setFact(id, this.index().issueIdentityFact(id))
      })
      this.changeIssueFacts(id, (questions) => {
        if (present)
          questions.set(
            id,
            row && row !== LOADING ? (row as Readonly<Record<string, unknown>>) : undefined,
          )
        else questions.setFacts(id, this.index().issueQuestionFact(id))
      })
      this.publishIssueScope(id)
    }
    // Ranked windows do not have an identity answer to publish a delta through.
    for (const [key, state] of this.observed) {
      if (this.identities.has(key) || key.startsWith('count:')) continue
      const version = state.revision(this.index())
      if (state.version !== version) {
        state.version = version
        state.atom.reportChanged()
      }
    }
  }
  private sessionQuestions(): SessionQuestions {
    const index = this.index()
    if (!this.effectiveSessions || this.effectiveSource !== index) {
      this.effectiveSource = index
      this.effectiveSessions = index.forkSessionQuestions(
        (id) => this.index().sessionCollapsed(id),
        (id) => this.index().sessionOrderKey(id),
      )
    }
    return this.effectiveSessions
  }
  private issueQuestions(): IssueQuestions {
    const index = this.index()
    if (!this.effectiveIssues || this.effectiveIssueSource !== index) {
      this.effectiveIssueSource = index
      this.effectiveIssues = index.forkIssueQuestions()
    }
    return this.effectiveIssues
  }
  private correctCount(entity: 'issue' | 'session', id: string): void {
    const before = this.extras[entity].has(id)
    const extra = this.pool.tables[entity].has(id) && !this.index().known(entity, id)
    if (extra) this.extras[entity].add(id)
    else this.extras[entity].delete(id)
    if (before !== extra) this.observed.get(`count:${entity}`)?.atom.reportChanged()
  }
  private issueIdentities(): IssueIdentities {
    const source = this.index()
    if (!this.effectiveIssueIdentities || this.effectiveIdentitySource !== source) {
      this.effectiveIdentitySource = source
      this.effectiveIssueIdentities = source.forkIssueIdentities()
      for (const [id, prefix] of this.repoOverrides)
        this.effectiveIssueIdentities.setRepo(id, prefix)
    }
    return this.effectiveIssueIdentities
  }
  /** Exact ID, exact display alias, then a parsed human ref. First demand
   * reads maintained roots; it never seeds references from resident rows. */
  linkedIssueId(identifier: string): string | undefined {
    return this.readIssueIdentity(identifier, false)
  }
  /** A terminal token asks about a human reference, even when an unrelated
   * raw issue ID happens to have the same spelling. */
  issueReferenceId(token: string): string | undefined {
    return this.readIssueIdentity(token, true)
  }
  private readIssueIdentity(identifier: string, referenceOnly: boolean): string | undefined {
    const identities = this.issueIdentities()
    const value = referenceOnly
      ? identities.referenceId(identifier)
      : identities.resolve(identifier)
    const question = JSON.stringify([referenceOnly, identifier])
    const state = this.linkedIssueAtoms.get(question)
    if (state) state.atom.reportObserved()
    else {
      const keys = identities.aliasKeys(identifier)
      const prefixes = keys
        .filter((key) => !key.startsWith('#'))
        .map((key) => JSON.parse(key)[0] as string)
      const atom = createAtom(`history.linkedIssue:${identifier}`, undefined, () => {
        this.linkedIssueAtoms.delete(question)
        const remove = (map: Map<string, Set<string>>, key: string) => {
          const ids = map.get(key)
          ids?.delete(question)
          if (!ids?.size) map.delete(key)
        }
        for (const key of keys) remove(this.linkedAliases, key)
        for (const prefix of prefixes) remove(this.linkedPrefixes, prefix)
      })
      if (atom.reportObserved()) {
        this.linkedIssueAtoms.set(question, { atom, value, identifier, referenceOnly })
        const add = (map: Map<string, Set<string>>, key: string) => {
          let ids = map.get(key)
          if (!ids) {
            ids = new Set()
            map.set(key, ids)
          }
          ids.add(question)
        }
        for (const key of keys) add(this.linkedAliases, key)
        for (const prefix of prefixes) add(this.linkedPrefixes, prefix)
      }
    }
    this.counts.scalarVisits++
    return value
  }
  private publishLinkedIssue(question: string): void {
    const state = this.linkedIssueAtoms.get(question)
    if (!state) return
    const identities = this.issueIdentities()
    const value = state.referenceOnly
      ? identities.referenceId(state.identifier)
      : identities.resolve(state.identifier)
    if (value === state.value) return
    state.value = value
    state.atom.reportChanged()
  }
  private publishLinkedAlias(key: string | undefined): void {
    if (key)
      for (const identifier of this.linkedAliases.get(key) ?? [])
        this.publishLinkedIssue(identifier)
  }
  private changeIssueIdentity(id: string, change: (identities: IssueIdentities) => void): void {
    const identities = this.issueIdentities(),
      previous = identities.fact(id)
    const before = identities.factAlias(previous)
    const beforePrefix = previous?.repoId ? identities.repoPrefix(previous.repoId) : undefined
    change(identities)
    this.publishLinkedIssue(JSON.stringify([false, id]))
    this.publishLinkedAlias(before)
    const after = identities.factAlias(identities.fact(id))
    if (after !== before) this.publishLinkedAlias(after)
    const next = identities.fact(id)
    const afterPrefix = next?.repoId ? identities.repoPrefix(next.repoId) : undefined
    if (beforePrefix) this.publishIssuePrefix(beforePrefix)
    if (afterPrefix && afterPrefix !== beforePrefix) this.publishIssuePrefix(afterPrefix)
  }
  private changeRepoIdentity(id: string, prefix: string | undefined): void {
    const previous = this.repoOverrides.get(id)
    if (previous !== prefix) {
      let changed = false
      if (previous) {
        const count = this.repoPrefixCounts.get(previous) ?? 0
        if (count > 1) this.repoPrefixCounts.set(previous, count - 1)
        else {
          this.repoPrefixCounts.delete(previous)
          this.repoPrefixes.splice(this.repoPrefixPosition(previous), 1)
          changed = true
        }
      }
      if (prefix) {
        const count = this.repoPrefixCounts.get(prefix) ?? 0
        this.repoPrefixCounts.set(prefix, count + 1)
        if (count === 0) {
          this.repoPrefixes.splice(this.repoPrefixPosition(prefix), 0, prefix)
          changed = true
        }
      }
      if (changed) {
        this.repoPrefixValue = this.repoPrefixes.join(',')
        this.repoPrefixAtom.reportChanged()
      }
    }
    this.repoOverrides.set(id, prefix)
    const row = this.pool.row('repo', id) as Readonly<Record<string, unknown>> | undefined
    this.residents.apply({ type: 'update', rows: [{ kind: 'repo', id, value: row }] })
    const identities = this.issueIdentities(),
      before = identities.repoPrefix(id)
    const bare = identities.setRepo(id, prefix)
    for (const token of this.sessionReferenceAtoms.keys()) {
      const key = parseSessionRef(token)?.prefix
      if (key === before || key === prefix) this.publishSessionReference(token)
    }
    for (const key of bare) this.publishLinkedAlias(key)
    for (const key of new Set([before, prefix]))
      if (key) {
        for (const question of this.linkedPrefixes.get(key) ?? []) this.publishLinkedIssue(question)
        this.publishIssuePrefix(key)
      }
  }
  private repoPrefixPosition(prefix: string): number {
    let lo = 0,
      hi = this.repoPrefixes.length
    while (lo < hi) {
      const at = (lo + hi) >>> 1
      if (this.repoPrefixes[at]! < prefix) lo = at + 1
      else hi = at
    }
    return lo
  }
  /** Registered resident repo prefixes, including repos with no issues.
   * Membership is filed with the existing addressed identity facts. */
  repositoryPrefixKey(): string {
    this.repoPrefixAtom.reportObserved()
    this.counts.scalarVisits++
    return this.repoPrefixValue
  }
  /** One prefix's maintained membership: terminal links require a live issue;
   * inbox references also admit deleted issue identities. No catalog demand. */
  hasIssuePrefix(prefix: string, includeDeleted = false): boolean {
    const key = JSON.stringify([includeDeleted, prefix])
    const value = this.issueIdentities().hasPrefix(prefix, includeDeleted),
      state = this.issuePrefixAtoms.get(key)
    if (state) state.atom.reportObserved()
    else {
      const atom = createAtom(`history.issuePrefix:${key}`, undefined, () =>
        this.issuePrefixAtoms.delete(key),
      )
      if (atom.reportObserved())
        this.issuePrefixAtoms.set(key, { atom, value, prefix, includeDeleted })
    }
    this.counts.scalarVisits++
    return value
  }
  private publishIssuePrefix(prefix: string): void {
    for (const includeDeleted of [false, true]) {
      const state = this.issuePrefixAtoms.get(JSON.stringify([includeDeleted, prefix]))
      if (!state) continue
      const value = this.issueIdentities().hasPrefix(prefix, includeDeleted)
      if (state.value === value) continue
      state.value = value
      state.atom.reportChanged()
    }
  }
  private referenceKeys(ref: string): string[] {
    const prefix = parseSessionRef(ref)?.prefix
    return prefix
      ? this.issueIdentities()
          .repoIds(prefix)
          .map((id) => referenceKey(id, ref)!)
      : []
  }
  private releaseReference(ref: string): void {
    for (const key of this.sessionReferenceAtoms.get(ref)?.keys ?? []) {
      const tokens = this.referenceTokens.get(key)
      tokens?.delete(ref)
      if (!tokens?.size) this.referenceTokens.delete(key)
    }
    this.sessionReferenceAtoms.delete(ref)
  }
  private referenceWinner(ref: string, questions: SessionQuestions): string | undefined {
    const parsed = parseSessionRef(ref)
    if (!parsed) return undefined
    const ids = this.issueIdentities().repoIds(parsed.prefix)
    let first: string | undefined
    for (const repoId of ids) {
      const id = questions.referenceId(referenceKey(repoId, ref)!)
      if (
        id &&
        (first === undefined ||
          this.index().sessionOrderKey(id) < this.index().sessionOrderKey(first))
      )
        first = id
    }
    return first
  }
  sessionReferenceId(ref: string): string | undefined {
    const questions = this.sessionQuestions(),
      before = questions.visits,
      value = this.referenceWinner(ref, questions)
    this.counts.scalarVisits += questions.visits - before
    const state = this.sessionReferenceAtoms.get(ref)
    if (state) state.atom.reportObserved()
    else {
      const atom = createAtom(`history.sessionReference:${ref}`, undefined, () =>
        this.releaseReference(ref),
      )
      if (atom.reportObserved()) {
        const keys = this.referenceKeys(ref)
        this.sessionReferenceAtoms.set(ref, { atom, value, keys })
        for (const key of keys) {
          let tokens = this.referenceTokens.get(key)
          if (!tokens) {
            tokens = new Set()
            this.referenceTokens.set(key, tokens)
          }
          tokens.add(ref)
        }
      }
    }
    return value
  }
  linkedSessionId(identifier: string): string | undefined {
    this.observeSession('presence', identifier)
    const present = this.sessionQuestions().fact(identifier) !== undefined
    if (present && !this.collapsed(identifier)) return identifier
    const ref = identifier.trim()
    return parseSessionRef(ref) ? this.sessionReferenceId(ref) : undefined
  }
  private publishSessionReference(ref: string | undefined): void {
    if (!ref) return
    const state = this.sessionReferenceAtoms.get(ref)
    if (!state) {
      for (const token of [...(this.referenceTokens.get(ref) ?? [])])
        this.publishSessionReference(token)
      return
    }
    const keys = this.referenceKeys(ref)
    if (keys.length !== state.keys.length || keys.some((key, at) => state.keys[at] !== key)) {
      for (const key of state.keys) {
        const tokens = this.referenceTokens.get(key)
        tokens?.delete(ref)
        if (!tokens?.size) this.referenceTokens.delete(key)
      }
      state.keys = keys
      for (const key of keys) {
        let tokens = this.referenceTokens.get(key)
        if (!tokens) {
          tokens = new Set()
          this.referenceTokens.set(key, tokens)
        }
        tokens.add(ref)
      }
    }
    const value = this.referenceWinner(ref, this.sessionQuestions())
    if (value === state.value) return
    state.value = value
    state.atom.reportChanged()
  }
  private sourceOnly(question: ReaderQuestion): boolean {
    return (
      question.kind === 'issueMentionMatches' ||
      question.kind === 'mobileIssueTargets' ||
      question.kind === 'spawnIssues' ||
      (question.kind === 'commandIssueSessions' &&
        (question.archived !== undefined || question.includeShells !== undefined))
    )
  }
  private includes(question: ReaderQuestion, id: string): boolean {
    if (question.kind === 'residentIssues') return this.residentIssueIds.has(id)
    if (!this.sourceOnly(question) && this.pool.tables[questionEntity(question)].has(id))
      return this.residents.contains(question, id)
    return this.index().readerContains(question, id)
  }
  /** Addressed predicate membership; no identity answer is enumerated. */
  has(question: ReaderQuestion, id: string): boolean {
    return this.includes(question, id)
  }
  /** Gesture-local order of a named resident slot, matching table insertion
   * ties without iterating the table to discover that slot's position. */
  residentInsertionOrder(entity: 'issue' | 'session', id: string): number | undefined {
    return this.residentOrder[entity].get(id)
  }
  /** Ancestor scope follows only its four visibility bits, never its title or
   * other presentation fields. Resident writes shadow the source by address. */
  issueScope(id: string): IssueScopeFacts | undefined {
    const value = this.issueScopeValue(id)
    const state = this.issueScopeAtoms.get(id)
    if (!state) {
      const atom = createAtom(`history.issueScope:${id}`, undefined, () =>
        this.issueScopeAtoms.delete(id),
      )
      if (atom.reportObserved()) this.issueScopeAtoms.set(id, { atom, bits: this.scopeBits(value) })
    } else state.atom.reportObserved()
    return value
  }
  private issueScopeValue(id: string): IssueScopeFacts | undefined {
    return this.residentIssueIds.has(id)
      ? this.residents.issueScope(id)
      : this.index().issueScope(id)
  }
  private scopeBits(value: IssueScopeFacts | undefined): number {
    return value === undefined
      ? -1
      : Number(value.draft) |
          (Number(value.deleted) << 1) |
          (Number(value.archived) << 2) |
          (Number(value.agent) << 3)
  }
  private publishIssueScope(id: string): void {
    const state = this.issueScopeAtoms.get(id)
    if (!state) return
    const bits = this.scopeBits(this.issueScopeValue(id))
    if (bits === state.bits) return
    state.bits = bits
    state.atom.reportChanged()
  }
  /** Maintained own-session concern counts. A close asks for this key only;
   * neither first demand nor repeated clicks construct a history roster. */
  issueCloseCounts(id: string): IssueCloseMemberCounts {
    const value = this.sessionQuestions().issueCloseCounts(id)
    const state = this.issueCloseAtoms.get(id)
    if (state) state.atom.reportObserved()
    else {
      const atom = createAtom(`history.issueClose:${id}`, undefined, () =>
        this.issueCloseAtoms.delete(id),
      )
      if (atom.reportObserved()) this.issueCloseAtoms.set(id, { atom, value })
    }
    this.counts.scalarVisits++
    return value
  }
  private publishIssueClose(id: string): void {
    const state = this.issueCloseAtoms.get(id)
    if (!state) return
    const value = this.sessionQuestions().issueCloseCounts(id)
    if (value.offers === state.value.offers && value.working === state.value.working) return
    state.value = value
    state.atom.reportChanged()
  }
  private changeSessionFacts(id: string, change: (questions: SessionQuestions) => void): void {
    const questions = this.sessionQuestions(),
      previous = questions.fact(id)
    const before = previous?.issueId,
      beforeRef = previous?.referenceKey
    const beforePresent = previous !== undefined
    const beforeVisible = this.topologyListeners.size ? questions.present(id) : false
    change(questions)
    const next = questions.fact(id)
    if (beforePresent !== (next !== undefined))
      this.sessionAtoms.get(`presence:${id}`)?.reportChanged()
    const after = next?.issueId
    if (before) this.publishIssueClose(before)
    if (after && after !== before) this.publishIssueClose(after)
    this.publishSessionReference(beforeRef)
    const afterRef = next?.referenceKey
    if (afterRef !== beforeRef) this.publishSessionReference(afterRef)
    if (this.sessionPathAtoms.size) {
      const paths = new Set<string>()
      for (const cwd of [previous?.cwd, next?.cwd]) {
        if (cwd === undefined) continue
        paths.add(cwd)
        for (let at = cwd.indexOf('/'); at >= 0; at = cwd.indexOf('/', at + 1))
          paths.add(cwd.slice(0, at))
      }
      for (const path of paths) this.publishSessionPath(path)
    }
    if (this.topologyListeners.size) {
      const afterVisible = questions.present(id)
      if (
        beforeVisible !== afterVisible ||
        (beforeVisible &&
          afterVisible &&
          (previous?.cwd !== next?.cwd ||
            previous?.issueId !== next?.issueId ||
            previous?.order !== next?.order))
      )
        this.publishTopology({
          reset: false,
          sessions: [
            {
              id,
              before:
                previous && beforeVisible
                  ? { cwd: previous.cwd, issueId: previous.issueId, order: previous.order }
                  : undefined,
              after:
                next && afterVisible
                  ? { cwd: next.cwd, issueId: next.issueId, order: next.order }
                  : undefined,
            },
          ],
        })
    }
  }
  /** Raw parent edges count archived/deleted children, with only stage=done
   * contributing to the completed count, matching the issue close contract. */
  issueChildCounts(id: string): IssueChildCounts {
    const value = this.issueQuestions().childCounts(id),
      state = this.issueChildAtoms.get(id)
    if (state) state.atom.reportObserved()
    else {
      const atom = createAtom(`history.issueChildren:${id}`, undefined, () =>
        this.issueChildAtoms.delete(id),
      )
      if (atom.reportObserved()) this.issueChildAtoms.set(id, { atom, value })
    }
    this.counts.scalarVisits++
    return value
  }
  private publishIssueChildren(id: string): void {
    const state = this.issueChildAtoms.get(id)
    if (!state) return
    const value = this.issueQuestions().childCounts(id)
    if (
      value.childCount === state.value.childCount &&
      value.childDoneCount === state.value.childDoneCount
    )
      return
    state.value = value
    state.atom.reportChanged()
  }
  private changeIssueFacts(id: string, change: (questions: IssueQuestions) => void): void {
    const questions = this.issueQuestions(),
      previous = questions.fact(id),
      before = previous?.parentId
    change(questions)
    const next = questions.fact(id),
      after = next?.parentId
    if (before) this.publishIssueChildren(before)
    if (after && after !== before) this.publishIssueChildren(after)
    if (previous?.containment !== next?.containment) {
      const paths = new Set([previous?.containment?.path, next?.containment?.path])
      const questions = new Set<string>()
      for (const path of paths)
        if (path) for (const cwd of this.containingIssuePaths.get(path) ?? []) questions.add(cwd)
      for (const cwd of questions) this.publishContainingIssue(cwd)
    }
  }
  /** One live issue for a file's path: longest containing root, then the
   * smallest sequence and that root's source insertion order. */
  containingIssueId(cwd: string): string | undefined {
    const value = this.issueQuestions().containingIssueId(cwd),
      state = this.containingIssueAtoms.get(cwd)
    if (state) state.atom.reportObserved()
    else {
      const paths = new Set([cwd])
      for (let at = cwd.indexOf('/'); at >= 0; at = cwd.indexOf('/', at + 1)) {
        paths.add(cwd.slice(0, at))
        paths.add(cwd.slice(0, at + 1))
      }
      const atom = createAtom(`history.containingIssue:${cwd}`, undefined, () => {
        this.containingIssueAtoms.delete(cwd)
        for (const path of paths) {
          const questions = this.containingIssuePaths.get(path)
          questions?.delete(cwd)
          if (!questions?.size) this.containingIssuePaths.delete(path)
        }
      })
      if (atom.reportObserved()) {
        this.containingIssueAtoms.set(cwd, { atom, value })
        for (const path of paths) {
          let questions = this.containingIssuePaths.get(path)
          if (!questions) {
            questions = new Set()
            this.containingIssuePaths.set(path, questions)
          }
          questions.add(cwd)
        }
      }
    }
    this.counts.scalarVisits++
    return value
  }
  private publishContainingIssue(cwd: string): void {
    const state = this.containingIssueAtoms.get(cwd)
    if (!state) return
    const value = this.issueQuestions().containingIssueId(cwd)
    if (state.value === value) return
    state.value = value
    state.atom.reportChanged()
  }
  private updateIdentity(entity: 'issue' | 'session', id: string): void {
    for (const [key, result] of this.identities) {
      if (questionEntity(result.question) !== entity) continue
      const before = result.answer.has(id),
        after = this.includes(result.question, id)
      if (before === after) continue
      if (after) this.addIdentity(result, id)
      else result.answer.delete(id)
      this.observed.get(key)?.atom.reportChanged()
    }
  }
  private addIdentity(result: IdentityResult, id: string): void {
    const order =
      questionEntity(result.question) === 'session'
        ? id
        : String(result.nextOrder++).padStart(16, '0')
    result.answer.set(id, order, id)
  }
  private identityResult(question: ReaderQuestion, source: ColdQueries): IdentityResult {
    const result = { question, source, answer: createKeyedAnswer<string>(), nextOrder: 0 }
    for (const id of this.initialIds(question, source)) this.addIdentity(result, id)
    return result
  }
  private index(): ColdQueries {
    return this.source()
  }
  private watch(key: string, revision: (index: ColdQueries) => number): ColdQueries {
    const index = this.index()
    let state = this.observed.get(key)
    const created = state === undefined
    if (!state) {
      state = {
        atom: createAtom(`history.${key}`, undefined, () => {
          this.observed.delete(key)
          this.identities.delete(key)
        }),
        version: revision(index),
        revision,
      }
      this.observed.set(key, state)
    }
    if (!state.atom.reportObserved() && created) this.observed.delete(key)
    return index
  }
  private publicationTopologyBefore:
    | Map<string, NavigationTopologyDelta['sessions'][number]['before']>
    | undefined
  /** Keep the named before facts before table observers can adopt a freshly
   * replaced source root. This is publication input, released at publish. */
  beginPublication(event: RowSourceEvent): void {
    this.publicationTopologyBefore = undefined
    if (
      !this.topologyListeners.size ||
      !this.effectiveSessions ||
      (event.type !== 'replace' &&
        (this.sourceSeen === undefined || this.sourceSeen === this.index()))
    )
      return
    const before = new Map<string, NavigationTopologyDelta['sessions'][number]['before']>()
    for (const row of event.rows)
      if (row.kind === 'session' && !before.has(row.id)) {
        const fact = this.effectiveSessions.fact(row.id)
        before.set(
          row.id,
          fact && this.effectiveSessions.present(row.id)
            ? { cwd: fact.cwd, issueId: fact.issueId, order: fact.order }
            : undefined,
        )
      }
    this.publicationTopologyBefore = before
  }
  publish(event: RowSourceEvent): void {
    const index = this.index()
    const fresh = this.sourceSeen !== undefined && this.sourceSeen !== index
    this.sourceSeen = index
    // A replacement carries every new identity. Compare those addressed
    // records against the prior persistent roots before forking the new roots;
    // new IDs have no before fact and remain first sight.
    const beforeReplacement =
      this.publicationTopologyBefore ??
      new Map<string, NavigationTopologyDelta['sessions'][number]['before']>()
    const captured = this.publicationTopologyBefore !== undefined
    this.publicationTopologyBefore = undefined
    if (
      !captured &&
      (event.type === 'replace' || fresh) &&
      this.topologyListeners.size &&
      this.effectiveSessions
    )
      for (const row of event.rows)
        if (row.kind === 'session' && !beforeReplacement.has(row.id)) {
          const fact = this.effectiveSessions.fact(row.id)
          beforeReplacement.set(
            row.id,
            fact && this.effectiveSessions.present(row.id)
              ? { cwd: fact.cwd, issueId: fact.issueId, order: fact.order }
              : undefined,
          )
        }
    for (const row of event.rows)
      if (row.kind === 'worktree')
        this.changeWorktree(row.id, row.value as Readonly<Record<string, unknown>> | undefined)
    if (event.type === 'replace' || fresh) {
      this.effectiveSource = index
      this.effectiveSessions = index.forkSessionQuestions(
        (id) => this.index().sessionCollapsed(id),
        (id) => this.index().sessionOrderKey(id),
      )
      this.effectiveIssueSource = index
      this.effectiveIssues = index.forkIssueQuestions()
      this.effectiveIdentitySource = index
      this.effectiveIssueIdentities = index.forkIssueIdentities()
      for (const [id, prefix] of this.repoOverrides)
        this.effectiveIssueIdentities.setRepo(id, prefix)
      for (const id of residentIds(this.pool, 'issue')) this.updateResident('issue', id)
      for (const id of residentIds(this.pool, 'session')) this.updateResident('session', id)
      for (const entity of ['issue', 'session'] as const) {
        this.extras[entity].clear()
        for (const id of residentIds(this.pool, entity)) this.correctCount(entity, id)
      }
    } else {
      for (const id of index.issueIdentityRepoChanges(event)) {
        const row = untracked(() => this.pool.row('repo', id)) as
          | Readonly<Record<string, unknown>>
          | undefined
        this.changeRepoIdentity(id, row && typeof row.prefix === 'string' ? row.prefix : undefined)
      }
      const delta = index.changes(event)
      for (const [entity, id] of [...delta.flips, ...delta.orders])
        if (entity === 'session')
          this.changeSessionFacts(id, (questions) => questions.visibilityChanged(id))
    }
    // Replacement counts were rebuilt from residents above. Observed identity
    // answers are rebuilt below from the new source catalog. Updating every
    // cold member here would construct an answer that is immediately discarded.
    for (const row of event.rows)
      if (row.kind === 'issue' || row.kind === 'session') {
        if (event.type !== 'replace' && !fresh) {
          this.correctCount(row.kind, row.id)
          this.updateIdentity(row.kind, row.id)
        }
        if (row.kind === 'session' && !this.pool.tables.session.has(row.id))
          this.changeSessionFacts(row.id, (questions) =>
            questions.setFacts(row.id, index.sessionQuestionFact(row.id)),
          )
        if (row.kind === 'issue') {
          if (!this.pool.tables.issue.has(row.id)) {
            this.changeIssueIdentity(row.id, (identities) =>
              identities.setFact(row.id, index.issueIdentityFact(row.id)),
            )
            this.changeIssueFacts(row.id, (questions) =>
              questions.setFacts(row.id, index.issueQuestionFact(row.id)),
            )
          }
          this.publishIssueScope(row.id)
        }
      }
    if (event.type === 'replace' || fresh) {
      for (const id of this.issueScopeAtoms.keys()) this.publishIssueScope(id)
      for (const id of this.issueCloseAtoms.keys()) this.publishIssueClose(id)
      for (const id of this.issueChildAtoms.keys()) this.publishIssueChildren(id)
      for (const cwd of this.containingIssueAtoms.keys()) this.publishContainingIssue(cwd)
      for (const id of this.linkedIssueAtoms.keys()) this.publishLinkedIssue(id)
      for (const state of this.issuePrefixAtoms.values()) this.publishIssuePrefix(state.prefix)
      for (const ref of this.sessionReferenceAtoms.keys()) this.publishSessionReference(ref)
      for (const path of this.sessionPathAtoms.keys()) this.publishSessionPath(path)
      const sessions: NavigationTopologyDelta['sessions'][number][] = []
      for (const [id, before] of beforeReplacement) {
        const after = this.sessionTopology(id)
        if (
          before?.cwd !== after?.cwd ||
          before?.issueId !== after?.issueId ||
          before?.order !== after?.order
        )
          sessions.push({ id, before, after })
      }
      this.publishTopology({ reset: true, sessions })
    }
    for (const [key, state] of this.observed) {
      const version = state.revision(index)
      const result = this.identities.get(key)
      const joinedQuestion =
        result?.question.kind === 'sessionReference' ||
        (result?.question.kind === 'boardIssues' && !!result.question.projectPaths?.length)
      const companionMoved =
        joinedQuestion &&
        state.version !== version &&
        event.rows.some((row) => row.kind === 'repo' || row.kind === 'worktree')
      if (result && (event.type === 'replace' || result.source !== index || companionMoved)) {
        this.identities.set(key, this.identityResult(result.question, index))
        state.version = version
        state.atom.reportChanged()
      } else if (state.version !== version || fresh || event.type === 'replace') {
        state.version = version
        // Identity questions are notified only by a membership delta below.
        // Counts and ordered windows still follow their declared revisions.
        if (!result) state.atom.reportChanged()
      }
    }
    if (event.type === 'replace' || fresh) {
      for (const atom of this.sessionAtoms.values()) atom.reportChanged()
    } else {
      const delta = index.changes(event)
      for (const [entity, id] of delta.flips)
        if (entity === 'session') this.sessionAtoms.get(`collapsed:${id}`)?.reportChanged()
      for (const [entity, id] of delta.orders)
        if (entity === 'session') this.sessionAtoms.get(`order:${id}`)?.reportChanged()
    }
    if (event.type === 'replace' || fresh) {
      const listeners = [...this.memberListeners.values()].flatMap((value) => [...value])
      for (const listener of listeners) listener(undefined)
    } else {
      for (const [relation, owner, member] of index.changes(event).buckets)
        for (const listener of [...(this.memberListeners.get(`${relation}:${owner}`) ?? [])])
          listener(member)
    }
    for (const listener of [...this.listeners]) listener(event)
  }
  onChange(listener: (event: RowSourceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** A declared relation's keyed membership deltas, without waking every
   * other owner's query when a member moves. */
  onMembers(
    entity: 'issue' | 'session',
    owner: string,
    relation: string,
    listener: (id: string | undefined) => void,
  ): () => void {
    const key = `${entity}.${relation}:${owner}`
    let listeners = this.memberListeners.get(key)
    if (!listeners) {
      listeners = new Set()
      this.memberListeners.set(key, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.memberListeners.delete(key)
    }
  }
  /** Addressed membership in the source's declared relation. Maintenance
   * callers pair this with onMembers, rather than enumerating the bucket. */
  hasMember(entity: 'issue' | 'session', owner: string, relation: string, id: string): boolean {
    return this.index().relations.members(entity, owner, relation).has(id)
  }
  ids(question: ReaderQuestion): string[] {
    const key = JSON.stringify(question)
    const index = this.watch(key, (value) =>
      question.kind === 'headerRecentSession'
        ? this.sessionQuestions().recentRevision()
        : value.readerRevision(question) +
          (this.sourceOnly(question) ? 0 : this.residents.revision(question)),
    )
    // Ranked windows stay bounded in the source's existing index.
    if (
      question.kind === 'issueMentionMatches' ||
      question.kind === 'mobileIssueTargets' ||
      question.kind === 'headerRecentSession'
    ) {
      const ids = this.initialIds(question, index)
      this.counts.questions++
      this.counts.returnedIds += ids.length
      return ids
    }
    let result = this.identities.get(key)
    if (!result) {
      result = this.identityResult(question, index)
      if (this.observed.has(key)) this.identities.set(key, result)
    }
    const ids = result.answer.snapshot()
    this.counts.questions++
    this.counts.returnedIds += ids.length
    // Legacy callers own their sorting/filtering array. The maintained answer
    // remains identities only, and is never re-derived for a payload change.
    return ids
  }
  private initialIds(question: ReaderQuestion, index: ColdQueries): string[] {
    const entity = questionEntity(question)
    // These predicates are answered by the effective source feed, including
    // its pending overlays. Adding every resident identity would break the
    // target window or the requested issue/archive/shell roster.
    if (this.sourceOnly(question)) return index.readerIds(question)
    if (question.kind === 'residentIssues') return [...this.residentIssueIds]
    if (question.kind === 'headerRecentSession') {
      const excluded =
        question.excluded && 'has' in question.excluded
          ? question.excluded
          : new Set(question.excluded)
      const questions = this.sessionQuestions(),
        before = questions.visits
      const answer = questions.recent(excluded)
      this.counts.scalarVisits += questions.visits - before
      return answer ? [answer.id] : []
    }
    const ids = [
      ...new Set([
        ...index
          .readerIds(question)
          .filter(
            (id) => !this.pool.tables[entity].has(id) || this.residents.contains(question, id),
          ),
        ...this.residents.ids(question),
      ]),
    ]
    return entity === 'session' ? ids.sort() : ids
  }
  /** A declared question's demanded row answers, maintained by changed key.
   * They use only pool.row in the caller, and disappear when unobserved. */
  project<T>(question: ReaderQuestion, name: string, read: (id: string) => Loaded<T>): Loaded<T[]> {
    const key = `${name}:${JSON.stringify(question)}`
    let result = this.results.get(key)
    if (!result) {
      result = createQueryResult<unknown>({
        name,
        ids: () => untracked(() => this.ids(question)),
        has: (id) => untracked(() => this.includes(question, id)),
        read,
        subscribe: (changed) => {
          const entity = questionEntity(question)
          const stopTable = observe(this.pool.tables[entity], (change) => changed(change.name))
          let source = this.index()
          const stopFeed = this.onChange((event) => {
            if (event.type === 'replace' || source !== this.index()) {
              source = this.index()
              changed(undefined)
            } else for (const row of event.rows) if (row.kind === entity) changed(row.id)
          })
          return () => {
            stopTable()
            stopFeed()
          }
        },
        released: () => this.results.delete(key),
      })
      this.results.set(key, result)
    }
    return result.get() as Loaded<T[]>
  }
  /** The effective source's indexed candidates, including pending overlays.
   * References, context paths and ranked windows must not add every resident
   * identity to an already bounded answer. */
  indexed(
    question: Extract<
      ReaderQuestion,
      { kind: 'sessionReference' | 'spawnIssues' | 'headerRecentSession' | 'containingIssues' }
    >,
  ): string[] {
    const index = this.watch(JSON.stringify(question), (value) => value.readerRevision(question))
    const ids = index.readerIds(question)
    this.counts.questions++
    this.counts.returnedIds += ids.length
    return ids
  }
  count(entity: 'issue' | 'session'): number {
    const question: ReaderQuestion = {
      kind: entity === 'issue' ? 'commandIssues' : 'commandSessions',
    }
    const index = this.watch(`count:${entity}`, (value) => value.readerRevision(question))
    return index.count(entity) + this.extras[entity].size
  }
  repoIds(repoPath?: string): string[] {
    const key = repoPath === undefined ? 'repos' : `repos.path:${JSON.stringify(repoPath)}`
    const index = this.watch(key, (value) =>
      repoPath === undefined
        ? value.issueRepoRevision + this.residents.repoRevision
        : value.issueRepoPathRevision(repoPath) + this.residents.repoPathRevision(repoPath),
    )
    return [
      ...new Set([...index.issueRepoIds(repoPath), ...this.residents.repoIds(repoPath)]),
    ].sort()
  }
  activity(question: SessionActivityQuestion): number {
    const key = JSON.stringify({
      ...question,
      ...(question.excluded ? { excluded: [...question.excluded] } : {}),
    })
    this.watch(`activity:${key}`, () => this.sessionQuestions().activityRevision(question))
    const questions = this.sessionQuestions(),
      before = questions.activityVisits
    const answer = questions.activity(question)
    this.counts.scalarVisits += questions.activityVisits - before
    return answer
  }
  collapsed(id: string): boolean {
    this.observeSession('collapsed', id)
    return this.index().sessionCollapsed(id)
  }
  /** One successor in attention order; absence starts at the first agent.
   * The source includes pending overlays; resident edits shadow changed keys. */
  nextTriageSession(id: string): string | undefined {
    const questions = this.sessionQuestions(),
      now = this.pool.clock.current,
      before = questions.visits
    const after = questions.triageFact(id, now)
    const answer = questions.next(after, now) ?? questions.next(undefined, now)
    this.counts.scalarVisits += questions.visits - before
    return answer?.id === id ? undefined : answer?.id
  }
  latestMachineSession(
    machineIds: readonly string[],
  ): { machineId: string; createdAt: string } | undefined {
    this.watch(`latestMachine:${JSON.stringify(machineIds)}`, () =>
      this.sessionQuestions().machineRevision(machineIds),
    )
    const questions = this.sessionQuestions(),
      before = questions.visits
    const answer = questions.latest(machineIds)
    this.counts.scalarVisits += questions.visits - before
    return answer && { machineId: answer.machineId, createdAt: answer.createdAt }
  }
  /** Setup uses effective source winners, including archived/cold sessions.
   * These scalar answers never project the session catalog. */
  setupDefaultAgent(): string | undefined {
    this.watch('setup:agent', () => this.sessionQuestions().setupRevision('agent'))
    this.counts.scalarVisits++
    return this.sessionQuestions().setupAgent()
  }
  setupSessionCount(): number {
    this.watch('setup:count', () => this.sessionQuestions().setupRevision('count'))
    this.counts.scalarVisits++
    return this.sessionQuestions().setupCount()
  }
  setupSessionPresent(id: string): boolean {
    this.observeSession('presence', id)
    this.observeSession('collapsed', id)
    this.counts.scalarVisits++
    return this.sessionQuestions().present(id)
  }
  orderKey(id: string): string {
    this.observeSession('order', id)
    return this.index().sessionOrderKey(id)
  }
  private observeSession(kind: 'collapsed' | 'order' | 'presence', id: string): void {
    const key = `${kind}:${id}`
    const atom = this.sessionAtoms.get(key)
    if (!atom) {
      const created = createAtom(`history.${key}`, undefined, () => this.sessionAtoms.delete(key))
      if (!created.reportObserved()) return
      this.sessionAtoms.set(key, created)
    } else atom.reportObserved()
  }
  dispose(): void {
    for (const stop of this.stopTables) stop()
    this.repoOverrides.clear()
    this.repoPrefixCounts.clear()
    this.repoPrefixes.length = 0
    this.repoPrefixValue = ''
    for (const result of [...this.results.values()]) result.dispose()
    this.results.clear()
    this.identities.clear()
    this.listeners.clear()
    this.memberListeners.clear()
    this.observed.clear()
    this.sessionAtoms.clear()
    this.issueScopeAtoms.clear()
    this.issueCloseAtoms.clear()
    this.issueChildAtoms.clear()
    this.containingIssueAtoms.clear()
    this.containingIssuePaths.clear()
    this.linkedIssueAtoms.clear()
    this.issuePrefixAtoms.clear()
    this.linkedAliases.clear()
    this.linkedPrefixes.clear()
    this.sessionReferenceAtoms.clear()
    this.referenceTokens.clear()
    this.sessionPathAtoms.clear()
    this.topologyListeners.clear()
    this.publicationTopologyBefore = undefined
    this.worktrees.clear()
    this.residentIssueIds.clear()
    this.residentOrder.issue.clear()
    this.residentOrder.session.clear()
    this.residents.apply({ type: 'replace', rows: [] })
    this.effectiveSessions?.clear()
    this.effectiveSessions = undefined
    this.effectiveSource = undefined
    this.effectiveIssues?.clear()
    this.effectiveIssues = undefined
    this.effectiveIssueSource = undefined
    this.effectiveIssueIdentities?.clear()
    this.effectiveIssueIdentities = undefined
    this.effectiveIdentitySource = undefined
  }
}
