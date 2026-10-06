import { sidebarRosterView } from './sidebar-roster'
/**
 * POD-5423 (review finding 11): an issue publication re-files no session of
 * that issue's history. Whether a session is a roster candidate depends on its
 * own row and its worktree link (both queue it themselves) and on its owner's
 * filing (which re-files only the seats it owns), never on the issue row.
 */
import { expect, it, vi } from 'vitest'
import { autorun, runInAction } from 'mobx'
import { MobxPool } from '../pool'
import { insideReader, measureWork } from '../../../worklist-proto/harness/src/work-meter'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const LANE = '/synthetic/lane'

function corpus(scale: number) {
  const issue = (id: string, extra: Record<string, unknown>) => ({
    id,
    seq: id.length,
    title: id,
    repoPath: LANE,
    stage: 'in_progress',
    audience: 'human',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deps: [],
    ...extra,
  })
  const session = (id: string, issueId: string | null, cwd: string, exited: boolean) => ({
    sessionId: id,
    cwd,
    issueId,
    agentKind: 'codex',
    title: id,
    archived: false,
    status: exited ? 'exited' : 'live',
    createdAt: '2026-01-01T00:00:00Z',
    lastActiveAt: exited ? '2026-01-01T00:00:00Z' : '2026-10-03T11:59:00Z',
    ...(exited ? { stoppedAt: '2026-01-01T00:00:00Z' } : {}),
  })
  const closed = issue('closed-epic', {
    stage: 'done',
    closedAt: '2026-01-02T00:00:00Z',
    worktreePath: LANE,
  })
  const open = issue('open-epic', {})
  const history = Array.from({ length: 32 * scale }, (_, n) =>
    session(`closed-${n}`, closed.id, LANE, true),
  )
  // Resident members with no worktree link: the bucket holds them, no lane seats them.
  const elsewhere = Array.from({ length: 32 * scale }, (_, n) =>
    session(`open-${n}`, open.id, `/nowhere/${n}`, true),
  )
  const seated = session('unowned-seat', null, LANE, false)
  const rows = new Map<string, object>(
    [...history, ...elsewhere, seated].map((row) => [row.sessionId, row]),
  )
  for (const row of [closed, open]) rows.set(row.id, row)
  return { closed, open, history, elsewhere, seated, rows }
}

function measure(scale: number) {
  const { closed, open, history, elsewhere, seated, rows } = corpus(scale)
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW }, undefined, {
    load: (_kind, id) => rows.get(id) as never,
    schedule: () => () => {},
  })
  try {
    pool.apply({
      type: 'replace',
      rows: [
        {
          kind: 'worktree',
          id: LANE,
          value: { path: LANE, repoPath: LANE, repoName: 'Synthetic', projectIndex: 0 } as never,
        },
        ...[closed, open].map((value) => ({
          kind: 'issue' as const,
          id: value.id,
          value: value as never,
        })),
        ...[...history, ...elsewhere, seated].map((value) => ({
          kind: 'session' as const,
          id: value.sessionId,
          value: value as never,
        })),
      ],
    })
    expect(pool.tables.session.has(history[0]!.sessionId)).toBe(false)
    expect(pool.tables.session.has(elsewhere[0]!.sessionId)).toBe(true)
    const before = [...sidebarRosterView(pool).candidates(LANE)]
    const sync = vi.spyOn(sidebarRosterView(pool) as unknown as { sync(id: string): void }, 'sync')
    for (const value of [closed, open]) {
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'issue',
            id: value.id,
            value: { ...value, title: `${value.title} renamed` } as never,
          },
        ],
      })
    }
    const synced = sync.mock.calls.length
    sync.mockRestore()
    return { synced, before, after: [...sidebarRosterView(pool).candidates(LANE)] }
  } finally {
    pool.dispose()
  }
}

it('re-files none of an issue’s session history when the issue row is published', () => {
  const at1x = measure(1)
  const at4x = measure(4)
  expect(at1x.before).toEqual(['unowned-seat'])
  expect(at4x.after).toEqual(at4x.before)
  expect(at1x.after).toEqual(at1x.before)
  // Before POD-5423: 64 → 256 (every cold and unseated member, per publication).
  expect({ at1x: at1x.synced, at4x: at4x.synced }).toEqual({ at1x: 0, at4x: 0 })
})

