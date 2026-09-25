/**
 * POD-4555 (L4a) — the random-change generator that feeds the correctness
 * gate (L4b, POD-4556).
 *
 * `gen(seed, steps, weights)` returns a `Change[]`: plain data, deterministic
 * in its arguments (a seeded PRNG, no `Date.now`, no `Math.random`). A change
 * is an INTENT ("stage of i42 becomes done", "the server answers edit e7");
 * `run.ts` applies it through the real scenario engine — kernel upserts
 * through the replica facade for server rows, the runtime's own actions for
 * optimistic edits, the production kernel outbox for their receipts — so every
 * step is a real change with real events, never a synthesised one.
 *
 * VOCABULARY. Row changes (server truth arriving through the kernel) and the
 * write path of the L1c contract (`docs/plans/pod-4545-round-three-write-
 * contract.md` §5: edit, receipt, rejection, supersede, echo before or after
 * the receipt, remote update on a pending field, stale repeat after the
 * receipt, a receipt with no echo, duplicate receipt, reload mid-sequence).
 * See {@link CHANGE_KINDS}.
 *
 * SHAPES. The five small shapes that turned round two's hand arm red (audit
 * `docs/decisions/4441-round-two-audit.md` §3.3) are named generators, drawn
 * like a kind and tagged on the changes they emit ({@link SHAPES}).
 *
 * THE MODEL. `gen` keeps a light model of the corpus (which issues and
 * sessions exist, parents, stages, sort keys, which rows are evicted, which
 * edits are outstanding and whether the client is online) only to pick
 * targets that make sense. It does not predict the kernel exactly: the runner
 * re-resolves every target against the engine and SKIPS a change whose target
 * is gone (recorded with a reason), which also keeps any subsequence the
 * shrinker tries applicable.
 */

import { EDITABLE_STAGES, type EditableStage } from '../write-contract'
import { isSortKey, sortKeyBetween } from '@podium/model'
import { buildCorpus, type FixtureCorpus } from '../../../harness/src/fixture/index'
import { FIXTURE_SEED } from '../scenarios'

// ------------------------------------------------------------------ vocabulary

/** Server-side row changes. Each is one kernel upsert/evict/remove (or a
 *  discovery refresh, for worktrees). */
export const ROW_KINDS = [
  'newIssue',
  'newSession',
  'heartbeat',
  'newWorktree',
  'remove',
  'reparent',
  'phaseChange',
  'offerChange',
  'stageChange',
  'archive',
  'rankMove',
  'evict',
  'reAdd',
] as const

/** The optimistic write path (L1c §5) and the client's own lifecycle. */
export const WRITE_KINDS = [
  'edit',
  'accept',
  'reject',
  'echo',
  'remoteOnPending',
  'staleRepeat',
  'supersede',
  'offline',
  'online',
  'refresh',
] as const

export const CHANGE_KINDS = [...ROW_KINDS, 'clockTick', 'batch', ...WRITE_KINDS] as const

export type RowKind = (typeof ROW_KINDS)[number]
export type ChangeKind = (typeof CHANGE_KINDS)[number]

/** Audit §3.3: the shapes a reviewer's probe used to turn the hand arm's own
 *  rebuild oracle red. */
export const SHAPES = [
  'clockDecay',
  'offerRemovedOnFinishedChild',
  'rankMoveWithinGroup',
  'evictThenReAdd',
  'twoRankMovesInOneBatch',
] as const
export type ShapeName = (typeof SHAPES)[number]

export type SessionPhase = 'working' | 'idle'

interface Tagged {
  /** Set on every change a named shape emitted. */
  shape?: ShapeName
}

