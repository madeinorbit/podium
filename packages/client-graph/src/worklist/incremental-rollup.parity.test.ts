import '@podium/client-graph/synced-models'
import { autorun, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { MobxPool } from '../pool'
import type { RowRecord } from '../shared/source'
import {
  type Aggregate,
  aggregatePartOf,
  type RollupInputs,
  type RollupParts,
  type UnitOwn,
  type Units,
  unitOwnPartOf,
  unitsBelowPartOf,
} from './rollup'
import { worklistView } from './view-model'

/**
 * POD-7173 — the roll-ups a parent folds once per burst answer exactly what a
 * full recompute answers. A row keeps its part in its parent's progress as
 * cached records (counts, tasks by state, staffing), and a parent walks its
 * nest children once per burst for attention, instead of walking every child
 * for every field. A fold that missed a move would show a wrong number only
 * after some bursts, so the trees here arrive in random bursts (random order
 * and sizes), then move in random edits, while a sidebar-like observer keeps
 * every row's fields live in between, as the drawn sidebar does. After every
 * burst each row's live progress and attention must equal the oracle: the
 * eager parts (`unitsBelowPartOf`, `unitOwnPartOf`, `aggregatePartOf`)
 * composed from scratch at every level, reading no cached roll-up of any row.
 */
const stamp = '2026-11-18T12:00:00Z'
const at = (minutes: number) => new Date(Date.parse(stamp) - minutes * 60_000).toISOString()

/** A small seeded generator (mulberry32): every run of a seed is the same. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Row = Record<string, unknown>

const STAGES = ['planning', 'in_progress', 'review', 'done', 'done', 'proposed'] as const
const PHASES = [
  { phase: 'working', since: at(30) },
  { phase: 'waiting', since: at(20) },
  { phase: 'needs_user', since: at(10) },
  { phase: 'idle', since: at(5), idle: { kind: 'done' } },
] as const

function issueOf(id: string, n: number, parentId: string | null, next: () => number): Row {
  const stage = STAGES[Math.floor(next() * STAGES.length)]!
  const closed = stage === 'done'
  return {
    id,
    seq: n + 1,
    title: id,
    stage,
    audience: 'human',
    repoPath: '/synthetic',
    parentId,
    createdAt: at(10_000 - n),
    updatedAt: closed ? at(60 * 24 * 400) : at(n % 50),
    ...(closed
      ? {
          closedReason: next() < 0.15 ? 'abandoned' : 'completed',
          closedAt: at(60 * (1 + (n % 30))),
        }
      : {}),
    ...(next() < 0.3 ? { sortKey: String(n).padStart(8, '0') } : {}),
    ...(next() < 0.08 ? { type: 'phase' } : {}),
    ...(next() < 0.1 ? { needsHuman: true } : {}),
  }
}

function sessionOf(id: string, issueId: string, next: () => number): Row {
  return {
    sessionId: id,
    issueId,
    cwd: '/synthetic',
    agentKind: next() < 0.5 ? 'claude-code' : 'codex',
    status: next() < 0.8 ? 'live' : 'ended',
    archived: false,
    lastActiveAt: at(Math.floor(next() * 90)),
    createdAt: at(200),
    agentState: PHASES[Math.floor(next() * PHASES.length)],
    ...(next() < 0.1 ? { offer: { message: 'Ready', createdAt: stamp, actions: [] } } : {}),
  }
}

interface Tree {
  readonly issues: Row[]
  readonly sessions: Row[]
}

/** The operator deck's shape: one root and many direct children; or a tree three deep. */
function treeOf(shape: 'flat' | 'deep', size: number, next: () => number): Tree {
  const issues: Row[] = [
    { ...issueOf('root', 0, null, next), stage: 'in_progress', coordinatorSessionId: 'root-seat' },
  ]
  const ids: string[] = []
  for (let n = 0; n < size; n += 1) {
    const id = `t${n + 1}`
    const parentId = shape === 'flat' || n < 4 ? 'root' : n < 16 ? ids[n % 4]! : ids[4 + (n % 12)]!
    ids.push(id)
    issues.push(issueOf(id, n + 1, parentId, next))
  }
  // A formal cycle beside the tree: its members cannot compose each other's units.
  issues.push(issueOf('c1', size + 2, 'c2', next), issueOf('c2', size + 3, 'c1', next))
  issues.push(issueOf('c3', size + 4, 'c1', next))
  const sessions: Row[] = [sessionOf('root-seat', 'root', next)]
  for (const issue of issues) {
    const count = next() < 0.4 ? Math.floor(next() * 3) + 1 : 0
    for (let s = 0; s < count; s += 1)
      sessions.push(sessionOf(`${String(issue['id'])}-s${s}`, String(issue['id']), next))
  }
  return { issues, sessions }
}

const issueRecord = (value: Row): RowRecord => ({
  kind: 'issue',
  id: String(value['id']),
  value: value as never,
})
const sessionRecord = (value: Row): RowRecord => ({
  kind: 'session',
  id: String(value['sessionId']),
  value: value as never,
})

/**
 * THE ORACLE: the eager parts at every level, composed from scratch. Each
 * node's aggregate, closure and own unit are rebuilt from its children's
 * rebuilt ones, never read from a live row's roll-up. A row's own facts
 * (standing, seats, own attention) come from the row: they are not what a
 * parent folds.
 */
function oracleInputs(input: RollupInputs): RollupInputs {
  const nodes = new Map<string, RollupParts | undefined>()
  const oracle: RollupInputs = {
    ...input,
    rollupNode(id) {
      if (nodes.has(id)) return nodes.get(id)
      const live = input.rollupNode(id)
      if (live === undefined) {
        nodes.set(id, undefined)
        return undefined
      }
      let unitsBelow: Units | undefined
      let unitOwn: UnitOwn | undefined
      let aggregate: Aggregate | undefined
      const node: RollupParts = {
        get updatedMs() {
          return live.updatedMs
        },
        get ownFacts() {
          return live.ownFacts
        },
        get formalParent() {
          return live.formalParent
        },
        get ownAttention() {
          return live.ownAttention
        },
        get seatActivity() {
          return live.seatActivity
        },
        get openOwn() {
          return live.openOwn
        },
        get tip() {
          return live.tip
        },
        get rollup() {
          return live.rollup
        },
        get unitsBelow() {
          if (unitsBelow === undefined) unitsBelow = unitsBelowPartOf(oracle, id)
          return unitsBelow
        },
        get unitOwn() {
          if (unitOwn === undefined)
            unitOwn = unitOwnPartOf(oracle, id, {
              openOwn: live.openOwn,
              unitsBelow: this.unitsBelow,
            })
          return unitOwn
        },
        get aggregate() {
          if (aggregate === undefined)
            aggregate = aggregatePartOf(oracle, id, {
              ownAttention: live.ownAttention,
            })
          return aggregate
        },
      }
      nodes.set(id, node)
      return node
    },
  }
  return oracle
}

/** Every field of a value, getters read: what a reader of the whole answer sees. */
function plain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(plain)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const field = plain((value as Record<string, unknown>)[key])
    if (field !== undefined) out[key] = field
  }
  return out
}

