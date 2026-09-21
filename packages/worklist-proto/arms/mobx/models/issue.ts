/**
 * POD-4447 — the issue node in the tracked object graph (methodology §5.3).
 *
 * One model per issue id, holding the borrowed row behind `observable.ref`.
 * EVERY derived value is a computed getter reading raw state as late as
 * possible: cheap structural gates first (excluded? visible?), volatile
 * fields and the coarse clock only on paths that need them. MobX subscribes
 * a computed only to what its body actually read, so an unrelated heartbeat
 * invalidates nothing and a deep change invalidates exactly the ancestor
 * chain (structural equality stops propagation where values settle).
 *
 * Relations (`parent` / `children` / `sessions` / `origin`) are plain getters
 * through the store's buckets — reads flow to the calling computed, so no
 * intermediary identity ever propagates spuriously.
 */

import { computed, computedStruct, makeObservable, observableRef } from 'mobx'
import type { SliceIssue, SlicePhase, SliceRow, SliceSession } from '../../../shared/src/slice-types'
import {
  SIDEBAR_FINISHED_GRACE_MS,
  bandOf,
  closeOutcome,
  derivedUnread,
  displayRefOf,
  displayTitleOf,
  flatSessionless,
  groupKeyOf,
  isClosedTopLevel,
  isOfferOnlyAttention,
  isSessionWorking,
  issueAwaitingMerge,
  issueFinished,
  issueFinishedAt,
  issuePendingDecision,
  motionPhase,
  rescueEligible,
  sessionFinishedAt,
  sessionLive,
  sessionRetains,
  structurallyExcluded,
  type RankInput,
} from '../rules'
import type { MobXStore } from '../store'

export interface OwnSummary {
  activityAt: number
  displayRef: string
  title: string
  band: 0 | 1 | 2
  repoKey: string
}

export interface Aggregate {
  phase: SlicePhase
  working: boolean
  asking: boolean
  progressDone: number
  progressTotal: number
}

export interface OriginTick {
  id: string
  seq: number
  title: string
  ref: string
}

export class IssueModel {
  /** Borrowed immutable stream object; replaced, never mutated. */
  value: SliceIssue
  /** Owning store (buckets, locals, stats). Never reassigned. */
  readonly store: MobXStore
  /** Last committed row JSON; rowsDerived counts committed rows only. */
  private lastRowJson: string | null = null
  /** Last committed tick JSON; ticks ride the commit without entering the snapshot. */
  private lastTickJson: string | null = null

  constructor(store: MobXStore, value: SliceIssue) {
    this.store = store
    this.value = value
    makeObservable<
      IssueModel,
      | 'lastRowJson'
      | 'lastTickJson'
      | 'retainedMembers'
      | 'retainedLive'
      | 'unreadSeats'
      | 'hostedBy'
      | 'keptByDescendant'
      | 'readVisible'
    >(this, {
      value: observableRef,
      store: false,
      lastRowJson: false,
      lastTickJson: false,
      excluded: computed,
      flat: computed,
      visible: computed,
      summary: computedStruct,
      aggregate: computedStruct,
      tick: computedStruct,
      rankKey: computedStruct,
      closed: computed,
      isSelected: computed,
      row: computedStruct,
      parent: false,
      children: false,
      sessions: false,
      origin: false,
      retainedMembers: false,
      retainedLive: false,
      unreadSeats: false,
      hostedBy: false,
      keptByDescendant: false,
      readVisible: false,
    })
  }

  // ------------------------------------------------------------ relations

  /** Formal parent id (spec §2 R1). */
  get parent(): string | null {
    return this.store.parentOf.get(this.value.id) ?? null
  }

  /** Formal child ids (spec §2 R1). */
  get children(): readonly string[] {
    return this.store.childrenByParent.get(this.value.id) ?? EMPTY_IDS
  }

  /** Owned sessions, explicit-first (spec §2 R2 then R3). */
  get sessions(): SliceSession[] {
    return this.store.membersOf(this.value.id)
  }

  /** The `discovered-from` origin id (spec §2 R4). */
  get origin(): string | null {
    return this.store.originOf.get(this.value.id) ?? null
  }

