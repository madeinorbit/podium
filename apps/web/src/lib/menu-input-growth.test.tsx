import type { SessionView } from '@podium/client-core/session-values'
import { MobxPool, LOADING, type MobxPool as Pool } from '@podium/client-graph'
import { headerEntities } from '@podium/client-graph/header-entities'
import { missionView, readMissionActionInputs } from '@podium/client-graph/mission-view'
import { MISSION_VIEW_SUMMARIES } from '@podium/client-graph/mission-view-schema'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { asIssueId, asMachineId, asRepoId, asSessionId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import { afterEach, expect, it, vi } from 'vitest'
import { insideArm, measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { PoolIssueContextMenu } from '@/features/issues/issue-menu-pool-inputs'
import { createPoolWorkActions } from '@/features/worklist/use-pool-unified-work'
import { makeIssue } from './test-issue'
import { PoolSessionContextMenu } from './PoolSessionContextMenu'

const f = vi.hoisted(() => ({ pool: null as Pool | null, handoff: vi.fn(async () => ({})) }))
vi.mock('@podium/client-core/react', () => {
  const owner = { access: { trpc: { sessions: { handoff: { mutate: f.handoff } } } } }
  return { useStoreHandle: () => owner }
})
vi.mock('@/lib/use-feature', () => ({ useFeature: () => true }))
vi.mock('@/lib/hooks/use-session-guard', () => ({ useSessionGuard: () => ({}) }))
vi.mock('@/lib/hooks/use-confirm', () => ({ useConfirm: () => vi.fn() }))
vi.mock('@/app/store-worklist-pool', async () => {
  const { useMemo, useSyncExternalStore, useEffect } = await import('react')
  const { createPoolProjection } = await import('@podium/client-graph/runtime-pool')
  const subscribe = () => () => {}
  return {
    useWorklistPool: () => f.pool,
    useWorklistPoolProjection<T>(read: (pool: Pool) => T, empty: T): T {
      const pool = f.pool
      const projection = useMemo(() => pool ? createPoolProjection(pool, read) : null, [pool, read])
      useEffect(() => () => projection?.dispose(), [projection])
      return useSyncExternalStore(projection?.subscribe ?? subscribe, () => projection?.getSnapshot() ?? empty)
    },
  }
})

const stamp = '2026-10-06T12:00:00Z'
const sourceId = asMachineId('source')
const targetId = asMachineId('target')
const sessionId = asSessionId('subject')
const issueId = asIssueId('opened')
const anchor = { x: 10, y: 10 }
const noop = () => {}
const machine = (id: string) => ({
  id: asMachineId(id), name: id, hostname: id, online: true, lastSeenAt: stamp,
  serviceAssignment: { server: false, agentExecution: true },
  availability: { epoch: 'boot', server: false, daemon: true, supervisor: true },
  inventory: { os: 'linux' as const, arch: 'x64' as const, tools: [], agents: [{ kind: 'codex' as const, installed: true, login: { state: 'in' as const } }] },
})
function fixture(scale: number) {
  const subject: SessionView = {
    sessionId, issueId, machineId: sourceId, cwd: '/repo/.worktrees/opened', title: 'Subject',
    agentKind: 'codex', harnessHandoff: true, status: 'live', archived: false, unread: false,
    controllerId: null, geometry: { cols: 80, rows: 24 }, epoch: 0, clientCount: 0,
    origin: { kind: 'spawn' }, readAt: null, createdAt: stamp, lastActiveAt: stamp,
  }
  const hidden = Array.from({ length: 32 * scale }, (_, i): SessionView => ({
    ...subject, sessionId: asSessionId(`hidden-${i}`), agentKind: 'shell', harnessHandoff: false,
  }))
  const issue = makeIssue({ id: issueId, memberSessionIds: [sessionId, ...hidden.map(row => row.sessionId)],
    worktreePath: subject.cwd, branch: 'issue/opened', audience: 'agent', stage: 'in_progress' })
  const payloads = new Map<string, object>([
    [`issue:${issueId}`, issue], ...[subject, ...hidden].map(row => [`session:${row.sessionId}`, row] as const),
  ])
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }, undefined, {
    summaries: MISSION_VIEW_SUMMARIES, load: (kind, id) => payloads.get(`${kind}:${id}`), schedule: () => () => {},
  })
  pool.apply({ type: 'replace', rows: [
    { kind: 'issue', id: issueId, value: issue },
    ...[subject, ...hidden].map(row => ({ kind: 'session' as const, id: row.sessionId, value: row })),
  ] })
  headerEntities(pool).apply([
    { kind: 'repository', id: 'source-repo', value: { kind: 'repository', path: '/repo',
      machineId: sourceId, repoId: asRepoId('registered'), originUrl: 'https://example.test/repo.git',
      worktrees: [{ path: subject.cwd, branch: 'issue/opened' },
        ...Array.from({ length: 32 * scale }, (_, i) => ({ path: `/repo/.worktrees/hidden-${i}`, branch: `hidden-${i}` }))] } },
    ...Array.from({ length: 32 * scale }, (_, i) => ({ kind: 'repository' as const, id: `other-repo-${i}`,
      value: { kind: 'repository' as const, path: `/other-${i}`, machineId: sourceId, worktrees: [] } })),
    ...['source', 'target', 'other-target'].map(id => ({ kind: 'machine' as const, id, value: machine(id) })),
  ])
  headerEntities(pool).order('machine', ['source', 'target', 'other-target'])
  pools.push(pool)
  return { pool, issue }
}
const pools: Pool[] = []
afterEach(() => { cleanup(); for (const pool of pools.splice(0)) pool.dispose(); f.pool = null; f.handoff.mockClear(); vi.restoreAllMocks() })

