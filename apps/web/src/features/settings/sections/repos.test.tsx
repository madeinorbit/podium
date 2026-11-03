import { headerEntities } from '@podium/client-graph/header-entities'
import { MobxPool } from '@podium/client-graph/pool'
import type { GitRepositoryWire } from '@podium/model'
import { asMachineId, asRepoId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { REF_PREFIXES_CHANGED_EVENT } from '@/lib/ref-activation'
import { ReposSection } from './repos'

const h = vi.hoisted(() => ({
  pool: null as unknown,
  setPrefix: vi.fn(async (_input: unknown) => []),
}))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => h.pool }))
vi.mock('@/features/settings/stable-access', () => ({
  useSettingsTrpc: () => ({ repos: { setPrefix: { mutate: h.setPrefix } } }),
}))
vi.mock('@/lib/BaseBranchMenu', () => ({
  RepoBaseBranchMenu: () => null,
}))

const ludovico = asMachineId('m-ludovico')
const flatblock = asMachineId('m-flatblock')
const podium = asRepoId('repo-podium')
const ORIGIN = 'git@github.com:acme/podium.git'

function mount(scans: GitRepositoryWire[] | null) {
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
    {
      kind: 'machine',
      id: ludovico,
      value: { id: ludovico, name: 'ludovico', online: true } as never,
    },
    {
      kind: 'machine',
      id: flatblock,
      value: { id: flatblock, name: 'flatblock', online: false } as never,
    },
    ...(scans ?? []).map((value, i) => ({ kind: 'repository' as const, id: `scan${i}`, value })),
  ])
  if (scans)
    headerEntities(pool).order(
      'repository',
      scans.map((_, i) => `scan${i}`),
    )
  h.pool = pool
  render(<ReposSection podiumDefault="main" />)
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
    kind: 'worktree',
    machineId: ludovico,
    repoId: podium,
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
})

it('lists the repository once, with each machine’s checkout and its worktrees folded behind a count', () => {
  mount(PODIUM)
  expect(screen.getAllByTestId('settings-repo-row')).toHaveLength(1)
  expect(screen.getByText('github.com/acme/podium')).toBeTruthy()
  expect(screen.getByText('flatblock')).toBeTruthy()
  expect(screen.getByText('ludovico')).toBeTruthy()
  expect(screen.queryByText('pod-12')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /1 worktree/ }))
  expect(screen.getByText('pod-12')).toBeTruthy()
})

it('saves a new prefix through an online checkout and tells the ref links to refetch', async () => {
  mount(PODIUM)
  const refetch = vi.fn()
  window.addEventListener(REF_PREFIXES_CHANGED_EVENT, refetch)
  try {
    fireEvent.click(screen.getByTestId('repo-prefix'))
    fireEvent.change(screen.getByTestId('repo-prefix-input'), { target: { value: 'pd-m' } })
    expect(screen.getByText('Tasks in podium will read PDM-1, PDM-2, and so on.')).toBeTruthy()
    expect(screen.getByText('Refs already written as POD-13 will stop linking.')).toBeTruthy()
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('repo-prefix-input'), { key: 'Enter' })
    })
    expect(h.setPrefix).toHaveBeenCalledWith({
      path: '/src/podium',
      prefix: 'PDM',
      machineId: ludovico,
    })
    expect(refetch).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId('repo-prefix-input')).toBeNull())
  } finally {
    window.removeEventListener(REF_PREFIXES_CHANGED_EVENT, refetch)
  }
})

it('keeps the editor open with the server’s refusal, and Escape leaves without writing', async () => {
  mount(PODIUM)
  h.setPrefix.mockRejectedValueOnce(new Error('Prefix WEB is already used.'))
  fireEvent.click(screen.getByTestId('repo-prefix'))
  fireEvent.change(screen.getByTestId('repo-prefix-input'), { target: { value: 'WEB' } })
  await act(async () => {
    fireEvent.click(screen.getByTestId('repo-prefix-save'))
  })
  expect(screen.getByRole('alert').textContent).toBe('Prefix WEB is already used.')
  fireEvent.keyDown(screen.getByTestId('repo-prefix-input'), { key: 'Escape' })
  expect(screen.queryByTestId('repo-prefix-input')).toBeNull()
  expect(h.setPrefix).toHaveBeenCalledTimes(1)
})

it('shows placeholders until the machines report, then the empty state', () => {
  const pool = mount(null)
  expect(screen.getByRole('status', { name: 'Loading repositories' })).toBeTruthy()
  expect(screen.queryByText('No repositories yet')).toBeNull()
  act(() => headerEntities(pool).order('repository', []))
  expect(screen.getByText('No repositories yet')).toBeTruthy()
})