  // ------------------------------------------------------------- derivation

  /** Structural gate every computed checks first (spec §3 R-VIS). */
  get excluded(): boolean {
    return structurallyExcluded(this.value)
  }

  /**
   * The flat visibility predicate (spec §3 R-VIS): retained sessions, else
   * the sessionless keep. The coarse clock is read only on paths that need
   * it (finished members, decay-gated sessionless rows).
   */
  get flat(): boolean {
    this.store.stats.rollupsDerived += 1
    const t0 = performance.now()
    try {
      const issue = this.value
      if (structurallyExcluded(issue)) return false
      if (this.retainedMembers().length > 0) return true
      return flatSessionless(issue, derivedUnread(issue, this.unreadSeats()), () => this.store.locals.coarseNow)
    } finally {
      this.store.addRollupMs(performance.now() - t0)
    }
  }

  /**
   * Full visibility: flat rows, agent rows hosted by a visible ancestor,
   * rescued human ancestors kept by visible descendants (spec §3 R-VIS).
   * Structural plumbing (like the hand arm's reconcile): not counted.
   *
   * The guard gives least-fixpoint semantics: a `visible` read that would
   * re-enter an in-progress evaluation sees `false` instead of throwing
   * MobX's cycle error. Keeper edges point down, hosted edges point up; on
   * a forest both agree with the iterative fixpoint (see NOTES.md).
   */
  get visible(): boolean {
    const id = this.value.id
    if (this.store.visibleGuard.has(id)) return false
    this.store.visibleGuard.add(id)
    try {
      if (this.excluded) return false
      if (this.value.audience === 'agent') {
        return this.flat && this.hostedBy(new Set([id]))
      }
      if (this.flat) return true
      if (!rescueEligible(this.value)) return false
      return this.keptByDescendant(new Set([id]))
    } finally {
      this.store.visibleGuard.delete(id)
    }
  }

  /**
   * Own-row summary (spec §3 R-SUM). Reads the clock only for defer carriers;
   * the prefix join subscribes to exactly this repo's prefix key.
   */
  get summary(): OwnSummary | null {
    this.store.stats.rollupsDerived += 1
    const t0 = performance.now()
    try {
      const issue = this.value
      if (structurallyExcluded(issue)) return null
      const retained = this.retainedMembers()
      let peak = 0
      for (const member of retained) {
        const active = Date.parse(member.lastActiveAt)
        if (Number.isFinite(active) && active > peak) peak = active
      }
      const members = this.store.membersOf(issue.id)
      const band =
        issue.deferUntil === null || issue.deferUntil === undefined
          ? bandOf(issue, 0)
          : bandOf(issue, this.store.locals.coarseNow)
      return {
        activityAt: peak !== 0 ? peak : (Date.parse(issue.updatedAt) || 0),
        displayRef: displayRefOf(issue, this.store.prefixForRepo(issue.repoId)),
        title: displayTitleOf(issue, members[0]),
        band,
        repoKey: groupKeyOf(issue),
      }
    } finally {
      this.store.addRollupMs(performance.now() - t0)
    }
  }

