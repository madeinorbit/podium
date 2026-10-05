// @vitest-environment happy-dom
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph'
import { asSessionId, asUserId } from '@podium/model/browser'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../test/header-fixture'
import { AgentPanel } from '../features/terminal/AgentPanel'
import { DockShellLifecycle } from '../features/terminal/dock-shell-lifecycle'
import { usePendingSpawnPrompt, useDraftValue } from './keyed-runtime'
import { attachWorklistPool, useWorklistPool } from './store-worklist-pool'
import { Workspace } from './Workspace'

vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  usePresenceRoom: () => ({ status: 'unknown' }),
  useHarnessDescriptors: () => ({ served: undefined }),
  useModelCatalog: () => ({}),
}))
vi.mock('@/features/terminal/AgentPanelBoundary', () => ({
  AgentPanelBoundary: ({ sessionId }: { sessionId: string }) => <div data-panel={sessionId} />,
}))
vi.mock('./NewPanelMenu', () => ({ NewPanelMenu: () => null }))
vi.mock('@/features/setup/ColdStartComposer', () => ({
  ColdStartComposer: () => <div>Cold deck</div>,
}))
vi.mock('@/lib/hooks/use-confirm', () => ({ useConfirm: () => async () => true }))
vi.mock('@podium/terminal-client-react', () => ({
  useTerminalSession: () => ({
    containerRef: { current: null },
    viewportRef: { current: null },
    mountedRef: { current: null },
    ready: true,
    outputSeen: true,
    atBottom: true,
    role: 'controller',
  }),
  useVoiceInput: () => ({ supported: false, listening: false, toggle: () => {} }),
  preloadTerminalRuntime: () => {},
  ArrowSwipeKey: () => null,
}))
vi.mock('@/features/chat/ChatView', () => ({ ChatView: () => <div>Existing transcript</div> }))
vi.mock('@/features/chat/OfferBar', () => ({ OfferBar: () => null }))
vi.mock('@/features/terminal/SessionWatchers', () => ({ SessionWatchers: () => null }))
vi.mock('@/components/GitStamp', () => ({ GitStamp: () => null }))
vi.mock('@/lib/ModelEffortPicker', () => ({ ModelPicker: () => null, EffortPicker: () => null }))
vi.mock('@/lib/SnoozeControl', () => ({ SnoozeControl: () => null }))
vi.mock('@/features/terminal/use-terminal-appearance', () => ({
  useTerminalAppearance: () => ({ settings: {}, appearance: { theme: { background: '#000' } } }),
}))

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const sid = asSessionId('synthetic-session-0')

it.each([
  1, 4,
])('keeps the real web clients idle across normal reads and writes at %sx', async (scale) => {
  const data = createHeaderFixture(12 * scale, 12 * scale)
  let runtime: ClientRuntime | undefined,
    pool: MobxPool | null = null
  const failures: (Error | string)[] = []
  function Inputs() {
    runtime = useStoreHandle() as ClientRuntime
    pool = useWorklistPool()
    return (
      <output data-testid="locals">
        {useDraftValue(sid)}|{usePendingSpawnPrompt(sid) ?? ''}
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
      onFatalError={(error) => failures.push(error)}
      attachRuntime={(owner) => {
        data.bindHub(owner.hub)
        owner.access.setPanelMode(sid, 'chat')
        void owner.access.refreshRepos()
        return attachWorklistPool(owner, (error) => failures.push(error))
      }}
    >
      <Inputs />
      <Workspace />
      <DockShellLifecycle />
      <AgentPanel sessionId={sid} />
    </StoreProvider>,
  )
  await waitFor(() => expect(pool?.row('shellWindow', 'window')).toBeTypeOf('object'), {
    timeout: 10000,
  })
  await act(async () => {
    runtime!.access.navigateToSession(sid)
    await Promise.resolve()
  })
  await waitFor(() =>
    expect(view.container.querySelector('[data-testid="native-tab-strip"]')?.textContent).toContain(
      'Synthetic agent 0',
    ),
  )
  expect(view.container.querySelector(`[data-panel="${sid}"]`)).not.toBeNull()

  // Finish the startup attachment's queued navigation before measuring use.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const wholeRows = vi.spyOn(runtime!.replica, 'rows')
  const check = async (name: string, action: () => void) => {
    await act(async () => {
      action()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(wholeRows.mock.calls, name).toEqual([])
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
  await check('session rename', () => data.patch('session', sid, { name: 'Pool tab name' }))
  expect(view.container.querySelector('[data-testid="native-tab-strip"]')?.textContent).toContain(
    'Pool tab name',
  )
  await check('issue rename', () =>
    data.patch('issueProjection', 'synthetic-0', { title: 'Pool issue title' }),
  )
  await check('issue stage', () =>
    data.patch('issueProjection', 'synthetic-0', { stage: 'review' }),
  )
  await check('draft write', () => runtime!.access.setSessionDraft(sid, 'Pool draft'))
  expect(view.getByTestId('locals').textContent).toBe('Pool draft|')
  await check('parked session', () => data.patch('session', sid, { status: 'hibernated' }))
  await check('mapped dock change', () =>
    runtime!.access.setDockShell('/synthetic/project', asSessionId('synthetic-session-1')),
  )
  await check('session switch', () =>
    runtime!.access.navigateToSession('synthetic-session-2'),
  )
  await check('worktree selection', () => {
    runtime!.access.setSelectedIssueId(null)
    runtime!.access.setSelectedWorktree('/synthetic/project/guests')
  })
  expect(runtime!.readLocal('selectedWorktree')).toBe('/synthetic/project/guests')
  await check('worktree fallback', () =>
    runtime!.access.setSelectedWorktree('/synthetic/missing'),
  )
  expect(runtime!.readLocal('selectedWorktree')).toBe('/synthetic/project')
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
  await check('session removal', () => {
    data.records.delete('session:synthetic-added')
    data.replica.onKernelEvent({ type: 'removed', entity: 'session', entityId: 'synthetic-added' })
  })
  expect(failures).toEqual([])
})