export type RowChange = Tagged &
  (
    | { kind: 'newIssue'; id: string; parentId: string | null; title: string }
    | { kind: 'newSession'; sessionId: string; issueId: string; phase: SessionPhase }
    | { kind: 'heartbeat'; sessionId: string }
    | { kind: 'newWorktree'; repoId: string; path: string }
    | { kind: 'remove'; entity: 'issue' | 'session'; id: string }
    | { kind: 'reparent'; id: string; parentId: string | null }
    | { kind: 'phaseChange'; sessionId: string; phase: SessionPhase }
    | { kind: 'offerChange'; sessionId: string; offer: boolean }
    /** `done` closes the issue (closedAt, closedReason); any other reopens it. */
    | { kind: 'stageChange'; id: string; stage: string }
    | { kind: 'archive'; id: string; archived: boolean }
    | { kind: 'rankMove'; id: string; sortKey: string | null }
    | { kind: 'evict'; id: string }
    /** The evicted row comes back, same value, `readmitted`. */
    | { kind: 'reAdd'; id: string }
  )

/** What an edit sets. `readAt: true` is a mark-read press: the runtime stamps it. */
export type EditIntent = { title: string } | { stage: EditableStage } | { readAt: true }

/**
 * One step. Write-path changes name the edit they act on by its `handle`
 * (minted by the `edit`/`supersede` that created it), so a shrunk sequence
 * still says which edit it meant; the runner skips one whose edit is absent
 * or not in a state the change applies to.
 */
export type Change =
  | RowChange
  | (Tagged & { kind: 'clockTick'; ms: number })
  /** Several row changes in ONE `replica.batch()`: one kernel batch. */
  | (Tagged & { kind: 'batch'; changes: RowChange[] })
  /** An optimistic edit through the runtime action (`updateIssue` /
   *  `markIssueRead`); the kernel outbox carries it. */
  | { kind: 'edit'; handle: string; id: string; patch: EditIntent }
  /** The server answers the held call: applied (the receipt). */
  | { kind: 'accept'; handle: string }
  /** The server refuses the held call (definitive: dead-letter, rewind). */
  | { kind: 'reject'; handle: string }
  /** The server row carrying the edit's effect (the echo); before or after
   *  the receipt. A stamp field echoes the server's own clock. */
  | { kind: 'echo'; handle: string }
  /** Another writer's value lands on the edit's pending field (S3). */
  | { kind: 'remoteOnPending'; handle: string; value: string }
  /** After the receipt, the server re-sends the value it held at the receipt
   *  (a full-row upsert riding another field): stale, not an overtake (W8). */
  | { kind: 'staleRepeat'; handle: string }
  /** Two mark-read presses on one row while offline: the queue collapses the
   *  first into the second (W9). */
  | { kind: 'supersede'; id: string; handles: [string, string] }
  | { kind: 'offline' }
  | { kind: 'online' }
  /** A tab reload: new runtime over the same durable cache and outbox (S5). */
  | { kind: 'refresh' }

/** Relative draw weights; a kind absent or 0 is never drawn. `shapes` weights
 *  the named shapes (each shape draws equally within it). */
export type Weights = Partial<Record<ChangeKind | 'shapes', number>>

export const DEFAULT_WEIGHTS: Readonly<Record<ChangeKind | 'shapes', number>> = {
  newIssue: 3,
  newSession: 3,
  heartbeat: 4,
  newWorktree: 2,
  remove: 2,
  reparent: 3,
  phaseChange: 4,
  offerChange: 3,
  stageChange: 3,
  archive: 2,
  rankMove: 3,
  evict: 2,
  reAdd: 3,
  clockTick: 3,
  batch: 2,
  edit: 8,
  accept: 5,
  reject: 3,
  echo: 5,
  remoteOnPending: 3,
  staleRepeat: 2,
  supersede: 4,
  offline: 3,
  online: 3,
  refresh: 1.5,
  shapes: 8,
}

/** Clock steps, weighted toward the runtime's own minute tick. 25 h crosses
 *  the finished-grace window (`SIDEBAR_FINISHED_GRACE_MS`); the day-scale
 *  steps move defer bands. */
const TICKS: readonly (readonly [number, number])[] = [
  [60_000, 6],
  [60 * 60_000, 2],
  [6 * 60 * 60_000, 1],
  [25 * 60 * 60_000, 1],
]
const DECAY_MS = 25 * 60 * 60_000

// ------------------------------------------------------------------------ rng

