/**
 * THE FULL DECK (flight deck v6) — the Full view's projection of one mission
 * opening: its accepted tree with phases, the task words, the leaf totals the
 * gauge and the filters count, the direct-child counters, the seats, the
 * proposals, and the Full-only UI state (filter, Show done, default folds).
 *
 * Decisions D1–D8 in `docs/design/flight-deck-v6/ANALYSIS.md` (POD-6118). The
 * words, the roll-up, the leaf and the counter units are POD-6110's shared
 * module (`@podium/model` state-word); this file only places them. It reads the
 * existing full deck (`MissionDeckModel` in mode `full`) for topology, grafts,
 * crew and the task word, so Waterfall, Timeline and the phone keep their own
 * answers untouched.
 *
 * Everything here is IDs, numbers and booleans on lazy fields. Components read
 * a task's displayed fields from its `MissionDeckIssueModel` (`task.row`).
 */
import { type ProposalPlacement, proposalShape } from '@podium/client-core/values'
import { companion, lazy } from '@podium/mobx-helpers'
import {
  counterChildren,
  isFinished,
  leafTasks,
  TASK_WORD_FILTERS,
  type TaskWord,
  type TaskWordTally,
  tallyTaskWords,
  taskHidden,
  type WordTree,
  wordWantsAttention,
} from '@podium/model/browser'
import { action, compareShallow, compareStructural, observable } from 'mobx'
import type { MissionScreen } from './mission-screen'
import {
  type MissionDeckIssueModel,
  type MissionDeckModel,
  requireLoaded,
  settled,
  settledAll,
} from './mission-view'
import type { IssueModel } from './models'

/** The Full view's filter tabs (v6 mockup). Done is a separate toggle. */
export const FULL_DECK_FILTERS = ['all', 'needs-you', 'active', 'up-next'] as const
export type FullDeckFilter = (typeof FULL_DECK_FILTERS)[number]

/** What a row is drawn as. `decision` is a task only the user closes (D2). */
export type FullDeckKind = 'phase' | 'decision' | 'task'

/** Where a session sits (handoff note 1, D3). Derived from each issue's one
 * coordinator marker: never stored, never a role enum. */
export type FullDeckSeat = 'coordinator' | 'phase-lead' | 'worker' | 'helper'

export type FullDeckCounts = Readonly<Record<FullDeckFilter | 'done', number>>

const NO_IDS: readonly string[] = Object.freeze([])

/**
 * One issue of the mission as the Full view draws it. A companion of the
 * shared issue model, so every screen drawing this opening shares it. Its
 * displayed fields (title, ref, crew, word) live on `row`.
 */
export class FullDeckTask {
  constructor(
    readonly entity: IssueModel,
    readonly deck: FullDeck,
  ) {}
  get id(): string {
    return this.entity.id
  }
  /** The existing full deck's row: title, ref, status, crew, the task word. */
  get row(): MissionDeckIssueModel {
    return this.deck.source.model(this.id)
  }
  get isRoot(): boolean {
    return this.id === this.deck.rootId
  }

  // What it is
  @lazy get kind(): FullDeckKind {
    const type = this.entity.type
    return type === 'phase' ? 'phase' : type === 'decision' ? 'decision' : 'task'
  }
  /** The task word (D6), rolled up from its crew and its sub-issues. */
  @lazy get word(): TaskWord {
    return this.row.word
  }
  @lazy get attention(): boolean {
    return wordWantsAttention(this.word)
  }
  /** The issue itself is closed. For a phase this is NOT its completion. */
  @lazy get closed(): boolean {
    return isFinished(this.lifecycle)
  }
  /** Cancelled, duplicate or superseded: counted as done, never drawn (D6). */
  @lazy get abandoned(): boolean {
    return taskHidden(this.lifecycle)
  }
  @lazy get proposed(): boolean {
    return this.entity.stage === 'proposed'
  }
  private get lifecycle() {
    return { stage: this.entity.stage, closedReason: this.entity.closedReason }
  }

