import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import { lazyKeptCount } from '@podium/mobx-helpers'
import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { MissionScreen } from './mission-screen'
import type { MissionDeckIssueModel } from './mission-view'
import { MobxPool } from './pool'

const stamp = '2026-10-07T12:00:00Z'
const gc = () => (globalThis as unknown as { Bun: { gc(force: boolean): void } }).Bun.gc(true)
const turns = async () => { for (let turn = 0; turn < 10; turn++) await new Promise<void>(resolve => setTimeout(resolve, 0)) }
async function reachable(held: WeakRef<object>[]): Promise<number> {
  let remaining = held.length
  // JSC can conservatively retain the last mounting stack. Give collections
  // and weak reads separate jobs, with a finite limit. A real owner still
  // retains its targets through this same probe (the negative control below).
  for (let attempt = 0; attempt < 20; attempt++) {
    await turns()
    await new Promise<void>(resolve => setTimeout(() => { gc(); resolve() }, 0))
    remaining = await new Promise<number>(resolve => setTimeout(() => {
      resolve(held.filter(ref => ref.deref() !== undefined).length)
    }, 0))
    if (remaining === 0) return 0
  }
  return remaining
}

function missionPool() {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  attachMissionTestPreferences(pool)
  const issue = (id: string, seq: number, parentId: string | null, stage = 'in_progress') => ({
    kind: 'issue' as const, id, value: { id, seq, title: id, stage, audience: 'human', parentId,
      deps: [], repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, readAt: stamp },
  })
  const session = (sessionId: string, issueId: string, archived = false) => ({
    kind: 'session' as const, id: sessionId, value: { sessionId, issueId, cwd: '/synthetic', title: sessionId,
      name: sessionId, agentKind: 'codex', status: archived ? 'exited' : 'running', archived, createdAt: stamp,
      lastActiveAt: stamp, readAt: stamp, unread: false },
  })
  pool.apply({ type: 'replace', rows: [
    issue('root', 1, null), issue('a', 2, 'root'), issue('b', 3, 'root'), issue('a1', 4, 'a'),
    issue('p', 5, 'root', 'proposed'),
    session('s-root', 'root'), session('s-a', 'a'), session('s-b', 'b'), session('s-old', 'root', true),
  ] })
  return pool
}

/** Open the mission, draw what the deck draws, then close it. */
function openAndClose(pool: MobxPool, held: WeakRef<object>[], owner?: MissionScreen[]): void {
  const screen = new MissionScreen(pool, 'root', { sessionName: session => session.name ?? '' })
  screen.open()
  let rows: readonly MissionDeckIssueModel[] = []
  const stop = autorun(() => {
    if (!screen.ready) return
    rows = screen.visibleRows
    for (const row of screen.rows) {
      void row.title; void row.displayRef; void row.presentation; void row.unread(false)
      void row.sessionIds(screen.mode); void row.collapsedSummary.tasks
    }
    void screen.progress; void screen.archivedCount; void screen.rootTitle; void screen.continuation
    void screen.agentHosts; void screen.proposedRows; void screen.allFolded
    screen.setQuery('a')
    void screen.visibleRows
  })
  expect(screen.ready).toBe(true)
  expect(rows.length).toBeGreaterThan(0)
  held.push(new WeakRef(screen), new WeakRef(screen.reader), new WeakRef(screen.deck), ...screen.rows.map(row => new WeakRef(row)))
  stop()
  screen.close()
  owner?.push(screen)
}

it('opening and closing a mission 50 times leaves no view model or companion reachable', async () => {
  const pool = missionPool()
  try {
    const kept = () => ['root', 'a', 'b', 'a1', 'p'].reduce((sum, id) => sum + lazyKeptCount(pool.issueObject(id)), 0)
    const first: WeakRef<object>[] = []
    // Release the mounting stack before the collection probe: JSC's
    // conservative stack scan can retain the most recent synchronous call.
    await new Promise<void>(resolve => setTimeout(() => { openAndClose(pool, first); resolve() }, 0))
    const afterOne = await reachable(first)
    const keptAfterOne = kept()
    const many: WeakRef<object>[] = []
    for (let opening = 0; opening < 50; opening++)
      await new Promise<void>(resolve => setTimeout(() => { openAndClose(pool, many); resolve() }, 0))
    expect(many.length).toBeGreaterThan(50 * 4)
    // Flat: fifty openings leave no more reachable than one, and one leaves none.
    const afterMany = await reachable(many)
    console.info('[mission lifetime]', JSON.stringify({ openings: 50, afterOne, afterMany, keptAfterOne, keptAfterMany: kept() }))
    if (afterMany) console.info('[mission lifetime targets]', JSON.stringify(many.flatMap((ref, index) => {
      const value = ref.deref()
      return value ? [{ opening: Math.floor(index / (many.length / 50)), kind: value.constructor.name }] : []
    })))
    expect(afterMany).toBe(afterOne)
    expect(afterOne).toBe(0)
    expect(kept()).toBe(keptAfterOne)
  } finally { pool.dispose() }
}, 120_000)

it('a view model still held after close is the leak this test would see', async () => {
  // The guard is armed: an owner that keeps its openings (as the principal-owned
  // reader kept its decks) leaves every one of them reachable.
  const pool = missionPool()
  try {
    const held: WeakRef<object>[] = []
    const owner: MissionScreen[] = []
    for (let opening = 0; opening < 5; opening++) openAndClose(pool, held, owner)
    expect(await reachable(held)).toBeGreaterThanOrEqual(5 * 3)
    expect(owner).toHaveLength(5)
  } finally { pool.dispose() }
}, 120_000)