/** mulberry32: the fixture's PRNG, so a seed means the same thing everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------- model

const ACTIVE_STAGES = new Set(['in_progress', 'planning', 'review'])

interface IssueModel {
  id: string
  parentId: string | null
  repoId: string | null
  stage: string
  archived: boolean
  sortKey: string | null
  sessions: Set<string>
}

interface SessionModel {
  id: string
  issueId: string | null
  phase: SessionPhase
  offer: boolean
}

type EditState = 'queued' | 'sent' | 'accepted' | 'rejected' | 'superseded'

interface EditModel {
  handle: string
  id: string
  field: 'title' | 'stage' | 'readAt'
  state: EditState
  /** The server applied it (an echo went out). */
  echoed: boolean
}

/** The generator's picture of the world: enough to aim, not to predict. */
class GenModel {
  readonly issues = new Map<string, IssueModel>()
  readonly sessions = new Map<string, SessionModel>()
  /** Issues out of scope right now (evicted), re-addable. */
  readonly evicted = new Set<string>()
  /** The rows the worklist is likely to show: open human work, its parents,
   *  and everything the generator created. Most targets come from here so
   *  the sequence moves visible rows, not the 4,000 closed ones. */
  readonly hot: string[] = []
  readonly hotSessions: string[] = []
  readonly allIssues: string[] = []
  readonly allSessions: string[] = []
  readonly repoIds: string[] = []
  readonly edits: EditModel[] = []
  online = true
  private minted = 0

  constructor(corpus: FixtureCorpus) {
    type Wire = {
      id: string
      parentId?: string | null
      repoId?: string | null
      stage: string
      archived?: boolean
      deletedAt?: string | null
      closedAt?: string | null
      audience?: string
      sortKey?: string | null
    }
    const wires = corpus.issues as unknown as Wire[]
    for (const w of wires) {
      if (w.deletedAt) continue
      this.issues.set(w.id, {
        id: w.id,
        parentId: w.parentId ?? null,
        repoId: w.repoId ?? null,
        stage: w.stage,
        archived: Boolean(w.archived),
        sortKey: w.sortKey ?? null,
        sessions: new Set(),
      })
      this.allIssues.push(w.id)
    }
    const hot = new Set<string>()
    for (const w of wires) {
      if (w.deletedAt || w.archived || w.closedAt || w.audience !== 'human') continue
      if (!ACTIVE_STAGES.has(w.stage)) continue
      hot.add(w.id)
      if (w.parentId) hot.add(w.parentId)
    }
    // Children of hot parents (finished children carry the rollup shapes).
    for (const w of wires) if (w.parentId && hot.has(w.parentId) && !w.deletedAt) hot.add(w.id)
    this.hot.push(...[...hot].filter((id) => this.issues.has(id)))
    for (const s of corpus.sessions) {
      const phase = (s.agentState as { phase?: string } | undefined)?.phase === 'working' ? 'working' : 'idle'
      const model: SessionModel = {
        id: s.sessionId,
        issueId: s.issueId ?? null,
        phase,
        offer: Boolean((s as { offer?: unknown }).offer),
      }
      this.sessions.set(s.sessionId, model)
      this.allSessions.push(s.sessionId)
      if (model.issueId) {
        this.issues.get(model.issueId)?.sessions.add(s.sessionId)
        if (hot.has(model.issueId)) this.hotSessions.push(s.sessionId)
      }
    }
    for (const r of corpus.repoProjections) this.repoIds.push(r.id)
  }

  mint(prefix: string): string {
    this.minted += 1
    return `${prefix}${this.minted}`
  }

  present(id: string): boolean {
    return this.issues.has(id) && !this.evicted.has(id)
  }

  /** `id` is `ancestor` or below it. */
  isUnder(id: string, ancestor: string): boolean {
    let cur: string | null = id
    for (let guard = 0; cur !== null && guard < 64; guard += 1) {
      if (cur === ancestor) return true
      cur = this.issues.get(cur)?.parentId ?? null
    }
    return false
  }

