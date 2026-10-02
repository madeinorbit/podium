import type { SliceLocals, SliceSnapshot } from '@podium/client-graph/shared/slice-types'
/**
 * POD-4559 — the store helpers run on ONE clock: the caller's.
 *
 * `snapshotFromStore`, `rebuiltSnapshotFromStore` and `rowViewsFromStore` take
 * the clock in `locals.coarseNow`. They used to DERIVE with the store's clock
 * and PROJECT with the caller's, so a caller whose clock differed from the
 * store's got a snapshot built on two clocks (POD-4556 found it and worked
 * around it with `oracleSnapshot`). The truth for "this store at clock X" is
 * the store actually advanced to X, through the runtime's own tick path; each
 * helper asked at X must equal it.
 *
 * ARMED: the two-clock composition (derive at the store's clock, project at
 * the caller's) is kept below as the control, and must differ from the truth,
 * so the assertions can fail. On the plain 1x corpus the derivation's clock
 * moves the row views (a session ages out of a row: its `activityAt`) but no
 * `SliceSnapshot` field at any offset up to a year, so the snapshot helpers
 * are proven on a planted row instead: a finished, unread child whose 7-day
 * unread window (`SIDEBAR_FINISHED_UNREAD_WINDOW_MS`, client-core
 * `visibility.ts`) closes one hour after the store's clock. The derivation
 * decides whether it is a row at all, so two clocks keep it and one drops it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ScenarioEngine,
  startScenarioEngine,
  upsert,
  upsertIssue,
} from '../../../shared/src/scenarios'
import {
  legacyDerivationFromStore,
  oracleSnapshot,
  projectRowViews,
  projectSnapshot,
  type RowViews,
  rebuiltSnapshotFromStore,
  rowViewsFromStore,
  snapshotFromStore,
} from './index'

/** Offsets ahead of the store clock, cumulative. The derivation reads the
 *  clock for the work list's time windows (recently closed, idle worktrees),
 *  the projection for bands, folds and group order; at least one offset must
 *  move the derivation, or the control below cannot fail. */
const HOUR = 60 * 60 * 1000
const AHEAD_MS = [1, 6, 24, 72, 7 * 24, 30 * 24, 90 * 24, 365 * 24].map((h) => h * HOUR)

type Store = ReturnType<ScenarioEngine['engine']['getSnapshot']>

interface Truth {
  locals: SliceLocals
  snapshot: SliceSnapshot
  views: RowViews
}

describe('store helpers run on the caller clock alone', () => {
  let ctx: ScenarioEngine
  let early: Store
  const truths: Truth[] = []

  beforeAll(async () => {
    ctx = await startScenarioEngine(1)
    early = ctx.engine.getSnapshot()
    for (const ahead of AHEAD_MS) {
      const coarseNow = early.coarseNow + ahead
      ctx.advanceClock(coarseNow - ctx.engine.getSnapshot().coarseNow)
      const advanced = ctx.engine.getSnapshot()
      expect(advanced.coarseNow).toBe(coarseNow)
      const locals = { selectedIssueId: null, coarseNow }
      truths.push({
        locals,
        snapshot: snapshotFromStore(advanced, locals),
        views: rowViewsFromStore(advanced, locals),
      })
    }
  }, 60_000)

  afterAll(() => ctx.engine.destroy())

  it('control: deriving at the store clock and projecting at the caller clock differs from the truth', () => {
    const twoClocks = legacyDerivationFromStore(early)
    const at = (truth: Truth): string => `+${(truth.locals.coarseNow - early.coarseNow) / HOUR}h`
    const snapshots = truths.filter(
      (truth) =>
        JSON.stringify(projectSnapshot(twoClocks, truth.locals)) !== JSON.stringify(truth.snapshot),
    )
    const views = truths.filter(
      (truth) =>
        JSON.stringify(projectRowViews(twoClocks, truth.locals)) !== JSON.stringify(truth.views),
    )
    console.info(
      `[one-clock] two clocks differ from the truth: snapshot at [${snapshots.map(at).join(', ')}], row views at [${views.map(at).join(', ')}]`,
    )
    expect(views.length).toBeGreaterThan(0)
  })

  it('snapshotFromStore at a clock ahead of the store equals the store advanced there', () => {
    for (const truth of truths) {
      expect(early.coarseNow).not.toBe(truth.locals.coarseNow)
      expect(snapshotFromStore(early, truth.locals)).toEqual(truth.snapshot)
    }
  })

  it('rebuiltSnapshotFromStore at a clock ahead of the store equals the store advanced there', () => {
    for (const truth of truths) {
      expect(rebuiltSnapshotFromStore(early, truth.locals)).toEqual(truth.snapshot)
    }
  })

  it('rowViewsFromStore at a clock ahead of the store equals the store advanced there', () => {
    for (const truth of truths) {
      expect(rowViewsFromStore(early, truth.locals)).toEqual(truth.views)
    }
  })
})