interface Run {
  readonly pool: MobxPool
  readonly ids: readonly string[]
  readonly stop: () => void
}

/** A pool with the root, and the sidebar's readers on every issue row from the start. */
function openPool(ids: readonly string[], root: Row): Run {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [issueRecord(root)] })
  const worklist = worklistView(pool)
  const stop = autorun(() => {
    for (const id of ids) {
      const row = worklist.knownRow(id)
      if (row === undefined) continue
      // The drawn row's reads, and the filing roll-up's (groups, phone).
      void [
        row.ready,
        row.progress,
        row.visibleWorking,
        row.visibleAsking,
        row.waitingCount,
        row.visibleFleet,
        row.visibleSessionIds,
        row.timing,
        row.errorClass,
        row.loading,
        row.phase,
        row.working,
        row.asking,
        row.waiting,
        row.sectionAsking,
        row.progressDone,
        row.progressTotal,
        row.unitOwn.staffed,
      ]
    }
  })
  return { pool, ids, stop }
}

/** Every row's live progress and attention, on both paths, against the oracle. */
function expectParity(run: Run, label: string): void {
  const { pool, ids } = run
  const worklist = worklistView(pool)
  const filing = oracleInputs(pool.rollupInputs)
  const drawn = oracleInputs(worklist.rowInputs)
  runInAction(() => {
    for (const id of ids) {
      const row = worklist.knownRow(id)
      if (row === undefined) continue
      const where = `${label}: ${id}`
      expect(plain(row.unitsBelow), `${where} closure`).toEqual(
        plain(filing.rollupNode(id)!.unitsBelow),
      )
      expect(plain(row.unitOwn), `${where} unit`).toEqual(plain(filing.rollupNode(id)!.unitOwn))
      expect(plain(row.aggregate), `${where} filing aggregate`).toEqual(
        plain(filing.rollupNode(id)!.aggregate),
      )
      expect(plain(row.visibleAttention), `${where} drawn aggregate`).toEqual(
        plain(drawn.rollupNode(id)!.aggregate),
      )
    }
  })
}