  // Where it is
  /** Its parent in the drawn tree: the formal parent, or a graft's placement. */
  @lazy get parentId(): string | null {
    if (this.isRoot) return null
    return requireLoaded(this.deck.source.topology).parent.get(this.id) ?? null
  }
  /** Direct sub-issues in the accepted tree: proposals and their subtrees
   * leave, sort_key order holds, and tasks come before phases (spec 06). */
  @lazy({ equals: compareShallow }) get childIds(): readonly string[] {
    const shape = requireLoaded(this.deck.source.topology)
    const tasks: string[] = [],
      phases: string[] = []
    for (const id of shape.children.get(this.id) ?? NO_IDS) {
      if (shape.parent.get(id) !== this.id || id === this.deck.rootId) continue
      const child = this.deck.task(id)
      if (child.proposed) continue
      ;(child.kind === 'phase' ? phases : tasks).push(id)
    }
    return tasks.length === 0 ? phases : phases.length === 0 ? tasks : [...tasks, ...phases]
  }
  /** Proposed direct sub-issues: they leave the tree for the PROPOSED tail. */
  @lazy({ equals: compareShallow }) get proposalIds(): readonly string[] {
    const shape = requireLoaded(this.deck.source.topology)
    return (shape.children.get(this.id) ?? NO_IDS).filter(
      (id) =>
        shape.parent.get(id) === this.id && id !== this.deck.rootId && this.deck.task(id).proposed,
    )
  }
  /** Levels below the mission root, phases included (0 = a root child). */
  @lazy get depth(): number {
    const parent = this.parentId
    return parent === null || parent === this.deck.rootId ? 0 : this.deck.task(parent).depth + 1
  }
  /** The nearest phase above this issue, at any depth (D1, D2). */
  @lazy get phaseId(): string | null {
    const parent = this.parentId
    if (parent === null || parent === this.deck.rootId) return null
    const above = this.deck.task(parent)
    return above.kind === 'phase' ? parent : above.phaseId
  }

  // Counting
  /** The row counter (1/3 on a parent, 7/9 on a phase): direct sub-issues,
   * looking through phases (D1). Abandoned ones count as done (D6). */
  @lazy({ equals: compareStructural }) get counter(): {
    readonly done: number
    readonly total: number
  } {
    const { done, total } = tallyTaskWords(
      counterChildren(this.id, this.deck.tree),
      (id) => this.deck.task(id).word,
    )
    return { done, total }
  }
  /** A phase's work is all done. Rendering never closes the phase issue:
   * this is read from its tasks, and `closed` stays the issue's own stage. */
  @lazy get workComplete(): boolean {
    const { done, total } = this.counter
    return total > 0 && done === total
  }

  // Seats
  /** The sessions drawn on this issue (the existing roster order: the
   * coordinator marker first, then by start). */
  get sessionIds(): readonly string[] {
    return this.row.crewIds
  }
  /** A seat exists only when the issue explicitly names a roster member.
   * Roster ordering and the original conversation never assign a seat. */
  @lazy get leadSessionId(): string | null {
    const crew = this.sessionIds,
      marker = this.entity.coordinatorSessionId
    return marker && crew.includes(marker) ? marker : null
  }
  /** The lead was named by the issue's own coordinator marker. */
  @lazy get leadExplicit(): boolean {
    const marker = this.entity.coordinatorSessionId
    return Boolean(marker) && marker === this.leadSessionId
  }
  /** Sessions other than the lead: helpers (D3). */
  @lazy({ equals: compareShallow }) get helperIds(): readonly string[] {
    const lead = this.leadSessionId
    return this.sessionIds.filter((id) => id !== lead)
  }
  seat(sessionId: string): FullDeckSeat {
    if (sessionId !== this.leadSessionId) return 'helper'
    return this.isRoot ? 'coordinator' : this.kind === 'phase' ? 'phase-lead' : 'worker'
  }
  /** The agent profile the issue gives every session started on it (D2/D3).
   * The role text is that profile's name. */
  @lazy get profileId(): string | null {
    return (this.entity.storedField('agentProfileId') as string | undefined) ?? null
  }
  /** The profile a session actually runs, else the issue's default. */
  sessionProfileId(sessionId: string): string | null {
    return this.deck.screen.pool.sessionObject(sessionId).agentProfileId || this.profileId
  }

  // Dependencies: the stored edge types, nothing new (D7)
  @lazy({ equals: compareShallow }) get blockedByIds(): readonly string[] {
    return (this.entity.deps ?? [])
      .filter((dep) => dep.type === 'blocked-by')
      .map((dep) => dep.id as string)
  }
  /** Dependencies not yet closed. A closed one is met whatever its close
   * reason; a dependency that is gone no longer blocks. */
  @lazy({ equals: compareShallow }) get unmetBlockedByIds(): readonly string[] {
    const reader = this.deck.screen.reader
    const targets = requireLoaded(settledAll(this.blockedByIds, (id) => reader.catalogIssue(id)))
    return this.blockedByIds.filter((_, index) => {
      const target = targets[index]
      return target !== undefined && !isFinished(target)
    })
  }
  /** The narrow lock keeps every reference in its tooltip, even when the
   * legacy pill's short/full strings summarize several blockers as a count. */
  @lazy get dependencyReferences(): string {
    const reader = this.deck.screen.reader
    return this.unmetBlockedByIds.map(id => {
      const target = requireLoaded(reader.catalogIssue(id))
      return target?.displayRef ?? id
    }).join(', ')
  }
  /** Unmet dependencies outside this mission: counted, never drawn as edges. */
  @lazy({ equals: compareShallow }) get externalUnmetIds(): readonly string[] {
    const members = this.deck.members
    return this.unmetBlockedByIds.filter((id) => !members.has(id))
  }
  /** Issues that wait on this one. */
  @lazy({ equals: compareShallow }) get dependentIds(): readonly string[] {
    return this.dependents('blocked-by')
  }
  /** `related` edges in either direction. */
  @lazy({ equals: compareShallow }) get relatedIds(): readonly string[] {
    const ids = new Set(
      (this.entity.deps ?? [])
        .filter((dep) => dep.type === 'related')
        .map((dep) => dep.id as string),
    )
    for (const id of this.dependents('related')) ids.add(id)
    return [...ids].sort()
  }
  private dependents(type: string): string[] {
    return this.entity.dependents.filter((dep) => dep.type === type).map((dep) => dep.id)
  }