describe('snapshot helpers on a row whose visibility the derivation clock decides', () => {
  const UNREAD_WINDOW_MS = 7 * 24 * HOUR
  let ctx: ScenarioEngine
  let early: Store
  let planted: string
  let later: SliceLocals
  let truth: SliceSnapshot

  beforeAll(async () => {
    ctx = await startScenarioEngine(1)
    const now = ctx.engine.getSnapshot().coarseNow
    const visible = oracleIds(ctx.engine.getSnapshot())
    // By rule: the first visible human child, made finished and unread one
    // hour inside the window, its sessions archived (so none keeps it listed).
    const candidate = ctx.corpus.issues.find(
      (issue) =>
        visible.has(issue.id) &&
        !!issue.parentId &&
        (issue as { audience?: string }).audience === 'human',
    )
    if (candidate === undefined) throw new Error('[one-clock] no visible human child')
    planted = candidate.id
    const sessions = ctx.corpus.sessions.filter((session) => session.issueId === planted)
    const closedAt = new Date(now - UNREAD_WINDOW_MS + HOUR).toISOString()
    const wire = ctx.cache.read('issueProjection', planted)?.value as object
    const projection = ctx.cache.read('issueProjection', planted)?.value as object
    ctx.replica.batch(() => {
      upsertIssue(ctx, planted, {
        ...wire,
        stage: 'done',
        closedAt,
        closedReason: 'done',
        readAt: null,
        unread: true,
      })
      for (const session of sessions) {
        const row = ctx.cache.read('session', session.sessionId)?.value as object
        upsert(ctx, 'session', session.sessionId, { ...row, archived: true })
      }
    })
    await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
    early = ctx.engine.getSnapshot()
    later = { selectedIssueId: null, coarseNow: early.coarseNow + 2 * HOUR }
    ctx.advanceClock(2 * HOUR)
    truth = snapshotFromStore(ctx.engine.getSnapshot(), later)
  }, 60_000)

  afterAll(() => ctx.engine.destroy())

  it('the planted row is on the list at the store clock and off it two hours later', () => {
    expect(oracleIds(early).has(planted)).toBe(true)
    expect(planted in truth.rowsById).toBe(false)
  })

  it('control: the two-clock composition still shows the planted row', () => {
    expect(planted in projectSnapshot(legacyDerivationFromStore(early), later).rowsById).toBe(true)
  })

  it('snapshotFromStore at the later clock equals the store advanced there', () => {
    expect(snapshotFromStore(early, later)).toEqual(truth)
  })

  it('rebuiltSnapshotFromStore at the later clock equals the store advanced there', () => {
    expect(rebuiltSnapshotFromStore(early, later)).toEqual(truth)
  })
})

function oracleIds(store: Store): Set<string> {
  return new Set(Object.keys(oracleSnapshot(store).rowsById))
}