/** Split `records` into bursts of random sizes, in random order. */
function burstsOf(records: readonly RowRecord[], next: () => number, most: number): RowRecord[][] {
  const order = [...records]
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  const bursts: RowRecord[][] = []
  for (let at = 0; at < order.length; ) {
    const size = 1 + Math.floor(next() * most)
    bursts.push(order.slice(at, at + size))
    at += size
  }
  return bursts
}

/** Random edits of a tree already installed: phases, stages, parents, sessions gone or back. */
function editsOf(tree: Tree, next: () => number, count: number): RowRecord[][] {
  const bursts: RowRecord[][] = []
  const issues = tree.issues.filter((issue) => issue['id'] !== 'root')
  for (let b = 0; b < count; b += 1) {
    const burst: RowRecord[] = []
    const size = 1 + Math.floor(next() * 6)
    for (let e = 0; e < size; e += 1) {
      const kind = next()
      if (kind < 0.35 && tree.sessions.length > 0) {
        const session = tree.sessions[Math.floor(next() * tree.sessions.length)]!
        burst.push(
          sessionRecord({ ...session, agentState: PHASES[Math.floor(next() * PHASES.length)] }),
        )
      } else if (kind < 0.55) {
        const issue = issues[Math.floor(next() * issues.length)]!
        const stage = STAGES[Math.floor(next() * STAGES.length)]!
        burst.push(
          issueRecord({
            ...issue,
            stage,
            closedReason: stage === 'done' ? 'completed' : null,
            closedAt: stage === 'done' ? at(5) : null,
            updatedAt: at(1),
          }),
        )
      } else if (kind < 0.7) {
        const issue = issues[Math.floor(next() * issues.length)]!
        const parent = next() < 0.5 ? 'root' : issues[Math.floor(next() * issues.length)]!['id']
        if (parent !== issue['id']) burst.push(issueRecord({ ...issue, parentId: parent }))
      } else if (kind < 0.85 && tree.sessions.length > 0) {
        const session = tree.sessions[Math.floor(next() * tree.sessions.length)]!
        burst.push({ kind: 'session', id: String(session['sessionId']), value: undefined })
      } else if (tree.sessions.length > 0) {
        burst.push(sessionRecord(tree.sessions[Math.floor(next() * tree.sessions.length)]!))
      }
    }
    bursts.push(burst)
  }
  return bursts
}

describe('roll-ups folded per burst equal a full recompute (POD-7173)', () => {
  for (const shape of ['flat', 'deep'] as const) {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      it(`${shape} tree, seed ${seed}: arriving in random bursts, then edited`, () => {
        const next = random(seed * 7919 + (shape === 'flat' ? 0 : 104_729))
        const tree = treeOf(shape, shape === 'flat' ? 60 : 48, next)
        const ids = tree.issues.map((issue) => String(issue['id']))
        const root = tree.issues[0]!
        const run = openPool(ids, root)
        try {
          const arrivals = [
            ...tree.issues.slice(1).map(issueRecord),
            ...tree.sessions.map(sessionRecord),
          ]
          for (const [n, burst] of burstsOf(arrivals, next, 25).entries()) {
            runInAction(() => run.pool.apply({ type: 'update', rows: burst }))
            expectParity(run, `arrival burst ${n}`)
          }
          for (const [n, burst] of editsOf(tree, next, 25).entries()) {
            runInAction(() => run.pool.apply({ type: 'update', rows: burst }))
            expectParity(run, `edit burst ${n}`)
          }
          // The fold is live, not a copy: the root's progress counts its children.
          const rootRow = worklistView(run.pool).knownRow('root')!
          expect(rootRow.unitsBelow.members).toBeGreaterThan(0)
        } finally {
          run.stop()
          run.pool.dispose()
        }
      })
    }
  }
})
