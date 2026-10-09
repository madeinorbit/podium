import { mobileWorkView } from '@podium/client-graph/worklist/mobile'
import { headerView } from '@podium/client-graph/header-views'
import type { IssueViewModel } from '@podium/client-core/replica'
/** Pool-only regressions for the final green mobile slice controls.
 * The literal counts, titles, paths, shared clock and machine refusals are
 * unchanged. The real provider owns the replica and all mutation handles. */

import { useStoreHandle } from '@podium/client-core/react'
import { machineViewsFromWire, resolveSpawnTargetMachine } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph/pool'
import type { GitRepositoryWire, MachineWire, SessionMeta } from '@podium/model'
import { asIssueId, asSessionId } from '@podium/model'
import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useConnected, useIssues, useSessions, useStoreActions } from './hooks'
import { useMobilePoolProjection } from './mobile-pool'
import { renderWithMobileStore } from './test-support'
import { useLaunchInputs } from './use-launch-inputs'

afterEach(cleanup)

const REPO: GitRepositoryWire = {
  path: '/home/dev/podium',
  kind: 'repository',
  branch: 'main',
  repoId: 'repo_podium',
  machineId: 'mine',
  // A SECOND checkout, deliberately, and not the repo's own path. The repo half
  // of the slice contributes through `allWorktreePaths`, and a repo with no
  // worktrees makes that half unobservable — a mutant feeding `sidebarSections`
  // an empty repo list stayed silent against the first version of this fixture.
  // (Listing the repo's OWN path here is worse than useless: `reposToViews`
  // reads that as the standalone-duplicate case and drops the repo entirely.)
  worktrees: [{ path: '/home/dev/podium-wt', branch: 'feature' }],
} as unknown as GitRepositoryWire

function issue(
  overrides: Omit<Partial<IssueViewModel>, 'id'> & { id: string; title: string },
): IssueViewModel {
  return {
    seq: 1,
    stage: 'in_progress',
    type: 'feature',
    audience: 'human',
    archived: false,
    pinned: false,
    priority: 2,
    repoPath: REPO.path,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
    id: asIssueId(overrides.id),
  } as unknown as IssueViewModel
}

function session(
  overrides: Omit<Partial<SessionMeta>, 'sessionId'> & { sessionId: string },
): SessionMeta {
  return {
    agentKind: 'claude-code',
    cwd: REPO.path,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-01T10:00:00.000Z',
    lastActiveAt: '2026-08-01T10:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    ...overrides,
    sessionId: asSessionId(overrides.sessionId),
  } as unknown as SessionMeta
}

/** A probe that reads exactly what a ported screen reads. */
function WorklistProbe() {
  const rows = useMobilePoolProjection(readRows, '')
  const now = useMobilePoolProjection(readNow, 0)
  const store = useStoreHandle().access
  const { repo } = useLaunchInputs(REPO.path)
  const sessions = useSessions()
  const issues = useIssues()
  const connected = useConnected()
  const paths = [...new Set(repo ? [repo.path, ...repo.worktrees.map((tree) => tree.path)] : [])]
  return (
    <div>
      <span data-testid="rows">{rows}</span>
      <span data-testid="counts">{`${sessions.length}/${issues.length}`}</span>
      <span data-testid="worktrees">{paths.join('|')}</span>
      <span data-testid="now">{String(now)}</span>
      <span data-testid="store-now">{String(store.coarseNow)}</span>
      <span data-testid="connected">{String(connected)}</span>
    </div>
  )
}

function readRows(pool: MobxPool) {
  return mobileWorkView(pool)
    .mobileSections()
    .sectionKeys.map(key => mobileWorkView(pool).mobileSections().section(key)).flatMap((section) =>
      section.data.flatMap((ref) => {
        const row = mobileWorkView(pool).mobileRow({ id: ref, kind: pool.tables.worktree.has(ref) ? 'worktree' : 'issue' })
        return row && typeof row !== 'symbol' ? [row.title] : []
      }),
    )
    .join('|')
}
function readNow(pool: MobxPool) {
  const now = pool.clock.current
  pool.clock.reached(now)
  pool.clock.reached(now + 1)
  return now
}

