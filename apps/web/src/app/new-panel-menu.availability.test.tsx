// @vitest-environment happy-dom
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useClientRuntime } from '@podium/client-core/react'
import { here } from '@podium/client-graph/lookup'
import type { MobxPool } from '@podium/client-graph/pool'
import { asIssueId, asRepoId, asUserId, type GitRepositoryWire } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../test/header-fixture'
import { NewPanelMenu } from './NewPanelMenu'
import { attachWorklistPool, useWorklistPool } from './store-worklist-pool'
import type { Trpc } from './trpc'

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each([
  '/home/mgw/nulldisk',
  '/home/mgw/nulldisk/topic',
])('offers Pi on Ludovico from checkout %s without losing the repository hosts', async (path) => {
  const fixture = createHeaderFixture(1, 1, 'checkout-launch-proof')
  const repositories = [
    {
      kind: 'repository',
      path: '/Users/mw/nulldisk',
      repoId: asRepoId('nulldisk'),
      machineId: 'mac',
      worktrees: [],
    },
    {
      kind: 'repository',
      path: '/home/mgw/nulldisk',
      repoId: asRepoId('nulldisk'),
      machineId: 'ludovico',
      worktrees: [{ path: '/home/mgw/nulldisk/topic', branch: 'topic' }],
    },
  ] as GitRepositoryWire[]
  let online = true
  const machines = () =>
    ['mac', 'ludovico'].map((id) => ({
      id,
      name: id,
      hostname: id,
      online: id === 'ludovico' && online,
      serviceAssignment: { server: false, agentExecution: true },
      availability: { epoch: 'one', daemon: true, server: false, supervisor: true },
      inventory: {
        os: 'linux',
        arch: 'x64',
        tools: [],
        agents: [{ kind: 'pi', installed: true, login: { state: 'in' } }],
      },
    }))
  // Machines and repositories are records; online is the live condition (POD-6644).
  fixture.putMachinesAndRepos({ machines: machines(), repos: repositories })
  let pool: MobxPool | null = null
  let owner!: ReturnType<typeof useClientRuntime<Trpc>>
  const opened = vi.fn()
  const fatal = vi.fn()
  function Host() {
    pool = useWorklistPool()
    owner = useClientRuntime<Trpc>()
    return (
      <NewPanelMenu
        worktree={{ path, repoPath: '/home/mgw/nulldisk', isMain: path === '/home/mgw/nulldisk' }}
        issueId={asIssueId('task')}
        onOpened={opened}
      />
    )
  }
  render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('checkout-launch-proof'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={fixture.api}
      createReplicaFn={() => fixture.newReplica()}
      networkEnabled={false}
      onFatalError={fatal}
      attachRuntime={(runtime) => {
        fixture.bindHub(runtime.root.services.connection.hub, undefined, runtime.root.live)
        return attachWorklistPool(runtime, fatal)
      }}
    >
      <Host />
    </StoreProvider>,
  )
  await waitFor(() => expect(pool).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'New panel' }))
  await screen.findByRole('menuitem', { name: /^New Pi$/ })
  const pi = () => screen.getByRole('menuitem', { name: /^New Pi/ })
  await waitFor(() => expect(pi().getAttribute('data-refused')).toBeNull())
  expect(screen.getByRole('menuitem', { name: 'ludovico' }).getAttribute('aria-disabled')).not.toBe(
    'true',
  )
  online = false
  await act(async () => {
    fixture.putMachinesAndRepos({ machines: machines() })
  })
  await waitFor(() => expect(here(pool!.model('machine', 'ludovico'))?.online).toBe(false))
  await waitFor(() => expect(pi().getAttribute('data-refused')).toBe('true'))
  online = true
  await act(async () => {
    fixture.putMachinesAndRepos({ machines: machines() })
  })
  await waitFor(() => expect(pi().getAttribute('data-refused')).toBeNull())
  fireEvent.click(pi())
  // A `session.launch` record (POD-6523): the panel opens on the session id
  // minted here, and the starting session paints at once from the queued
  // launch, in this checkout on Ludovico, joining the panel's task.
  await waitFor(() => expect(opened).toHaveBeenCalledTimes(1))
  const sessionId = opened.mock.calls[0]![0] as string
  await waitFor(() =>
    expect(pool!.row('session', sessionId)).toMatchObject({
      agentKind: 'pi',
      cwd: path,
      machineId: 'ludovico',
      issueId: 'task',
      status: 'starting',
    }),
  )
  expect(fatal).not.toHaveBeenCalled()
})
