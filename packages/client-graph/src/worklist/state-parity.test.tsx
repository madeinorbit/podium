// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { observer } from 'mobx-react-lite'
import { autorun, runInAction } from 'mobx'
import { expect, it, vi } from 'vitest'
import { MobxPool } from '../pool'
import { headerView } from '../header-views'
import { navigationActivity } from '../navigation-activity'
import { foldedBefore, worktreeBefore } from './heartbeat-before'
import { MobileSectionsBefore } from './mobile-before'
import { worklistView } from './view-model'
import { sidebarView } from './sidebar'
import { LOADING } from './rollup'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const stamp = '2026-10-08T12:00:00Z'
const issue = (id: string, patch: object = {}) => ({ id, seq: 1, title: id, stage: 'planning',
  audience: 'human', repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp, ...patch })
const session = (id: string, owner: string | null, patch: object = {}) => ({ sessionId: id, issueId: owner,
  cwd: '/synthetic', agentKind: 'codex', status: 'live', archived: false, lastActiveAt: stamp,
  agentState: { phase: 'working', since: stamp }, ...patch })
function fixture() {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [
    ...['root', 'other', 'third'].map(id => ({ kind: 'issue' as const, id, value: issue(id) })),
    { kind: 'session', id: 'seat', value: session('seat', 'root') as never },
    { kind: 'session', id: 'unrelated', value: session('unrelated', 'other') as never },
    { kind: 'worktree', id: '/loose', value: { path: '/loose', repoPath: '/synthetic', repoName: 'Synthetic', branch: 'loose' } as never },
    ...Array.from({ length: 8 }, (_, index) => ({ kind: 'session' as const, id: `loose-${index}`,
      value: session(`loose-${index}`, null, { cwd: '/loose', agentState: { phase: 'needs_user', since: stamp } }) as never })),
  ] })
  return pool
}

it('a selection click redraws only the previous and next selected rows', async () => {
  const pool = fixture(), view = worklistView(pool), counts = new Map<string, number>()
  const Row = observer(({ id }: { id: string }) => {
    counts.set(id, (counts.get(id) ?? 0) + 1)
    return <button data-id={id} aria-pressed={view.row(pool.issueObject(id)).selected}
      onClick={() => view.select(id)}>{id}</button>
  })
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<>{['root', 'other', 'third'].map(id => <Row key={id} id={id} />)}</>))
    expect([...counts.values()]).toEqual([1, 1, 1])
    await act(async () => container.querySelector<HTMLButtonElement>('[data-id="other"]')!.click())
    expect([...counts.entries()]).toEqual([['root', 2], ['other', 2], ['third', 1]])
    expect(container.querySelector('[data-id="root"]')!.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('[data-id="other"]')!.getAttribute('aria-pressed')).toBe('true')
  } finally { await act(async () => root.unmount()); pool.dispose() }
})

it('matches folded counts, activity and roster order before and after a heartbeat', () => {
  const pool = fixture(), tree = worklistView(pool).tree(pool.model('worktree', '/loose')!)
  const check = () => {
    const actual = headerView(pool).folded(), expected = foldedBefore(pool, 'root')
    expect(process.env.POD5822_MUTATE === '1' ? { ...actual, live: -1 } : actual).toEqual(expected)
    const before = worktreeBefore(pool, '/loose')!, after = sidebarView(pool).worktree('/loose')!
    for (const field of ['sessions', 'visible', 'stale'] as const) {
      const ids = after[field].map(session => session.sessionId)
      expect(process.env.POD5822_MUTATE === '1' ? ['wrong'] : ids).toEqual(before[field].map(session => session.sessionId))
    }
    expect(after.activityAt).toBe(before.activityAt)
  }
  const stop = autorun(() => { void headerView(pool).folded(); void tree.sessions; void tree.stale; void navigationActivity(pool).activityAt('root') })
  try {
    check()
    const sorts = vi.spyOn(Array.prototype, 'sort'), open = vi.spyOn(pool.sessionObject('seat'), 'open', 'get')
    try {
      runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'unrelated',
        value: session('unrelated', 'other', { lastActiveAt: '2026-10-08T12:01:00Z' }) as never }] }))
      expect(sorts).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
    } finally { sorts.mockRestore(); open.mockRestore() }
    check()
    runInAction(() => pool.apply({ type: 'update', rows: [{ kind: 'session', id: 'seat',
      value: session('seat', 'root', { lastActiveAt: '2026-10-08T12:01:00Z' }) as never }] }))
    check()
    expect(navigationActivity(pool).activityAt('root')).toBe('2026-10-08T12:01:00Z')
  } finally { stop(); pool.dispose() }
})

it('the lazy phone sections match the old keyed sections through fold and selection changes', () => {
  const pool = fixture(), view = worklistView(pool)
  try {
    for (const layout of [{}, { collapsed: { 'podium:sidebar:work-group-fold:/synthetic': true } }, { searching: true }]) {
      view.setLayout(layout)
      const old = new MobileSectionsBefore(pool, layout).value.get(), answer = view.mobileSections()
      const expected = { ...old, sections: old.sections.map(section => ({ ...section, data: section.data.map(ref => ref.id) })),
        orderingSections: old.orderingSections.map(section => ({ ...section, data: section.data.map(ref => ref.id) })) }
      expect(process.env.POD5822_MUTATE === '1' ? { ...answer, issueCount: -1 } : answer).toEqual(expected)
    }
    expect(view.mobileRow({ id: 'root', kind: 'issue' })).not.toBe(LOADING)
  } finally { pool.dispose() }
})
