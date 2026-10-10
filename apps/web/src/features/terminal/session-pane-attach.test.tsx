// @vitest-environment happy-dom
import { observer } from '@podium/client-graph/react'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { ClientRuntime } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import type { MobxPool } from '@podium/client-graph'
import {
  SESSION_PANE_NOW,
  sessionPaneFixture,
} from '../../../../../tests/worklist/diagnostics/session-pane-fixture'
import { asUserId } from '@podium/model/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachWorklistPool, useWorklistPool } from '@/app/store-worklist-pool'
import { ScenarioCache } from '../../../../../tests/worklist/shared/src/scenarios'
import { useChatSession } from '../chat/use-chat-context'
import { usePoolMachine } from '@/app/header-data'
import { isMachineOfflineForLiveTerminal } from '@podium/model/browser'
import { AgentPanel } from './AgentPanel'
import { DockShellPanel } from './DockShellPanel'
import {
  useDockPaneInputs,
  usePaneMachines,
  usePanePanelModes,
  usePaneSelectedIssueId,
  usePaneSession,
  usePaneSpawnConfirmed,
} from './use-session-pane-inputs'

// Keep the actual provider, store hooks, pool host, runtime, sources and pane
// hooks. Terminal rendering and unrelated presence catalogs are separate seams.
vi.mock('@podium/client-core/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@podium/client-core/react')>()),
  usePresenceRoom: () => ({ status: 'unknown' }),
  useModelCatalog: () => ({}),
  useHarnessDescriptors: () => ({ served: undefined, status: 'unavailable' }),
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
    echoLatency: null,
  }),
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
  preloadTerminalRuntime: vi.fn(),
  ArrowSwipeKey: () => null,
}))
vi.mock('@/features/chat/ChatView', () => ({ ChatView: () => <div>Existing transcript</div> }))
vi.mock('./SessionWatchers', () => ({ SessionWatchers: () => null }))
vi.mock('@/components/GitStamp', () => ({ GitStamp: () => null }))
vi.mock('@/lib/ModelEffortPicker', () => ({
  ModelPicker: () => null,
  EffortPicker: () => null,
}))
vi.mock('@/lib/SnoozeControl', () => ({ SnoozeControl: () => null }))
vi.mock('./use-terminal-appearance', () => ({
  useTerminalAppearance: () => ({ settings: {}, appearance: { theme: { background: '#000' } } }),
}))
vi.mock('@/lib/clock-hooks', () => ({ useClock: () => SESSION_PANE_NOW, useDeadlineNow: () => SESSION_PANE_NOW }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sessions = sessionPaneFixture()
const live = sessions[0]!
const shell = sessions.find((row) => row.agentKind === 'shell' && row.status === 'hibernated')!
const offline = sessions.find(
  (row) => row.machineId === 'machine-b' && row.condition === undefined,
)!
const config = { httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }
const principal = asClientPrincipal(asUserId('session-pane-attach'))
const transcriptRead = vi.fn(async () => ({ items: [], hasMore: false }))
const machines = [
  { id: 'machine-a', name: 'Host', online: true, loggedOutHarnesses: [] },
  { id: 'machine-b', name: 'Offline host', online: false, loggedOutHarnesses: [] },
]
const api = {
  settings: { get: { query: async () => ({ roles: { coding: { startScreen: 'chat' } } }) } },
  quota: { summary: { query: async () => [] } },
  sessions: { transcriptRead: { query: transcriptRead } },
  discovery: {
    refreshRepos: { mutate: async () => ({ repositories: [], diagnostics: [], machines }) },
  },
} as unknown as PodiumClientApi
const originalUrl = window.location.href
let runtime: ClientRuntime | undefined
const pools: (MobxPool | null)[] = []
const errors: (Error | string)[] = []

function replicaFactory() {
  const cache = new ScenarioCache()
  for (const row of [live, shell, offline]) cache.put('session', row.sessionId, row)
  for (const row of machines) cache.put('machine', row.id, row)
  return createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
}

function binding(next: ClientRuntime): () => void {
  runtime = next
  next.access.setPanelMode(live.sessionId, 'chat')
  next.access.setDockShell(shell.cwd, shell.sessionId)
  void next.access
    .refreshRepos()
    .catch((error) => errors.push(error))
  return attachWorklistPool(next, (error) => errors.push(error))
}

const Inputs = observer(function Inputs() {
  const pool = useWorklistPool()
  pools.push(pool)
  const row = usePaneSession(live.sessionId)
  const machines = usePaneMachines()
  const modes = usePanePanelModes()
  const confirmed = usePaneSpawnConfirmed(live.sessionId)
  const dock = useDockPaneInputs(shell.cwd, null)
  const ownership = { selectedIssueId: usePaneSelectedIssueId() }
  const chatSession = useChatSession(offline.sessionId)
  const chatMachine = usePoolMachine(chatSession?.machineId)
  const chat = { session: chatSession, presenceOfflineMachineName: chatMachine && isMachineOfflineForLiveTerminal(chatMachine) ? chatMachine.name : null }

  return (
    <>
      <output data-testid="attach-inputs">
        {row?.title}|{machines.length}|{modes[live.sessionId]}|{String(confirmed)}|
        {dock.session?.sessionId}|{String(ownership.selectedIssueId)}
      </output>
      <output data-testid="attach-chat-header">
        {chat.session?.title}|{chat.presenceOfflineMachineName}
      </output>
    </>
  )
})

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  runtime = undefined
  pools.length = 0
  errors.length = 0
  storeStats.enable()
  storeStats.reset()
  transcriptRead.mockClear()
})

afterEach(() => {
  cleanup()
  storeStats.enable(false)
  localStorage.clear()
  window.history.replaceState(null, '', originalUrl)
  vi.restoreAllMocks()
})

it.each([
  false,
  true,
])('keeps session hooks stable from no pool through the real attachment (StrictMode=%s)', async (strict) => {
  const consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const provider = (
    <StoreProvider
      principal={principal}
      config={config}
      api={api}
      createReplicaFn={replicaFactory}
      onFatalError={(error) => errors.push(error)}
      networkEnabled={false}
      attachRuntime={binding}
    >
      <AgentPanel sessionId={live.sessionId} />
      <DockShellPanel cwd={shell.cwd} />
      <Inputs />
    </StoreProvider>
  )
  const mounted = render(strict ? <StrictMode>{provider}</StrictMode> : provider)
  // The first render precedes the host's lazy import, even with persisted rows.
  expect(pools[0]).toBeNull()
  await waitFor(() => {
    expect(
      consoleErrors.mock.calls.filter((args) => /hooks|react error.*311/i.test(args.join(' '))),
    ).toEqual([])
    expect(mounted.getByTestId('attach-inputs').textContent).toBe(
      `${live.title}|2|chat|true|${shell.sessionId}|null`,
    )
    expect(mounted.getByTestId('attach-chat-header').textContent).toBe(
      `${offline.title}|Offline host`,
    )
    expect(mounted.container.querySelector('[data-testid="lifecycle-resume"]')).not.toBeNull()
  })
  expect(pools.some((pool) => pool !== null)).toBe(true)
  expect(errors).toEqual([])
  expect(
    consoleErrors.mock.calls.filter((args) => /hooks|react error.*311/i.test(args.join(' '))),
  ).toEqual([])
  // 15ed5c9ebd retired the snapshot publisher that produced these stats.
  // Late attachment must keep that publisher absent, including in StrictMode.
  expect(runtime).not.toHaveProperty('getSnapshot')
  expect(runtime).not.toHaveProperty('subscribe')
  expect(readRuntimeStoreStats(runtime!)).toBeUndefined()
})