  /**
   * Subtree rollup over the visible formal subtree (spec §3 R-ROLL): phase,
   * working, asking, mission progress. Walks `children` recursively through
   * child `aggregate` computeds — MobX tracks the chain, so a change deep in
   * the tree re-runs exactly the ancestors until values settle (structural
   * equality stops the propagation).
   */
  get aggregate(): Aggregate | null {
    this.store.stats.rollupsDerived += 1
    const t0 = performance.now()
    try {
      const issue = this.value
      if (!this.visible) return null
    const members = this.store.visibleSubtree(issue.id)
    const ownByMember = new Map<string, SliceSession[]>()
    const sessions: SliceSession[] = []
    const deciding = new Set<string>()
    let pending = 0
    for (const id of members) {
      const member = this.store.issues.get(id)
      if (!member) continue
      const own = member.retainedLive()
      ownByMember.set(id, own)
      sessions.push(...own)
      const decision = issuePendingDecision(member.value)
      if (decision === null) continue
      if (!issueFinished(member.value) && own.some((s) => isSessionWorking(s))) continue
      if (decision === 'review' && this.store.continuationOf(member.value)) continue
      pending += 1
      for (const s of own) deciding.add(s.sessionId)
    }
    let phase: SlicePhase
    if (pending > 0) {
      phase = 'waiting'
    } else if (sessions.length === 0 && issueFinished(issue)) {
      phase = 'done'
    } else {
      const kinds = sessions.map((s) => motionPhase(s, issue))
      if (kinds.includes('waiting')) phase = 'waiting'
      else if (kinds.includes('working')) phase = 'working'
      else if (kinds.length > 0 && kinds.every((k) => k === 'done')) phase = 'done'
      else phase = 'queued'
      if (phase === 'done' && !issueFinished(issue)) phase = 'queued'
    }
    const waiting = sessions.filter((s) => motionPhase(s, issue) === 'waiting')
    const extra = waiting.filter(
      (s) => !(isOfferOnlyAttention(s) && deciding.has(s.sessionId)),
    )
    const progress = this.store.progressOf(issue.id)
      return {
        phase,
        working: sessions.some((s) => isSessionWorking(s)),
        asking: extra.length + pending > 0,
        progressDone: progress.done,
        progressTotal: progress.total,
      }
    } finally {
      this.store.addRollupMs(performance.now() - t0)
    }
  }

  /** The origin tick beside the row (spec §3 R-ORIGIN). Rides the commit. */
  get tick(): OriginTick | null {
    const t0 = performance.now()
    try {
      const originId = this.store.originOf.get(this.value.id)
      const origin = originId === undefined ? undefined : this.store.issues.get(originId)
      let next: OriginTick | null = null
      if (origin) {
        const row = origin.value
        const prefix = this.store.prefixForRepo(row.repoId)
        next = {
          id: row.id,
          seq: row.seq,
          title: row.title,
          ref: prefix ? `${prefix}-${row.seq}` : `#${row.seq}`,
        }
      }
      const json = next === null ? null : JSON.stringify(next)
      if (json !== this.lastTickJson) {
        this.lastTickJson = json
        this.store.stats.rowsDerived += 1
      }
      return next
    } finally {
      this.store.addRowMs(performance.now() - t0)
    }
  }

  /** Rank inputs for R-ORDER; the clock only for defer carriers. */
  get rankKey(): RankInput {
    const issue = this.value
    return {
      band:
        issue.deferUntil === null || issue.deferUntil === undefined
          ? bandOf(issue, 0)
          : bandOf(issue, this.store.locals.coarseNow),
      sortKey: issue.sortKey ?? null,
      createdAt: issue.createdAt,
      seq: issue.seq,
      id: issue.id,
    }
  }

  /**
   * The closed-fold predicate, not the lane (spec §3 R-GROUP): pinned settled
   * rows read closed while rendering in PINNED. Selection is read only for
   * settled, untucked, unabandoned rows — everything else decides without it.
   */
  get closed(): boolean {
    const issue = this.value
    const aggregate = this.aggregate
    const waiting = aggregate !== null && aggregate.asking
    if (!isClosedTopLevel(issue) || issue.needsHuman === true || issueAwaitingMerge(issue) || waiting) {
      return false
    }
    if (closeOutcome(issue) === 'cancelled') return true
    if (issue.tuckedAt !== null && issue.tuckedAt !== undefined) return true
    const locals = this.store.locals
    if (issue.id !== locals.selectedIssueId || locals.selectedIssueWasFolded) {
      return this.store.locals.coarseNow - issueFinishedAt(issue) > SIDEBAR_FINISHED_GRACE_MS
    }
    return false
  }

  /** Selection renders from locals, never from the row object (spec §3 R-SEL). */
  get isSelected(): boolean {
    return this.store.locals.selectedIssueId === this.value.id
  }