it('derives sidebar ownership inside the applying action without refiling seats', () => {
  const owner = {
    id: 'owner', seq: 1, title: 'Owner', repoPath: LANE,
    stage: 'in_progress', audience: 'human', deps: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }
  const seat = {
    sessionId: 'seat', issueId: owner.id, agentKind: 'codex',
    cwd: LANE, title: 'Seat', status: 'live', archived: false,
    lastActiveAt: new Date(NOW).toISOString(),
  }
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  pool.apply({ type: 'replace', rows: [
    { kind: 'worktree', id: LANE, value: { path: LANE, repoPath: LANE, repoName: 'Lane' } as never },
    { kind: 'issue', id: owner.id, value: owner as never },
    { kind: 'session', id: seat.sessionId, value: seat as never },
  ] })
  const stop = autorun(() => { sidebarRosterView(pool).candidates(LANE) })
  const file = vi.spyOn(sidebarRosterView(pool) as unknown as { fileSeat(id: string): void }, 'fileSeat')
  try {
    expect(pool.graph.one('session', seat.sessionId, 'worktree')).toBe(LANE)
    expect(pool.issueObject(owner.id).placed).toBe(true)
    expect([...sidebarRosterView(pool).candidates(LANE)]).toEqual([])
    runInAction(() => {
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: owner.id, value: { ...owner, audience: 'agent' } as never }] })
      expect(pool.issueObject(owner.id).placed).toBe(false)
      expect([...sidebarRosterView(pool).candidates(LANE)]).toEqual(['seat'])
    })
    expect(file).not.toHaveBeenCalled()
    stop()
    file.mockClear()
    pool.apply({ type: 'update', rows: [{ kind: 'issue', id: owner.id, value: owner as never }] })
    expect(file).not.toHaveBeenCalled()
  } finally { file.mockRestore(); stop(); pool.dispose() }
})

/** Most resident paths have represented owners, so only the unowned path is
 * drawn. Evicting one owner adds its path without revisiting the other paths. */
async function evictionWork(scale: number, plant = false) {
  const group = '/synthetic/group'
  const paths = Array.from({ length: 32 * scale }, (_, n) => `/synthetic/seat-${String(n).padStart(3, '0')}`)
  const unowned = '/synthetic/unowned'
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: NOW })
  const issues = paths.map((path, n) => ({
    id: `owner-${n}`, seq: n + 1, title: `Owner ${n}`, repoPath: group,
    worktreePath: path, stage: 'in_progress', audience: 'human',
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
  }))
  pool.apply({ type: 'replace', rows: [
    ...[...paths, unowned].map(path => ({ kind: 'worktree' as const, id: path,
      value: { path, repoPath: group, repoName: 'Group' } as never })),
    ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value: value as never })),
    ...[...paths, unowned].map((cwd, n) => ({ kind: 'session' as const, id: `seat-${n}`,
      value: { sessionId: `seat-${n}`, cwd, issueId: issues[n]?.id ?? null,
        agentKind: 'codex', status: 'live', lastActiveAt: new Date(NOW).toISOString() } as never })),
  ] })
  const roster = sidebarRosterView(pool)
  const original = roster.band.bind(roster)
  const planted = plant ? vi.spyOn(roster, 'band').mockImplementation(key => ({
    ...original(key),
    ids: [...paths, unowned].filter(path => [...roster.candidates(path)].length > 0),
  })) : undefined
  let band!: ReturnType<typeof roster.band>
  const stop = autorun(() => { band = roster.band(group) })
  try {
    expect(band.ids).toEqual([unowned])
    const removed = await measureWork(async () => insideReader('sidebar eviction', () => {
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: issues[0]!.id, value: undefined }] })
    }), { pool })
    expect(band.ids).toEqual([paths[0], unowned])
    const restored = await measureWork(async () => insideReader('sidebar restore', () => {
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: issues[0]!.id, value: issues[0] as never }] })
    }), { pool })
    expect(band.ids).toEqual([unowned])
    // Additional seats change the path's roster, but not group membership.
    const before = band
    pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'another-unowned',
      value: { sessionId: 'another-unowned', cwd: unowned, issueId: null,
        agentKind: 'codex', status: 'live', lastActiveAt: new Date(NOW).toISOString() } as never }] })
    if (!plant) expect(band).toBe(before)
    stop()
    runInAction(() => {
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: issues[0]!.id, value: undefined }] })
      // An imperative read inside the action still sees the current facts.
      expect(roster.band(group).ids).toEqual([paths[0], unowned])
    })
    return { removed: removed.work.elements, restored: restored.work.elements }
  } finally { stop(); planted?.mockRestore(); pool.dispose() }
}

function assertAddressedRoster(first: Awaited<ReturnType<typeof evictionWork>>, second: Awaited<ReturnType<typeof evictionWork>>) {
  expect(second.removed, 'eviction work grows with unrelated paths').toBeLessThanOrEqual(first.removed)
  expect(second.restored, 'restore work grows with unrelated paths').toBeLessThanOrEqual(first.restored)
}

it('keeps observed group IDs addressed across eviction, restore and roster churn', async () => {
  assertAddressedRoster(await evictionWork(1), await evictionWork(4))
})

it('rejects a planted whole-group path filter on eviction', async () => {
  const first = await evictionWork(1, true)
  const second = await evictionWork(4, true)
  expect(() => assertAddressedRoster(first, second)).toThrow(/work grows with unrelated paths/)
})