describe('mobile reads the resident pool worklist', () => {
  it('paints the accepted rows and paths through the pool', async () => {
    await renderWithMobileStore(<WorklistProbe />, {
      repos: [REPO],
      issues: [issue({ id: 'iss-open', title: 'Open work' })],
      sessions: [session({ sessionId: 'sess-1', issueId: asIssueId('iss-open') })],
    })

    expect(screen.getByTestId('counts').textContent).toBe('1/1')
    expect(screen.getByTestId('rows').textContent).toContain('Open work')
    // THE REPO HALF, asserted separately because it is separately mutable: rows
    // come from ISSUES, while the project tree comes from the machine-scoped
    // REPO list (`reposVisibleOnMachines`, POD-407). A mutant feeding
    // `sidebarSections` an empty repo list left every row assertion green.
    expect(screen.getByTestId('worktrees').textContent).toBe('/home/dev/podium|/home/dev/podium-wt')
  })

  it('and the same probe reads EMPTY over an empty world — so the case above is not vacuous', async () => {
    await renderWithMobileStore(<WorklistProbe />, { repos: [REPO] })
    expect(screen.getByTestId('counts').textContent).toBe('0/0')
    expect(screen.getByTestId('rows').textContent).toBe('')
  })

  it('uses the provider shared clock for the pool', async () => {
    await renderWithMobileStore(<WorklistProbe />, { repos: [REPO] })
    expect(screen.getByTestId('now').textContent).toBe(screen.getByTestId('store-now').textContent)
  })
})

describe('placement fails closed on the phone too (doc §3.1.4 M5)', () => {
  // These cases vary authorization and liveness on machines assigned to run agents.
  // Without the assignment, structural eligibility correctly reports `incapable`.
  const serviceAssignment = { server: false, agentExecution: true }
  const MACHINES: MachineWire[] = [
    { id: 'mine', name: 'mine', online: true, use: 'granted', serviceAssignment },
    { id: 'theirs', name: 'theirs', online: true, use: 'denied', serviceAssignment },
    { id: 'asleep', name: 'asleep', online: false, use: 'granted', serviceAssignment },
  ] as unknown as MachineWire[]

  const repoOn = (ids: string[]) =>
    ({
      path: REPO.path,
      name: 'podium',
      worktrees: [],
      machines: ids.map((machineId) => ({ machineId, path: REPO.path })),
    }) as never

  it('never resolves onto a machine this principal may not use', () => {
    const views = machineViewsFromWire(MACHINES)
    const { machineId, refusal } = resolveSpawnTargetMachine(repoOn(['theirs']), [], views)
    expect(machineId).toBeUndefined()
    expect(refusal).toBe('unauthorized')
  })

  it('says UNREACHABLE — a different word — when the only usable machine is offline', () => {
    const views = machineViewsFromWire(MACHINES)
    const { refusal } = resolveSpawnTargetMachine(repoOn(['asleep']), [], views)
    expect(refusal).toBe('unreachable')
  })

  it('SINGLE-USER PARITY: a list with no `use` decision at all stays fully usable', () => {
    // The regression guard for the whole programme. `use` is optional and an
    // omission means NOT EVALUATED, read per LIST — reading it per machine as
    // denied-when-absent blanks every picker on today's deployments.
    const unscoped = [
      { id: 'mine', name: 'mine', online: true, serviceAssignment },
    ] as unknown as MachineWire[]
    const views = machineViewsFromWire(unscoped)
    expect(views[0]?.availability).toBe('available')
    expect(resolveSpawnTargetMachine(repoOn(['mine']), [], views).machineId).toBe('mine')
  })
})

it('updates pool host metrics without waking stable action owners', async () => {
  let broadRenders = 0
  function BroadReader() {
    useStoreActions()
    broadRenders++
    return null
  }
  function HostReader() {
    const metrics = useMobilePoolProjection(readMetrics, [])
    return <span data-testid="hosts">{metrics.map((host) => host.hostname).join(',')}</span>
  }
  const { emit } = await renderWithMobileStore(
    <>
      <BroadReader />
      <HostReader />
    </>,
  )
  const before = broadRenders
  for (const hostname of ['first', 'second']) {
    await act(async () => emit('hostMetrics', [{ hostname, machineId: 'synthetic-host' }]))
    expect(screen.getByTestId('hosts').textContent).toBe(hostname)
  }
  expect(broadRenders).toBe(before)
})

function readMetrics(pool: MobxPool) {
  return headerView(pool).metrics()
}