  /**
   * The committed slice row (spec §7). Identity-stable while inputs settle:
   * structural equality keeps the old object, and rowsDerived counts only
   * committed (new + changed + removed) rows.
   */
  get row(): SliceRow | null {
    if (!this.visible) {
      if (this.lastRowJson !== null) {
        this.lastRowJson = null
        this.store.stats.rowsDerived += 1
      }
      return null
    }
    const summary = this.summary
    const aggregate = this.aggregate
    if (summary === null || aggregate === null) {
      if (this.lastRowJson !== null) {
        this.lastRowJson = null
        this.store.stats.rowsDerived += 1
      }
      return null
    }
    // Row-assembly tail only: inputs above price themselves as rollup, so
    // the split stays non-overlapping (M3 stats split, methodology §6.4).
    const t0 = performance.now()
    try {
      const next: SliceRow = {
        id: this.value.id,
        displayRef: summary.displayRef,
        title: summary.title,
        phase: aggregate.phase,
        progressDone: aggregate.progressDone,
        progressTotal: aggregate.progressTotal,
        working: aggregate.working,
        asking: aggregate.asking,
        band: summary.band,
        repoKey: summary.repoKey,
        closed: this.closed,
      }
      const json = JSON.stringify(next)
      if (json !== this.lastRowJson) {
        this.lastRowJson = json
        this.store.stats.rowsDerived += 1
      }
      return next
    } finally {
      this.store.addRowMs(performance.now() - t0)
    }
  }

  // ------------------------------------------------------- internal helpers

  /** Retained member rows (spec §3 R-VIS splitMembers); clock read is lazy. */
  retainedMembers(): SliceSession[] {
    const issue = this.value
    const out: SliceSession[] = []
    for (const member of this.store.membersOf(issue.id)) {
      if (member.archived) continue
      if (sessionFinishedAt(member, issue) === undefined) {
        out.push(member)
        continue
      }
      if (sessionRetains(member, this.store.locals.coarseNow, issue)) out.push(member)
    }
    return out
  }

  /** Live member rows of this issue (spec §3 R-VIS). */
  retainedLive(): SliceSession[] {
    const issue = this.value
    const out: SliceSession[] = []
    for (const member of this.store.membersOf(issue.id)) {
      if (member.archived) continue
      if (member.status === 'exited') continue
      if (sessionFinishedAt(member, issue) === undefined) {
        out.push(member)
        continue
      }
      if (sessionLive(member, this.store.locals.coarseNow, issue)) out.push(member)
    }
    return out
  }

  /** Explicit non-shell seats, archived included, for the unread rollup. */
  unreadSeats(): SliceSession[] {
    return this.store.unreadMembersOf(this.value.id)
  }

  /**
   * Nearest visible formal ancestor (spec §3 R-VIS `hosted`). Reads ancestor
   * `visible` computeds; the evaluation-stack guard reads in-progress rows as
   * invisible (the least-fixpoint semantics — see NOTES.md).
   */
  hostedBy(seen: Set<string>): boolean {
    let parentId = this.store.parentOf.get(this.value.id) ?? null
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId)
      if (this.readVisible(parentId)) return true
      parentId = this.store.parentOf.get(parentId) ?? null
    }
    return false
  }

  /**
   * Whether a visible descendant keeps this row (spec §3 R-VIS rescue).
   * Transitive through invisible intermediates; chain breaks (archived /
   * deleted / proposed / shipping) do not propagate.
   */
  keptByDescendant(seen: Set<string>): boolean {
    const stack = [...this.store.childrenByParent.get(this.value.id) ?? []]
    while (stack.length > 0) {
      const childId = stack.pop() as string
      if (seen.has(childId)) continue
      seen.add(childId)
      if (this.readVisible(childId)) return true
      const child = this.store.issues.get(childId)
      if (child && !structurallyExcluded(child.value)) {
        stack.push(...(this.store.childrenByParent.get(childId) ?? []))
      }
    }
    return false
  }

  /** Guarded `visible` read: in-progress rows read as invisible, never re-entered. */
  readVisible(id: string): boolean {
    if (this.store.visibleGuard.has(id)) return false
    const model = this.store.issues.get(id)
    if (!model) return false
    return model.visible
  }
}

const EMPTY_IDS: readonly string[] = []
