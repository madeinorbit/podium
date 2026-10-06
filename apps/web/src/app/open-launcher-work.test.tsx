// @vitest-environment happy-dom
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph/pool'
import type { GitRepositoryWire } from '@podium/model/browser'
import { asUserId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { insideReader, measureWork } from '../../../../tests/worklist/harness/src/work-meter'
import { createHeaderFixture } from '../../test/header-fixture'
import { NewPanelMenu } from './NewPanelMenu'
import { attachWorklistPool, useWorklistPool } from './store-worklist-pool'
import type { Trpc } from './trpc'

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('meters actual open NewPanelMenu at 1x/4x with a fixed origin', async () => {
  const samples = []
  for (const scale of [1, 4]) {
    const fixture = createHeaderFixture(128 * scale)
    const repos = Array.from({ length: 32 * scale }, (_, at) => ({ kind: 'repository',
      path: at === 0 ? '/synthetic/project' : `/synthetic/p${at}`, originUrl: `https://example.invalid/p${at}`,
      machineId: 'host-one', branch: 'main',
      worktrees: Array.from({ length: 8 }, (_, tree) => ({ path: at === 0 ? `/synthetic/project/wt-${tree}` : `/synthetic/p${at}/wt-${tree}`, branch: 'topic' })),
    })) as GitRepositoryWire[]
    // Keep the chosen root's history and its eight worktrees fixed; the rest is
    // unrelated history, rather than a larger displayed neighbourhood.
    for (const [key, record] of fixture.records) {
      if (record.entity !== 'session') continue
      const value = record.value as { sessionId: string; cwd: string }
      const at = Number(value.sessionId.split('-').at(-1)) || 0
      fixture.records.set(key, { ...record, value: { ...value, cwd: repos[at % repos.length]!.path } })
    }
    const machines = ['host-one', 'host-two'].map(id => ({ id, name: id, hostname: id, online: true,
      serviceAssignment: { server: false, agentExecution: true },
      availability: { epoch: 'one', daemon: true, server: false, supervisor: true },
      inventory: { os: 'linux', arch: 'x64', tools: [], agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }] },
    }))
    fixture.api.discovery.refreshRepos.mutate = vi.fn(async () => ({ repositories: repos, machines, diagnostics: [] })) as never
    let pool: MobxPool | null = null
    let owner!: ReturnType<typeof useStoreHandle<Trpc>>
    let choose!: (path: string) => void
    const fatal = vi.fn()
    function Host() {
      pool = useWorklistPool()
      owner = useStoreHandle<Trpc>()
      const [path, setPath] = useState('/synthetic/project')
      choose = setPath
      return <NewPanelMenu worktree={{ path, repoPath: path, isMain: true, branch: 'main', machineId: 'host-one' } as never} onOpened={() => {}} />
    }
    const app = render(<StoreProvider principal={asClientPrincipal(asUserId('open-launcher-proof'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }} api={fixture.api}
      createReplicaFn={() => fixture.newReplica()} networkEnabled={false} onFatalError={fatal}
      attachRuntime={runtime => { fixture.bindHub(runtime.hub); return attachWorklistPool(runtime, fatal) }}><Host /></StoreProvider>)
    await waitFor(() => expect(pool).toBeTruthy())
    await act(async () => { await owner.access.refreshRepos() })
    const attached = pool as MobxPool | null
    if (!attached) throw new Error('Web pool missing')
    async function measured(action: string, fn: () => unknown) {
      const result = await measureWork(async () => insideReader(`web.NewPanelMenu.${action}`, async () => {
        await act(async () => { await fn() })
        for (let at = 0; at < 20; at++) {
          let loaded = 0
          await act(async () => { loaded = attached!.hydrate() })
          if (!loaded) break
        }
      }), { pool: attached! })
      return { action, ...result.work }
    }
    const cells = []
    cells.push(await measured('open', () => fireEvent.click(screen.getByRole('button', { name: 'New panel' }))))
    expect(screen.getByRole('menuitem', { name: /^New Claude$/ })).toBeTruthy()
    cells.push(await measured('repository-choice', () => choose('/synthetic/p1')))
    expect(screen.getByText('p1', { exact: true })).toBeTruthy()
    cells.push(await measured('catalog', () => { repos[0] = { ...repos[0]!, branch: 'updated' }; return owner.access.refreshRepos() }))
    cells.push(await measured('usage', () => fixture.patch('session', 'synthetic-session-0', { createdAt: '2026-10-03T00:00:00Z', lastActiveAt: '2026-10-03T00:00:00Z' })))
    cells.push(await measured('heartbeat', () => fixture.patch('session', 'synthetic-session-0', { lastActiveAt: '2026-10-04T00:00:00Z' })))
    expect(fatal).not.toHaveBeenCalled()
    samples.push({ scale, repositories: repos.length, sessions: 128 * scale, cells })
    app.unmount(); cleanup()
  }
  console.info('[supported launcher NewPanelMenu]', JSON.stringify(samples))
  expect(samples).toHaveLength(2)
}, 60_000)