  // Proposals
  /** Who filed it: the filing session's reference, when it can be named. */
  @lazy get proposalAuthor(): string | null {
    return this.deck.screen.proposalAuthor(this.row)
  }
  /** Whether starting it keeps it in this mission or sends it to its own. */
  @lazy get placement(): ProposalPlacement | null {
    const issue = requireLoaded(this.deck.screen.reader.catalogIssue(this.id))
    return issue ? (proposalShape(issue)?.placement ?? null) : null
  }

  // Drawing under the current filter, Show done and search
  /** This row passes the filter, Show done and the search on its own. */
  @lazy get matches(): boolean {
    const { filter, showDone, screen } = this.deck
    const needle = screen.needle
    if (this.kind === 'phase')
      return filter === 'all' && !needle && (showDone || !this.workComplete)
    if (this.abandoned) return false
    if (
      filter === 'all' ? !showDone && this.word === 'done' : !TASK_WORD_FILTERS[filter](this.word)
    )
      return false
    return !needle || screen.matches(this.row, needle)
  }
  /** Drawn: it matches, or a descendant does and it gives that one context. */
  @lazy get shown(): boolean {
    return this.matches || this.childIds.some((id) => this.deck.task(id).shown)
  }
  /** Something folds away under it: sub-issues or sessions. */
  @lazy get foldable(): boolean {
    return this.childIds.length > 0 || (this.kind !== 'phase' && this.sessionIds.length > 0)
  }
  /** Open: an explicit choice wins; else phases, tasks with sub-issues and
   * tasks in Error or Needs you start open (spec 03). */
  @lazy get open(): boolean {
    const explicit = this.deck.screen.folds.get(this.id)
    if (explicit !== undefined) return explicit === 'open'
    return this.kind === 'phase' || this.childIds.length > 0 || this.attention
  }
}

/**
 * The Full view of one mission opening. Its filter and Show done are this
 * opening's UI state; folds stay the screen's stored device preference.
 * Selection is not held here: the selected session is the focused pane's,
 * and a seat compares itself with that one ID.
 */
export class FullDeck {
  @observable accessor filter: FullDeckFilter = 'all'
  @observable accessor showDone = false
  private readonly card = companion((issue: IssueModel) => new FullDeckTask(issue, this))

  constructor(readonly screen: MissionScreen) {}
  get rootId(): string {
    return this.screen.rootId
  }
  /** The existing deck in its full mode, whatever view the screen shows. */
  get source(): MissionDeckModel {
    return this.screen.reader.deck(this.rootId, 'full')
  }
  task(id: string): FullDeckTask {
    return this.card(this.screen.reader.facts(id))
  }
  get root(): FullDeckTask {
    return this.task(this.rootId)
  }

  // UI state
  /** Choosing a filter turns Show done off (handoff note 5). */
  @action setFilter(filter: FullDeckFilter): void {
    this.filter = filter
    this.showDone = false
  }
  /** Show done returns to All: done work shows in its place in the tree. */
  @action setShowDone(show: boolean): void {
    this.showDone = show
    if (show) this.filter = 'all'
  }
  @action toggleShowDone(): void {
    this.setShowDone(!this.showDone)
  }
  /** A fold the operator performed is stored explicitly (the screen's preference). */
  @action toggleFold(id: string): void {
    this.screen.fold(id, this.task(id).open)
  }
  /** Both directions write explicit values for every foldable row, in one write. */
  @action foldAll(): void {
    const close = !this.allFolded,
      next = new Map(this.screen.folds)
    for (const id of this.foldableIds) next.set(id, close ? 'closed' : 'open')
    this.screen.setFolds(next)
  }