  /** Siblings the order compares directly: children of one parent, or roots
   *  of one repo. Hot rows only (the groups the worklist can show). */
  siblingsOf(id: string): string[] {
    const self = this.issues.get(id)
    if (!self) return []
    return this.hot.filter((other) => {
      if (!this.present(other)) return false
      const o = this.issues.get(other) as IssueModel
      return self.parentId !== null ? o.parentId === self.parentId : o.parentId === null && o.repoId === self.repoId
    })
  }

  openEdits(): EditModel[] {
    return this.edits.filter((e) => e.state === 'queued' || e.state === 'sent' || (e.state === 'accepted' && !e.echoed))
  }

  /**
   * The kernel outbox's drain, mirrored so answers aim at calls that are
   * really at the server (`packages/sync/src/outbox/outbox.ts` `drain`):
   *
   * - ONE PASS AT A TIME. A pass starts on a trigger (an enqueue while
   *   online, the online edge, a reload's attach) only when none is running,
   *   and snapshots the queued entries per partition (`issue:<id>`) at start.
   *   An entry enqueued while a pass waits on a held call is NOT in it and
   *   is not sent when that call answers: it waits for the next trigger
   *   (FINDING, POD-4555: a slow answer on one issue holds back a write on
   *   another).
   * - Per partition, FIFO: send the head, wait for its answer, then the next
   *   snapshot entry. A refusal stops the partition for the pass; a refused
   *   TITLE is parked (authored text) and blocks its partition for good.
   * - A re-sent entry the server already applied is answered at once.
   */
  private pass: Map<string, EditModel[]> | null = null
  readonly parked = new Set<string>()

  trigger(): void {
    if (!this.online || this.pass !== null) return
    const pass = new Map<string, EditModel[]>()
    for (const e of this.edits) {
      if (e.state !== 'queued') continue
      const bucket = pass.get(e.id)
      if (bucket) bucket.push(e)
      else pass.set(e.id, [e])
    }
    this.pass = pass
    this.advance()
  }

  advance(): void {
    const pass = this.pass
    if (pass === null) return
    for (const [issue, bucket] of pass) {
      while (bucket.length > 0) {
        if (this.parked.has(issue)) {
          bucket.length = 0
          break
        }
        const head = bucket[0] as EditModel
        if (head.state === 'sent') break
        if (head.state === 'rejected') {
          bucket.length = 0
          break
        }
        if (head.state === 'queued') {
          if (head.echoed) {
            head.state = 'accepted'
          } else {
            head.state = 'sent'
            break
          }
        }
        bucket.shift()
      }
      if (bucket.length === 0) pass.delete(issue)
    }
    if (pass.size === 0) this.pass = null
  }

  /** A reload: the old tab's pass dies with its unanswered calls, which go
   *  back to queued; the new runtime's attach triggers a fresh pass. */
  reload(): void {
    this.pass = null
    for (const e of this.edits) if (e.state === 'sent') e.state = 'queued'
    this.trigger()
  }
}

// ------------------------------------------------------------------ generator

/** Built once per (scale, seed): the fixture is deterministic and immutable. */
const corpusCache = new Map<string, FixtureCorpus>()
export function genCorpus(scale: 1 | 2 | 4 = 1, seed = FIXTURE_SEED): FixtureCorpus {
  const key = `${scale}:${seed}`
  let corpus = corpusCache.get(key)
  if (!corpus) {
    corpus = buildCorpus(scale, seed)
    corpusCache.set(key, corpus)
  }
  return corpus
}

export interface GenOptions {
  /** The corpus the sequence is aimed at. Default: the one fixture, 1x. */
  corpus?: FixtureCorpus
  /**
   * POD-4574 (Mc2) — which fields generated edits may set. Default all three.
   * The Mc2 gate uses title + mark-read only: a pending stage moves progress
   * roll-ups, which the write oracle (titles overlaid on the kernel snapshot)
   * cannot judge — pending stages flow through the same overlaid inputs as
   * server stages (proven by the server-stage fences), and the full-vocabulary
   * gate with stage edits waits for the phase-c decision. Deterministic in
   * the option (it only re-scales the draw, drawing no extra numbers).
   */
  editFields?: readonly ('title' | 'stage' | 'readAt')[]
}

