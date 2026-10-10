// @vitest-environment happy-dom
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph/pool'
import { asIssueId, asRepoId, asUserId, type GitRepositoryWire } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../test/header-fixture'
import { NewPanelMenu } from './NewPanelMenu'
import { attachWorklistPool, useWorklistPool } from './store-worklist-pool'
import type { Trpc } from './trpc'

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(['/home/mgw/nulldisk', '/home/mgw/nulldisk/topic'])(
  'offers Pi on Ludovico from checkout %s without losing the repository hosts', async path => {
    const fixture = createHeaderFixture(1)
    const repositories = [
      { kind: 'repository', path: '/Users/mw/nulldisk', repoId: asRepoId('nulldisk'), machineId: 'mac', worktrees: [] },
      { kind: 'repository', path: '/home/mgw/nulldisk', repoId: asRepoId('nulldisk'), machineId: 'ludovico',
        worktrees: [{ path: '/home/mgw/nulldisk/topic', branch: 'topic' }] },
    ] as GitRepositoryWire[]
    let online = true
    const machines = () => ['mac', 'ludovico'].map(id => ({
      id, name: id, hostname: id, online: id === 'ludovico' && online,
      serviceAssignment: { server: false, agentExecution: true },
      availability: { epoch: 'one', daemon: true, server: false, supervisor: true },
      inventory: { os: 'linux', arch: 'x64', tools: [], agents: [
        { kind: 'pi', installed: true, login: { state: 'in' } },
      ] },
    }))
    fixture.api.discovery.refreshRepos.mutate = vi.fn(async () => ({ repositories, machines: machines(), diagnostics: [] })) as never
    const create = vi.fn(async () => ({ sessionId: 'new-pi' }))
    Object.assign(fixture.api.sessions, { create: { mutate: create } })
    let pool: MobxPool | null = null
    let owner!: ReturnType<typeof useStoreHandle<Trpc>>
    const opened = vi.fn()
    const fatal = vi.fn()
    function Host() {
      pool = useWorklistPool()
      owner = useStoreHandle<Trpc>()
      return <NewPanelMenu worktree={{ path, repoPath: '/home/mgw/nulldisk', isMain: path === '/home/mgw/nulldisk' }}
        issueId={asIssueId('task')} onOpened={opened} />
    }
    render(<StoreProvider principal={asClientPrincipal(asUserId('checkout-launch-proof'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={fixture.api}
      createReplicaFn={() => fixture.newReplica()} networkEnabled={false} onFatalError={fatal}
      attachRuntime={runtime => { fixture.bindHub(runtime.hub); return attachWorklistPool(runtime, fatal) }}><Host /></StoreProvider>)
    await waitFor(() => expect(pool).toBeTruthy())
    await act(async () => { await owner.access.refreshRepos() })
    fireEvent.click(screen.getByRole('button', { name: 'New panel' }))
    await screen.findByRole('menuitem', { name: /^New Pi$/ })
    const pi = () => screen.getByRole('menuitem', { name: /^New Pi/ })
    await waitFor(() => expect(pi().getAttribute('data-refused')).toBeNull())
    expect(screen.getByRole('menuitem', { name: 'ludovico' }).getAttribute('aria-disabled')).not.toBe('true')
    online = false
    await act(async () => { await owner.access.refreshRepos() })
    await waitFor(() => expect(pool!.row('machine', 'ludovico')).toMatchObject({ online: false }))
    await waitFor(() => expect(pi().getAttribute('data-refused')).toBe('true'))
    online = true
    await act(async () => { await owner.access.refreshRepos() })
    await waitFor(() => expect(pi().getAttribute('data-refused')).toBeNull())
    fireEvent.click(pi())
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      agentKind: 'pi', cwd: path, machineId: 'ludovico', issueId: 'task',
    }))
    await waitFor(() => expect(opened).toHaveBeenCalledWith('new-pi'))
    expect(fatal).not.toHaveBeenCalled()
  },
)