  // The tree the shared counts walk: the accepted tree, as drawn.
  get tree(): Pick<WordTree<string>, 'task' | 'children'> {
    return this.wordTree
  }
  private readonly wordTree: Pick<WordTree<string>, 'task' | 'children'> = {
    task: (id) => this.task(id).entity,
    children: (id) => this.task(id).childIds,
  }
  @lazy({ equals: compareStructural }) get members(): ReadonlySet<string> {
    return requireLoaded(this.source.members)
  }

  // Totals: leaves of the accepted tree (D1), never folds, search or Show done
  @lazy({ equals: compareShallow }) get leafIds(): readonly string[] {
    return leafTasks(this.rootId, this.tree)
  }
  /** Leaf words: the gauge and the done line. */
  @lazy({ equals: compareStructural }) get tally(): TaskWordTally {
    return tallyTaskWords(this.leafIds, (id) => this.task(id).word)
  }
  /** The tab counts and the Done toggle's count. */
  @lazy({ equals: compareStructural }) get counts(): FullDeckCounts {
    const t = this.tally
    return {
      all: t.total,
      'needs-you': t.error + t['needs-you'],
      active: t.error + t['needs-you'] + t.working + t.idle,
      'up-next': t.blocked + t['not-started'],
      done: t.done,
    }
  }
  /** Needs you reads red when anything it lists has errored, else amber. The
   * tab lists a parent by its own word, whatever its leaves read, so the
   * tone reads every row the filter would match, not only the leaf tally
   * (which still covers a mission that is its only issue). Search never
   * moves it. */
  @lazy get needsYouTone(): 'error' | 'needs-you' | null {
    const t = this.tally
    if (t.error > 0) return 'error'
    let asks = t['needs-you'] > 0
    const walk = (id: string): boolean => {
      for (const child of this.task(id).childIds) {
        const task = this.task(child)
        if (task.kind !== 'phase' && !task.abandoned) {
          if (task.word === 'error') return true
          asks ||= TASK_WORD_FILTERS['needs-you'](task.word)
        }
        if (walk(child)) return true
      }
      return false
    }
    return walk(this.rootId) ? 'error' : asks ? 'needs-you' : null
  }
  /** Every phase in the accepted tree, at any depth, in tree order. */
  @lazy({ equals: compareShallow }) get phaseIds(): readonly string[] {
    const out: string[] = []
    const walk = (id: string) => {
      for (const child of this.task(id).childIds) {
        if (this.task(child).kind === 'phase') out.push(child)
        walk(child)
      }
    }
    walk(this.rootId)
    return out
  }
  /** "N phases complete · M tasks done", while Show done is off. */
  @lazy({ equals: compareStructural }) get doneLine(): {
    readonly phases: number
    readonly tasks: number
  } | null {
    if (this.showDone) return null
    const phases = this.phaseIds.filter((id) => this.task(id).workComplete).length,
      tasks = this.tally.done
    return phases || tasks ? { phases, tasks } : null
  }

  // The drawn rows
  /** Rows under the root, in drawing order: shown, under open parents. */
  @lazy({ equals: compareShallow }) get rowIds(): readonly string[] {
    const out: string[] = []
    const walk = (id: string) => {
      for (const child of this.task(id).childIds) {
        const task = this.task(child)
        if (!task.shown) continue
        out.push(child)
        if (task.open) walk(child)
      }
    }
    walk(this.rootId)
    return out
  }
  /** The PROPOSED tail: proposals anywhere in the accepted tree, each
   * after its parent's subtree in drawing order, narrowed by the search.
   * Filters and Show done never hide them. */
  @lazy({ equals: compareShallow }) get proposalIds(): readonly string[] {
    const out: string[] = [],
      needle = this.screen.needle
    const walk = (id: string) => {
      for (const child of this.task(id).childIds) walk(child)
      for (const proposal of this.task(id).proposalIds)
        if (!needle || this.screen.matches(this.task(proposal).row, needle)) out.push(proposal)
    }
    walk(this.rootId)
    return out
  }
  /** Rows that fold, open or not, whatever the filter. */
  @lazy({ equals: compareShallow }) get foldableIds(): readonly string[] {
    const out: string[] = []
    const walk = (id: string) => {
      for (const child of this.task(id).childIds) {
        if (this.task(child).foldable) out.push(child)
        walk(child)
      }
    }
    walk(this.rootId)
    return out
  }
  @lazy get allFolded(): boolean {
    const ids = this.foldableIds
    return ids.length > 0 && ids.every((id) => !this.task(id).open)
  }

  /** The coordinator card's session, and the helpers shown inside it. */
  @lazy get coordinatorSessionId(): string | null {
    return this.root.leadSessionId
  }

  /** Everything the Full view draws has settled. */
  @lazy get ready(): boolean {
    if (!this.screen.rowsReady) return false
    return (
      settled(() => {
        void this.rowIds
        void this.counts
        void this.proposalIds
        return true
      }) === true
    )
  }
}
