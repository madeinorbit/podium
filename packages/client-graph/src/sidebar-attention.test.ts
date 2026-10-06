import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from './pool'
import { sidebarView } from './worklist/sidebar'
import { sidebarAttention, sidebarNested } from './worklist/sidebar-attention'

const stamp = '2026-10-05T12:00:00Z'
const old = '2026-01-01T00:00:00Z'
const issue = (id: string, patch: object = {}) => ({ id, seq: 1, title: id, stage: 'planning',
  audience: 'human', repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, ...patch })
const sender = (sessionId: string, patch: object = {}) => ({ sessionId, issueId: 'root',
  cwd: '/synthetic', agentKind: 'codex', status: 'exited', archived: true, lastActiveAt: old, ...patch })

for (const history of [32, 128]) {
  it(`reads the shown sidebar neighbourhood without enumerating ${history} archived members`, () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    pool.apply({ type: 'replace', rows: [
      { kind: 'issue', id: 'root', value: issue('root') },
      { kind: 'issue', id: 'child', value: issue('child', { parentId: 'root' }) },
      { kind: 'session', id: 'live', value: sender('live', { status: 'live', archived: false,
        lastActiveAt: stamp, agentState: { phase: 'working', since: stamp } }) as never },
      ...Array.from({ length: history }, (_, index) => ({ kind: 'session' as const,
        id: `old-${index}`, value: sender(`old-${index}`) as never })),
    ] })
    const root = pool.issue('root')!
    // Entity nesting takes every member. This screen must never demand it.
    const members = vi.spyOn(root, 'memberIds', 'get').mockImplementation(() => {
      throw new Error('Sidebar enumerated archived member history')
    })
    let value: ReturnType<ReturnType<typeof sidebarView>['row']>
    const stop = autorun(() => { value = sidebarView(pool).row('root') })
    try {
      expect(value!).toMatchObject({ working: true, aggregateSessionIds: ['live'], progress: { total: 1 } })
      expect(sidebarNested(root, pool)).toEqual(['child'])
      const read = vi.spyOn(pool, 'row')
      runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'live',
        value: sender('live', { status: 'live', archived: false, lastActiveAt: '2026-10-05T12:01:00Z',
          agentState: { phase: 'working', since: stamp } }) as never }] }))
      expect(value!).toMatchObject({ working: true, timing: { sinceMs: Date.parse(stamp) } })
      expect(read.mock.calls.some(([kind, id]) => kind === 'session' && id.startsWith('old-'))).toBe(false)
      expect(members).not.toHaveBeenCalled()
    } finally { stop(); members.mockRestore(); pool.dispose() }
  })
}

it('does not acquire a lane for the nested-child reader without a checkout', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'root', value: issue('root') }] })
  const root = pool.issue('root')!
  // Visibility owns its own member demand; isolate the screen's nesting read.
  const keepPresent = autorun(() => { void root.present })
  const lane = vi.spyOn(root, 'laneMemberIds', 'get')
  const stop = autorun(() => { expect(sidebarNested(root, pool)).toEqual([]) })
  try { expect(lane).not.toHaveBeenCalled() }
  finally { stop(); lane.mockRestore(); keepPresent(); pool.dispose() }
})

it('keeps unarchived exited starters, excludes archived/headless starters and follows archive changes', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: 'root', value: issue('root') },
    ...['exited', 'archived', 'headless'].map(id => ({ kind: 'issue' as const, id,
      value: issue(id, { startedBySession: `${id}-sender` }) })),
    ...['exited', 'archived', 'headless'].map(id => ({ kind: 'session' as const, id: `${id}-sender`,
      value: sender(`${id}-sender`, { archived: id === 'archived', headless: id === 'headless' }) as never })),
  ] })
  const root = pool.issue('root')!
  let ids: readonly string[] = []
  const stop = autorun(() => { ids = sidebarNested(root, pool) })
  try {
    expect(ids).toEqual(['exited'])
    expect(sidebarAttention(root, pool)).toEqual(root.aggregate)
    runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'archived-sender',
      value: sender('archived-sender', { archived: false }) as never }] }))
    expect(ids).toEqual(['archived', 'exited'])
    runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'exited-sender',
      value: sender('exited-sender') as never }] }))
    expect(ids).toEqual(['archived'])
  } finally { stop(); pool.dispose() }
})

it('keeps an unarchived exited issueless starter owned by the issue checkout', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [
    { kind: 'worktree', id: '/synthetic/lane', value: { path: '/synthetic/lane', repoPath: '/synthetic' } },
    { kind: 'issue', id: 'root', value: issue('root', { worktreePath: '/synthetic/lane' }) },
    { kind: 'issue', id: 'lane-child', value: issue('lane-child', { startedBySession: 'lane-sender' }) },
    { kind: 'session', id: 'lane-sender', value: sender('lane-sender', {
      issueId: undefined, cwd: '/synthetic/lane', archived: false,
    }) as never },
  ] })
  const root = pool.issue('root')!
  const stop = autorun(() => {
    expect(sidebarNested(root, pool)).toEqual(['lane-child'])
    expect(sidebarAttention(root, pool)).toEqual(root.aggregate)
  })
  try { expect(sidebarNested(root, pool)).toEqual(['lane-child']) }
  finally { stop(); pool.dispose() }
})
