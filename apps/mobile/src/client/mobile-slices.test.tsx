/**
 * MOBILE READS THE SHARED SLICES (POD-332).
 *
 * `MobileClientValue` is deleted, and the deletion is only worth anything if
 * what replaced it is the SAME derivation the web reads. These cases mount a
 * real `StoreProvider` (see `test-support.tsx` for why nothing here is mocked)
 * and assert against the published `worklistSlice` — the one
 * `apps/web/src/features/worklist` renders from.
 *
 * WHAT EACH CASE COULD FAIL TO PROVE, and how that is closed:
 *
 *  - "the slice paints" passes trivially over an empty world, so every positive
 *    case is paired with the count it must NOT have, and the fixtures carry
 *    rows a local derivation and a published one would both produce. The
 *    discriminating case is the LAST one: the slice's `now` must be the store's
 *    coarse clock rather than a private interval, which is invisible to any
 *    assertion about row contents.
 *  - placement is asserted through the REFUSAL arm (a machine the principal may
 *    not use), because the grant arm passes identically with no gate at all.
 */
import { asIssueId, asSessionId } from '@podium/model'
import type { GitRepositoryWire, IssueWire, MachineWire, SessionMeta } from '@podium/model'
import { useSlice } from '@podium/client-core/react'
import {
  machineViewsFromWire,
  resolveSpawnTargetMachine,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useConnected, useIssues, useMobileStore, useSessions } from './hooks'
import { renderWithMobileStore } from './test-support'

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

function issue(overrides: Omit<Partial<IssueWire>, 'id'> & { id: string; title: string }): IssueWire {
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
  } as unknown as IssueWire
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
  const slice = useSlice(worklistSlice)
  const store = useMobileStore()
  const sessions = useSessions()
  const issues = useIssues()
  const connected = useConnected()
  const titles = [...slice.pinned, ...slice.groups.flatMap((g) => g.rows)]
    .map((row) => (row.kind === 'issue' ? row.issue.title : row.worktree.path))
    .join('|')
  return (
    <div>
      <span data-testid="rows">{titles}</span>
      <span data-testid="counts">{`${sessions.length}/${issues.length}`}</span>
      <span data-testid="worktrees">{slice.allWorktreePaths.join('|')}</span>
      <span data-testid="now">{String(slice.now)}</span>
      <span data-testid="store-now">{String(store.coarseNow)}</span>
      <span data-testid="connected">{String(connected)}</span>
    </div>
  )
}

describe('mobile reads the published worklist slice', () => {
  it('paints rows the slice derived from the replica, not from a mobile-local derivation', async () => {
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

  it('reads its clock FROM the store, which is what stops two surfaces disagreeing', async () => {
    // The old screen ran a private `useNow(30_000)`, so its idea of "now" was
    // unrelated to every other reader's and a snooze could lapse on one surface
    // minutes before another. The slice carries the runtime's single coarse
    // clock, and the screen renders that value.
    //
    // WHAT THIS DOES NOT PROVE, stated rather than implied: it is an assertion
    // about the SLICE's clock, not about the absence of an interval in a
    // component. What retires that mechanism is that `hooks/useNow.ts` is
    // deleted — there is no longer a per-component clock on this platform to
    // reach for.
    await renderWithMobileStore(<WorklistProbe />, { repos: [REPO] })
    expect(screen.getByTestId('now').textContent).toBe(screen.getByTestId('store-now').textContent)
  })
})

describe('placement fails closed on the phone too (doc §3.1.4 M5)', () => {
  const MACHINES: MachineWire[] = [
    { id: 'mine', name: 'mine', online: true, use: 'granted' },
    { id: 'theirs', name: 'theirs', online: true, use: 'denied' },
    { id: 'asleep', name: 'asleep', online: false, use: 'granted' },
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
    const unscoped = [{ id: 'mine', name: 'mine', online: true }] as unknown as MachineWire[]
    const views = machineViewsFromWire(unscoped)
    expect(views[0]?.availability).toBe('available')
    expect(resolveSpawnTargetMachine(repoOn(['mine']), [], views).machineId).toBe('mine')
  })
})