function MissionIssueMenu({ issue }: { issue: ReturnType<typeof makeIssue> }) {
  const read = useCallback((pool: Pool) => readMissionActionInputs(missionView(pool), [issue.id]), [issue.id])
  const values = useWorklistPoolProjection(read, LOADING)
  return values === LOADING ? null : <IssueContextMenu issues={values.issues} allIssues={values.allIssues}
    anchor={anchor} onClose={noop} poolInputs={values} />
}

const SidebarIssueMenu = observer(function SidebarIssueMenu({ issue }: { issue: ReturnType<typeof makeIssue> }) {
  const data = createPoolWorkActions(f.pool!, { access: {} } as never, noop).resolveMenuData(issue.id)
  return data.poolInputs === LOADING ? null : <IssueContextMenu issues={data.single} allIssues={data.all}
    anchor={anchor} onClose={noop} poolInputs={data.poolInputs} />
})

it('measures opened menu and handoff inputs at 1x and 4x hidden data', async () => {
  type Window = Awaited<ReturnType<typeof measureWork>>['work'] & {
    payloads: Record<string, { count: number; sample: string[] }>
  }
  const report: Array<{ kind: string; scale: number; shownCandidates: number; windows: Record<string, Window> }> = []
  for (const kind of ['issue', 'sidebar-issue', 'mission-issue', 'session'] as const) {
    for (const scale of [1, 4]) {
      const { pool, issue } = fixture(scale)
      if (kind === 'sidebar-issue') vi.spyOn(sidebarView(pool), 'row').mockImplementation(() => {
        throw new Error('Menu borrowed the sidebar display roster')
      })
      f.pool = pool
      const windows: Record<string, Window> = {}
      const probe = async (name: string, action: () => void) => {
        const reads: Record<string, Set<string>> = {}
        const row = vi.spyOn(pool, 'row')
        const { work } = await measureWork(async () => {
          await act(async () => { insideArm(action); pool.hydrate() })
        }, { pool })
        for (const [entity, id] of row.mock.calls) (reads[entity] ??= new Set()).add(id)
        row.mockRestore()
        windows[name] = { ...work, payloads: Object.fromEntries(Object.entries(reads).map(([key, ids]) => [key, { count: ids.size, sample: [...ids].slice(0, 5) }])) }
      }
      await probe('menu-open', () => {
        render(kind === 'session' ? <PoolSessionContextMenu sessionId={sessionId} anchor={anchor} onClose={noop} onRename={noop} />
          : kind === 'issue' ? <PoolIssueContextMenu issues={[issue]} allIssues={[issue]} anchor={anchor} onClose={noop} />
          : kind === 'sidebar-issue' ? <SidebarIssueMenu issue={issue} />
          : <MissionIssueMenu issue={issue} />)
      })
      const handoff = await screen.findByRole('menuitem', { name: /^Handoff/ })
      expect((handoff as HTMLButtonElement).disabled).toBe(false)
      expect(windows['menu-open']!.payloads.machine).toBeUndefined()
      expect(windows['menu-open']!.payloads.session).toMatchObject({ count: 1, sample: [sessionId] })
      expect(windows['menu-open']!.payloads.repository).toMatchObject({ count: 1, sample: ['source-repo'] })
      await probe('targets-open', () => fireEvent.click(handoff))
      const targetMenu = screen.getByRole('menu', { name: 'Handoff targets' })
      expect(within(targetMenu).getAllByRole('menuitem').map(row => row.textContent)).toEqual(['target', 'other-target'])
      await probe('candidate-update', () => headerEntities(pool).apply([{ kind: 'machine', id: targetId,
        value: { ...machine(targetId), online: false } }]))
      expect(within(targetMenu).getByRole('menuitem', { name: /target offline/ }).textContent).toContain('offline')
      await probe('heartbeat', () => headerEntities(pool).apply([{ kind: 'machine', id: targetId,
        value: { ...machine(targetId), online: false, lastSeenAt: '2026-10-06T12:01:00Z' } }]))
      const before = pool.row('session', sessionId) as SessionView
      await probe('sender-heartbeat', () => pool.apply({ type: 'update', rows: [{ kind: 'session', id: sessionId,
        value: { ...before, lastActiveAt: '2026-10-06T12:01:00Z' } }] }))
      fireEvent.click(within(targetMenu).getByRole('menuitem', { name: 'other-target' }))
      expect(f.handoff).toHaveBeenLastCalledWith({ sessionId, machineId: asMachineId('other-target') })
      report.push({ kind, scale, shownCandidates: 2, windows })
      cleanup()
      f.pool = null
    }
  }
  for (let index = 0; index < report.length; index += 2) {
    const one = report[index]!, four = report[index + 1]!
    for (const name of Object.keys(one.windows)) {
      expect(four.windows[name]!.rows, `${one.kind}/${name} row growth`).toBe(one.windows[name]!.rows)
      expect(four.windows[name]!.elements, `${one.kind}/${name} element growth`).toBe(one.windows[name]!.elements)
      expect(four.windows[name]!.derivations, `${one.kind}/${name} derivation growth`).toBe(one.windows[name]!.derivations)
    }
  }
  console.info('POD5649 menu input probes ' + JSON.stringify(report))
})
