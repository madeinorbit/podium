import { headerEntities } from '@podium/client-graph/header-entities'
import { seedFixtureMachines } from '@podium/client-graph/live-fixture'
import { MobxPool } from '@podium/client-graph/pool'
import type { GitRepositoryWire } from '@podium/model'
import { asMachineId, asRepoId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { REF_PREFIXES_CHANGED_EVENT } from '@/lib/ref-activation'
import { ReposSection } from './repos'
import { SettingsControlsContext } from './shared'

const h = vi.hoisted(() => ({
  pool: null as unknown,
  setPrefix: vi.fn(async (_input: unknown) => []),
  remove: vi.fn(async (_input: unknown) => undefined),
  openTakeover: vi.fn(),
  closeTakeover: vi.fn(),
}))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => h.pool }))
vi.mock('@/features/settings/stable-access', () => ({
  useSettingsTrpc: () => ({
    repos: { setPrefix: { mutate: h.setPrefix }, remove: { mutate: h.remove } },
  }),
}))
vi.mock('@/lib/BaseBranchMenu', () => ({
  RepoBaseBranchMenu: () => null,
  usePodiumDefaultParentBranch: () => 'main',
}))

vi.mock('../settings-frame', () => ({
  useSettingsFrame: () => ({ openTakeover: h.openTakeover, closeTakeover: h.closeTakeover }),
  SettingsPageActions: ({ children }: { children: ReactNode }) => children,
}))

function Harness({ canManage }: { canManage: boolean }) {
  const [flow, setFlow] = useState<ReactNode>(null)
  h.openTakeover.mockImplementation(({ content }: { content: ReactNode }) => setFlow(content))
  h.closeTakeover.mockImplementation(() => setFlow(null))
  return (
    <SettingsControlsContext.Provider
      value={{ permitted: { 'records.instancePreferences.edit': canManage } }}
    >
      <div hidden={flow !== null}><ReposSection podiumDefault="main" /></div>
      {flow}
    </SettingsControlsContext.Provider>
  )
}

const ludovico = asMachineId('m-ludovico')
const flatblock = asMachineId('m-flatblock')
const podium = asRepoId('repo-podium')
const ORIGIN = 'git@github.com:acme/podium.git'

function mount(scans: GitRepositoryWire[] | null, canManage = true) {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.apply({
    type: 'update',
    rows: [
      {
        kind: 'repo',
        id: podium,
        value: {
          id: podium,
          prefix: 'POD',
          defaultParentBranch: null,
          path: '/src/podium',
        } as never,
      },
    ],
  })
  headerEntities(pool).apply([
    ...seedFixtureMachines(pool, [
      { id: ludovico, name: 'ludovico', online: true },
      { id: flatblock, name: 'flatblock', online: false },
    ] as never),
    ...(scans ?? []).map((value, i) => ({ kind: 'repository' as const, id: `scan${i}`, value })),
  ])
  if (scans)
    headerEntities(pool).order(
      'repository',
      scans.map((_, i) => `scan${i}`),
    )
  h.pool = pool
  render(<Harness canManage={canManage} />)
  return pool
}

const PODIUM: GitRepositoryWire[] = [
  // The offline machine's checkout sorts first; the write must not go through it.
  {
    kind: 'repository',
    machineId: flatblock,
    repoId: podium,
    originUrl: ORIGIN,
    path: '/home/u/podium',
    worktrees: [],
  },
  {
    kind: 'repository',
    machineId: ludovico,
    repoId: podium,
    originUrl: ORIGIN,
    path: '/src/podium',
    branch: 'main',
    worktrees: [{ path: '/src/podium-12', branch: 'pod-12' }],
  },
  {
    // The scanner's own scan of the root's worktree: the root's remote, no repo id.
    kind: 'worktree',
    machineId: ludovico,
    originUrl: ORIGIN,
    path: '/src/podium-12',
    branch: 'pod-12',
    worktrees: [],
  },
]

afterEach(() => {
  cleanup()
  ;(h.pool as MobxPool | null)?.dispose()
  h.pool = null
  h.setPrefix.mockClear()
  h.remove.mockClear()
  h.openTakeover.mockClear()
  h.closeTakeover.mockClear()
})

function openProject() {
  fireEvent.click(screen.getByTestId('settings-repo-row'))
}

