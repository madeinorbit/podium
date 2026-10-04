import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { MobxPool } from '@podium/client-graph'
import { asSessionId, asUserId } from '@podium/model'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../../web/test/header-fixture'
import { attachMobilePool, useMobilePool } from './mobile-pool'
import {
  useSessionContextDraft,
  useSessionContextSession,
  useSessionContextSessions,
} from './use-session-context'

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const sid = asSessionId('synthetic-session-0')
const ZERO = { replicaRowReads: 0, sessionViewBuilds: 0, ledgerFolds: 0, topologyScans: 0 }

it.each([
  1, 4,
])('enables phone idle work at its real pool startup and keeps whole lists asleep at %sx', async (scale) => {
  const data = createHeaderFixture(12 * scale, 12 * scale)
  let runtime: ClientRuntime | undefined,
    pool: MobxPool | null = null
  const failures: (Error | string)[] = []
  function Surface() {
    runtime = useStoreHandle() as ClientRuntime
    pool = useMobilePool()
    const row = useSessionContextSession(sid),
      draft = useSessionContextDraft(sid)
    const sessions = useSessionContextSessions()
    return (
      <output data-testid="phone">
        {row?.name || row?.title}|{draft}|{sessions.length}
      </output>
    )
  }
  const view = render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('operator'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={data.api}
      createReplicaFn={() => data.newReplica()}
      networkEnabled={false}
      routerWindow={createMemoryRouterWindow()}
      onFatalError={(error) => failures.push(error)}
      attachRuntime={(owner) => {
        data.bindHub(owner.hub)
        void referenceState(owner).refreshRepos()
        return attachMobilePool(owner, (error) => failures.push(error))
      }}
    >
      <Surface />
    </StoreProvider>,
  )
  await waitFor(() => expect(pool?.row('mobileSessionReader', 'reader')).toBeTypeOf('object'), {
    timeout: 10000,
  })
  await waitFor(() =>
    expect(view.getByTestId('phone').textContent).toBe(`Synthetic agent 0||${12 * scale + 2}`),
  )

  const check = async (name: string, action: () => void) => {
    await act(async () => {
      action()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(runtime, name).not.toHaveProperty('getSnapshot')
    expect(runtime, name).not.toHaveProperty('legacyFoldStats')
  }
  await check('heartbeat', () =>
    data.patch('session', sid, { lastActiveAt: new Date().toISOString() }),
  )
  await check('agent phase', () =>
    data.patch('session', sid, {
      agentState: { phase: 'working', since: new Date().toISOString() },
    }),
  )
  await check('session rename', () => data.patch('session', sid, { name: 'Phone pool name' }))
  expect(view.getByTestId('phone').textContent).toBe(`Phone pool name||${12 * scale + 2}`)
  await check('issue rename', () =>
    data.patch('issueProjection', 'synthetic-0', { title: 'Phone issue title' }),
  )
  await check('issue stage', () =>
    data.patch('issueProjection', 'synthetic-0', { stage: 'review' }),
  )
  await check('draft write', () => referenceState(runtime!).setSessionDraft(sid, 'Phone draft'))
  await waitFor(() =>
    expect(view.getByTestId('phone').textContent).toBe(
      `Phone pool name|Phone draft|${12 * scale + 2}`,
    ),
  )
  await check('parked session', () => data.patch('session', sid, { status: 'hibernated' }))
  await check('worktree selection', () =>
    referenceState(runtime!).setSelectedWorktree('/synthetic/project/guests'),
  )
  expect(runtime!.readLocal('selectedWorktree')).toBe('/synthetic/project/guests')
  await check('worktree fallback', () =>
    referenceState(runtime!).setSelectedWorktree('/synthetic/missing'),
  )
  expect(runtime!.readLocal('selectedWorktree')).toBe('/synthetic/project')
  await check('session switch', () =>
    referenceState(runtime!).navigateToSession('synthetic-session-2'),
  )
  await check('session cwd move', () =>
    data.patch('session', 'synthetic-session-2', { cwd: '/synthetic/project/guests' }),
  )
  await check('session rehome', () =>
    data.patch('session', 'synthetic-session-2', { issueId: 'synthetic-1' }),
  )
  const record = {
    ...data.records.get(`session:${sid}`)!,
    entityId: 'synthetic-added',
    value: {
      ...(data.records.get(`session:${sid}`)!.value as object),
      sessionId: 'synthetic-added',
      issueId: undefined,
    },
  }
  await check('session arrival', () => {
    data.records.set('session:synthetic-added', record)
    data.replica.onKernelEvent({ type: 'upserted', record, readmitted: false })
  })
  expect(view.getByTestId('phone').textContent).toBe(
    `Phone pool name|Phone draft|${12 * scale + 3}`,
  )
  await check('session removal', () => {
    data.records.delete('session:synthetic-added')
    data.replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: 'synthetic-added' })
  })
  expect(view.getByTestId('phone').textContent).toBe(
    `Phone pool name|Phone draft|${12 * scale + 2}`,
  )
  expect(failures).toEqual([])

  const before = {}
  const stop = runtime!.subscribe(() => {
    void referenceState(runtime!).sessions.length
  })
  try {
    await act(async () => {
      data.patch('session', sid, { title: 'Counter control' })
      await Promise.resolve()
    })
    expect({}.sessionViewBuilds).toBeGreaterThan(before.sessionViewBuilds)
  } finally {
    stop()
  }
})