/**
 * `steps` changes drawn from `weights` (merged over {@link DEFAULT_WEIGHTS}),
 * deterministic in `(seed, steps, weights, corpus)`. A drawn kind whose
 * precondition does not hold in the model (nothing evicted to re-add, no
 * held edit to answer, already online) is redrawn, so the output is always
 * exactly `steps` changes. A shape may emit up to three changes; the tail is
 * cut at `steps`.
 */
export function gen(seed: number, steps: number, weights: Weights = {}, opts: GenOptions = {}): Change[] {
  const corpus = opts.corpus ?? genCorpus()
  const rng = mulberry32(seed)
  const model = new GenModel(corpus)
  const w: Record<string, number> = { ...DEFAULT_WEIGHTS, ...weights }
  const table = (Object.keys(w) as (ChangeKind | 'shapes')[]).filter((k) => (w[k] ?? 0) > 0)
  const total = table.reduce((sum, k) => sum + (w[k] as number), 0)
  const out: Change[] = []

  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))
  const pick = <T>(items: readonly T[]): T | undefined =>
    items.length === 0 ? undefined : items[Math.floor(rng() * items.length)]
  const chance = (p: number): boolean => rng() < p
  const draw = (): ChangeKind | 'shapes' => {
    let r = rng() * total
    for (const k of table) {
      r -= w[k] as number
      if (r < 0) return k
    }
    return table[table.length - 1] as ChangeKind
  }
  const pickIssue = (filter: (m: IssueModel) => boolean = () => true): IssueModel | undefined => {
    for (let tries = 0; tries < 40; tries += 1) {
      const id = chance(0.85) ? pick(model.hot) : pick(model.allIssues)
      if (id === undefined || !model.present(id)) continue
      const m = model.issues.get(id) as IssueModel
      if (filter(m)) return m
    }
    return undefined
  }
  const pickSession = (filter: (s: SessionModel) => boolean = () => true): SessionModel | undefined => {
    for (let tries = 0; tries < 40; tries += 1) {
      const id = chance(0.8) ? pick(model.hotSessions) : pick(model.allSessions)
      const s = id === undefined ? undefined : model.sessions.get(id)
      if (s && filter(s) && (s.issueId === null || model.present(s.issueId))) return s
    }
    return undefined
  }

  // Each builder returns the changes it emits (applied to the model) or null
  // when its precondition fails.
  const rowChange = (kind: RowKind, shape?: ShapeName): RowChange | null => {
    const tag = shape ? { shape } : {}
    switch (kind) {
      case 'newIssue': {
        const id = model.mint('i-g')
        const parent = chance(0.4) ? pickIssue() : undefined
        const repoId = parent?.repoId ?? pick(model.repoIds) ?? null
        model.issues.set(id, {
          id,
          parentId: parent?.id ?? null,
          repoId,
          stage: 'in_progress',
          archived: false,
          sortKey: null,
          sessions: new Set(),
        })
        model.hot.push(id)
        model.allIssues.push(id)
        return { kind, id, parentId: parent?.id ?? null, title: `Generated ${id}`, ...tag }
      }
      case 'newSession': {
        const issue = pickIssue()
        if (!issue) return null
        const sessionId = model.mint('s-g')
        const phase: SessionPhase = chance(0.6) ? 'working' : 'idle'
        model.sessions.set(sessionId, { id: sessionId, issueId: issue.id, phase, offer: false })
        issue.sessions.add(sessionId)
        model.hotSessions.push(sessionId)
        model.allSessions.push(sessionId)
        return { kind, sessionId, issueId: issue.id, phase, ...tag }
      }
      case 'heartbeat': {
        const s = pickSession()
        return s ? { kind, sessionId: s.id, ...tag } : null
      }
      case 'newWorktree': {
        const repoId = pick(model.repoIds)
        if (!repoId) return null
        return { kind, repoId, path: `/w/gen-${model.mint('wt')}`, ...tag }
      }
      case 'remove': {
        if (chance(0.5)) {
          const s = pickSession()
          if (!s) return null
          model.sessions.delete(s.id)
          if (s.issueId) model.issues.get(s.issueId)?.sessions.delete(s.id)
          return { kind, entity: 'session', id: s.id, ...tag }
        }
        const issue = pickIssue()
        if (!issue) return null
        model.issues.delete(issue.id)
        return { kind, entity: 'issue', id: issue.id, ...tag }
      }
      case 'reparent': {
        const issue = pickIssue()
        if (!issue) return null
        const toRoot = issue.parentId !== null && chance(0.25)
        const parent = toRoot ? undefined : pickIssue((p) => p.id !== issue.parentId && !model.isUnder(p.id, issue.id))
        if (!toRoot && !parent) return null
        issue.parentId = parent?.id ?? null
        return { kind, id: issue.id, parentId: issue.parentId, ...tag }
      }
      case 'phaseChange': {
        const s = pickSession()
        if (!s) return null
        s.phase = s.phase === 'working' ? 'idle' : 'working'
        return { kind, sessionId: s.id, phase: s.phase, ...tag }
      }
      case 'offerChange': {
        const s = pickSession()
        if (!s) return null
        s.offer = !s.offer
        return { kind, sessionId: s.id, offer: s.offer, ...tag }
      }
      case 'stageChange': {
        const issue = pickIssue()
        if (!issue) return null
        const stages = ['backlog', 'planning', 'in_progress', 'review', 'done'].filter((s) => s !== issue.stage)
        issue.stage = pick(stages) as string
        return { kind, id: issue.id, stage: issue.stage, ...tag }
      }
      case 'archive': {
        const issue = pickIssue()
        if (!issue) return null
        issue.archived = !issue.archived
        return { kind, id: issue.id, archived: issue.archived, ...tag }
      }
      case 'rankMove': {
        const issue = pickIssue()
        if (!issue) return null
        return rankMove(issue, model.siblingsOf(issue.id), tag)
      }
      case 'evict': {
        const issue = pickIssue()
        if (!issue) return null
        model.evicted.add(issue.id)
        return { kind, id: issue.id, ...tag }
      }
      case 'reAdd': {
        const id = pick([...model.evicted])
        if (id === undefined) return null
        model.evicted.delete(id)
        return { kind, id, ...tag }
      }
    }
  }

  /** A key that moves `issue` among its siblings: before the first keyed
   *  sibling, between two adjacent ones, after the last, or unkeyed. Keys
   *  come from the model's own `sortKeyBetween`; bounds are the siblings'
   *  WELL-FORMED keys only (the fixture's `a0` ends in the minimum digit, so
   *  the model would refuse it as a bound). */
  const rankMove = (issue: IssueModel, siblings: string[], tag: Tagged): RowChange => {
    const keys = [
      ...new Set(
        siblings
          .filter((id) => id !== issue.id)
          .map((id) => model.issues.get(id)?.sortKey ?? null)
          .filter((k): k is string => isSortKey(k)),
      ),
    ].sort()
    const slot = int(0, keys.length + 1)
    const sortKey =
      slot === keys.length + 1 && issue.sortKey !== null
        ? null
        : sortKeyBetween(slot === 0 ? null : (keys[slot - 1] ?? null), keys[slot] ?? null)
    issue.sortKey = sortKey
    return { kind: 'rankMove', id: issue.id, sortKey, ...tag }
  }

  const groupWith = (min: number): { issue: IssueModel; siblings: string[] } | undefined => {
    for (let tries = 0; tries < 40; tries += 1) {
      const issue = pickIssue()
      if (!issue) continue
      const siblings = model.siblingsOf(issue.id)
      if (siblings.length >= min) return { issue, siblings }
    }
    return undefined
  }

  const shape = (name: ShapeName): Change[] | null => {
    const tag = { shape: name }
    switch (name) {
      case 'clockDecay': {
        // A visible row finishes, then the clock crosses the grace window:
        // the row must decay into the fold with no row change at all.
        const issue = pickIssue((m) => ACTIVE_STAGES.has(m.stage))
        if (!issue) return null
        issue.stage = 'done'
        return [
          { kind: 'stageChange', id: issue.id, stage: 'done', ...tag },
          { kind: 'clockTick', ms: DECAY_MS, ...tag },
        ]
      }
      case 'offerRemovedOnFinishedChild': {
        // The offer leaves a session on a FINISHED child: the parent's
        // aggregate depends on the child even though the child row is done.
        const s = pickSession((c) => {
          const issue = c.issueId ? model.issues.get(c.issueId) : undefined
          return issue !== undefined && issue.parentId !== null
        })
        if (!s) return null
        const issue = model.issues.get(s.issueId as string) as IssueModel
        const out: Change[] = []
        if (issue.stage !== 'done') {
          issue.stage = 'done'
          out.push({ kind: 'stageChange', id: issue.id, stage: 'done', ...tag })
        }
        if (!s.offer) out.push({ kind: 'offerChange', sessionId: s.id, offer: true, ...tag })
        s.offer = false
        out.push({ kind: 'offerChange', sessionId: s.id, offer: false, ...tag })
        return out
      }
      case 'rankMoveWithinGroup': {
        const g = groupWith(2)
        return g ? [rankMove(g.issue, g.siblings, tag)] : null
      }
      case 'evictThenReAdd': {
        const issue = pickIssue()
        if (!issue) return null
        return [
          { kind: 'evict', id: issue.id, ...tag },
          { kind: 'reAdd', id: issue.id, ...tag },
        ]
      }
      case 'twoRankMovesInOneBatch': {
        const g = groupWith(2)
        if (!g) return null
        const other = g.siblings.find((id) => id !== g.issue.id) as string
        const first = rankMove(g.issue, g.siblings, {})
        const second = rankMove(model.issues.get(other) as IssueModel, g.siblings, {})
        return [{ kind: 'batch', changes: [first, second], ...tag }]
      }
    }
  }

  const editPatch = (issue: IssueModel): { patch: EditIntent; field: EditModel['field'] } => {
    const narrowed = opts.editFields !== undefined && opts.editFields.length > 0 ? opts.editFields : undefined
    const fields = narrowed ?? (['title', 'stage', 'readAt'] as const)
    // Fixed shares of the draw, renormalised over the allowed fields (no
    // extra numbers drawn, so a narrowed vocabulary is a prefix-stable
    // resequence only in the statistical sense; sequences differ by option).
    const titleShare = fields.includes('title') ? 0.45 : 0
    const stageShare = fields.includes('stage') ? 0.3 : 0
    const r = rng() * (titleShare + stageShare + (fields.includes('readAt') ? 0.25 : 0))
    if (r < titleShare) return { patch: { title: `Title ${model.mint('t')}` }, field: 'title' }
    if (r < titleShare + stageShare) {
      const stage = pick(EDITABLE_STAGES.filter((s) => s !== issue.stage)) as EditableStage
      return { patch: { stage }, field: 'stage' }
    }
    return { patch: { readAt: true }, field: 'readAt' }
  }

  const newEdit = (id: string, field: EditModel['field']): EditModel => {
    // A new mark-read collapses a still-QUEUED mark-read on the same row.
    if (field === 'readAt') {
      for (const e of model.edits) {
        if (e.id === id && e.field === 'readAt' && e.state === 'queued') e.state = 'superseded'
      }
    }
    const edit: EditModel = { handle: model.mint('e'), id, field, state: 'queued', echoed: false }
    model.edits.push(edit)
    return edit
  }

  const writeChange = (kind: (typeof WRITE_KINDS)[number]): Change[] | null => {
    switch (kind) {
      case 'edit': {
        const issue = pickIssue()
        if (!issue) return null
        const { patch, field } = editPatch(issue)
        if ('stage' in patch) issue.stage = patch.stage
        const edit = newEdit(issue.id, field)
        model.trigger()
        return [{ kind, handle: edit.handle, id: issue.id, patch }]
      }
      case 'accept':
      case 'reject': {
        const e = pick(model.edits.filter((c) => c.state === 'sent' && (kind === 'accept' || !c.echoed)))
        if (!e) return null
        e.state = kind === 'accept' ? 'accepted' : 'rejected'
        if (kind === 'reject' && e.field === 'title') model.parked.add(e.id)
        model.advance()
        return [{ kind, handle: e.handle }]
      }
      case 'echo': {
        const e = pick(model.edits.filter((c) => (c.state === 'sent' || c.state === 'accepted') && !c.echoed))
        if (!e) return null
        e.echoed = true
        return [{ kind, handle: e.handle }]
      }
      case 'remoteOnPending': {
        const e = pick(model.openEdits())
        if (!e) return null
        const value =
          e.field === 'stage'
            ? (pick(EDITABLE_STAGES) as string)
            : e.field === 'title'
              ? `Theirs ${model.mint('r')}`
              : 'server-stamp'
        return [{ kind, handle: e.handle, value }]
      }
      case 'staleRepeat': {
        const e = pick(model.edits.filter((c) => c.state === 'accepted' && !c.echoed))
        return e ? [{ kind, handle: e.handle }] : null
      }
      case 'supersede': {
        if (model.online) return null
        const issue = pickIssue()
        if (!issue) return null
        const first = newEdit(issue.id, 'readAt')
        const second = newEdit(issue.id, 'readAt')
        return [{ kind, id: issue.id, handles: [first.handle, second.handle] }]
      }
      case 'offline': {
        if (!model.online) return null
        model.online = false
        return [{ kind }]
      }
      case 'online': {
        if (model.online) return null
        model.online = true
        model.trigger()
        return [{ kind }]
      }
      case 'refresh': {
        // The old tab's in-flight calls die with it; the new runtime re-sends.
        // One the server already applied is answered at once (deduped by
        // mutation id): the duplicate receipt.
        model.reload()
        return [{ kind }]
      }
    }
  }

  const step = (kind: ChangeKind | 'shapes'): Change[] | null => {
    if (kind === 'shapes') return shape(pick(SHAPES) as ShapeName)
    if (kind === 'clockTick') {
      let r = rng() * TICKS.reduce((sum, [, weight]) => sum + weight, 0)
      for (const [ms, weight] of TICKS) {
        r -= weight
        if (r < 0) return [{ kind, ms }]
      }
      return [{ kind, ms: 60_000 }]
    }
    if (kind === 'batch') {
      const n = int(2, 6)
      const changes: RowChange[] = []
      for (let k = 0; k < n; k += 1) {
        const inner = pick(ROW_KINDS.filter((r) => r !== 'newWorktree')) as RowKind
        const c = rowChange(inner)
        if (c) changes.push(c)
      }
      return changes.length >= 2 ? [{ kind, changes }] : null
    }
    if ((ROW_KINDS as readonly string[]).includes(kind)) {
      const c = rowChange(kind as RowKind)
      return c ? [c] : null
    }
    return writeChange(kind as (typeof WRITE_KINDS)[number])
  }

  let stalls = 0
  while (out.length < steps) {
    const emitted = step(draw())
    if (emitted === null) {
      stalls += 1
      if (stalls > 10_000) throw new Error(`[gen] seed ${seed}: no drawable change (weights too narrow?)`)
      continue
    }
    out.push(...emitted)
  }
  return out.slice(0, steps)
}

/** How many changes of each kind (batch members counted separately under
 *  `batch:<kind>`), and how many carry each shape. */
export function countKinds(changes: readonly Change[]): {
  kinds: Record<string, number>
  shapes: Record<string, number>
} {
  const kinds: Record<string, number> = {}
  const shapes: Record<string, number> = {}
  const bump = (m: Record<string, number>, k: string): void => {
    m[k] = (m[k] ?? 0) + 1
  }
  for (const c of changes) {
    bump(kinds, c.kind)
    if ('shape' in c && c.shape) bump(shapes, c.shape)
    if (c.kind === 'batch') for (const inner of c.changes) bump(kinds, `batch:${inner.kind}`)
  }
  return { kinds, shapes }
}