it('opens a project detail with machine checkouts and worktrees on request', () => {
  mount(PODIUM)
  expect(screen.getAllByTestId('settings-repo-row')).toHaveLength(1)
  expect(screen.getByText('2 checkouts')).toBeTruthy()
  expect(screen.queryByText('github.com/acme/podium')).toBeNull()
  openProject()
  expect(screen.getByText('github.com/acme/podium')).toBeTruthy()
  expect(screen.getByText('flatblock')).toBeTruthy()
  expect(screen.getByText('ludovico')).toBeTruthy()
  expect(screen.getByText('Online')).toBeTruthy()
  expect(screen.getByText('Offline')).toBeTruthy()
  expect(screen.queryByText('pod-12')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
  expect(screen.getByText('pod-12')).toBeTruthy()
})

it('saves a new prefix through an online checkout and tells the ref links to refetch', async () => {
  mount(PODIUM)
  const refetch = vi.fn()
  window.addEventListener(REF_PREFIXES_CHANGED_EVENT, refetch)
  try {
    openProject()
    fireEvent.change(screen.getByTestId('repo-prefix-input'), { target: { value: 'pd-m' } })
    expect(screen.getByText('Change to PDM')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('References already written as POD-13 will stop linking.')
    fireEvent.keyDown(screen.getByTestId('repo-prefix-input'), { key: 'Enter' })
    expect(h.setPrefix).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change to PDM' }))
    })
    expect(h.setPrefix).toHaveBeenCalledWith({
      path: '/src/podium',
      prefix: 'PDM',
      machineId: ludovico,
    })
    expect(refetch).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('note')).toBeNull())
  } finally {
    window.removeEventListener(REF_PREFIXES_CHANGED_EVENT, refetch)
  }
})

it('keeps the editor open with the server’s refusal, and Escape leaves without writing', async () => {
  mount(PODIUM)
  h.setPrefix.mockRejectedValueOnce(new Error('Prefix WEB is already used.'))
  openProject()
  fireEvent.change(screen.getByTestId('repo-prefix-input'), { target: { value: 'WEB' } })
  await act(async () => {
    fireEvent.click(screen.getByTestId('repo-prefix-save'))
  })
  expect(screen.getByRole('alert').textContent).toBe('Prefix WEB is already used.')
  fireEvent.keyDown(screen.getByTestId('repo-prefix-input'), { key: 'Escape' })
  expect(screen.queryByRole('note')).toBeNull()
  expect((screen.getByTestId('repo-prefix-input') as HTMLInputElement).value).toBe('POD')
  expect(h.setPrefix).toHaveBeenCalledTimes(1)
})

it('shows placeholders until the machines report, then the empty state', () => {
  const pool = mount(null)
  expect(screen.getByRole('status', { name: 'Loading projects' })).toBeTruthy()
  expect(screen.queryByText('No projects yet')).toBeNull()
  act(() => headerEntities(pool).order('repository', []))
  expect(screen.getByText('No projects yet')).toBeTruthy()
})

it('removes all registrations only after confirmation, including folded registered worktrees', async () => {
  mount([...PODIUM, {
    ...PODIUM[2], repoId: podium, path: '/src/podium-12',
  } as GitRepositoryWire])
  openProject()
  expect(screen.getByText('Podium forgets the project. Files on disk and its tasks stay.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  expect(h.remove).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.click(within(screen.getByRole('form', { name: 'Remove' })).getByRole('button', { name: 'Remove' }))
  })
  expect(h.remove.mock.calls.map(([input]) => input)).toEqual(expect.arrayContaining([
    { path: '/home/u/podium', machineId: flatblock },
    { path: '/src/podium', machineId: ludovico },
    { path: '/src/podium-12', machineId: ludovico },
  ]))
  expect(h.remove).toHaveBeenCalledTimes(3)
  expect(h.closeTakeover).toHaveBeenCalledOnce()
})

it('keeps read-only project details visible to members and hides writes', () => {
  mount(PODIUM, false)
  expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
  openProject()
  expect(screen.queryByTestId('repo-prefix-input')).toBeNull()
  expect(screen.queryByTestId('repo-base-branch')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  expect(screen.getByText('Only admins can remove projects')).toBeTruthy()
  expect(screen.getByText('github.com/acme/podium')).toBeTruthy()
})
