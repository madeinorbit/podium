// @vitest-environment happy-dom
import { useMemo, useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionView } from '@podium/client-core/session-values'
import type { Store, ClientRuntime } from '@podium/client-core/engine'
import { bindStoreStatsOwner, readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { MobxPool } from '@podium/client-graph'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { SessionPaneSource } from '@podium/client-graph/session-pane-source'
import { SESSION_PANE_ENTITIES, SESSION_PANE_SUMMARIES } from '@podium/client-graph/session-pane-schema'
import { sessionPaneFixture, SESSION_PANE_NOW } from '@podium/client-graph/diagnostics/session-pane-fixture'

const f = vi.hoisted(() => ({ mode: 'legacy' as 'legacy' | 'pool', state: {} as Store,
  pool: null as MobxPool | null, owner: { transcriptWindow: () => undefined, putTranscriptWindow: vi.fn() },
  end: vi.fn(async () => ({ ok: true })), resurrect: vi.fn(async () => {}), kill: vi.fn(async () => {}),
  hibernate: vi.fn(async () => {}), configure: vi.fn(async () => ({ ok: true })),
  resolveShell: vi.fn(async () => ({ sessionId: 'pane-19' })),
  transcriptRead: vi.fn(async (_input: unknown) => ({ items: [], hasMore: false })),
  transcript: vi.fn((_session: unknown, _since?: unknown, _listener?: unknown) => () => {}), confirm: vi.fn(async () => true) }))
const paneStoreHandle = { getSnapshot: () => f.state, subscribe: (_listener: () => void) => () => {} }
vi.mock('./session-pane-data-layer', () => ({ sessionPaneDataLayer: () => f.mode }))
vi.mock('@/app/store', () => ({
  useStoreSelector: (select: (s: Store) => unknown) => select(f.state),
  useReplicaIssues: () => [], useSessionDraft: () => '',
  useSessionExitKind: () => undefined,
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T) => {
    const view = useMemo(() => f.pool ? createPoolProjection(f.pool, read) : null, [read])
    return useSyncExternalStore(view?.subscribe ?? (() => () => {}), view?.getSnapshot ?? (() => empty))
  },
}))
vi.mock('@podium/client-core/react', async () => ({
  ...(await import('./test-support/presence-mock')).presenceSeamStub(),
  useStoreHandle: () => paneStoreHandle,
}))
vi.mock('@/lib/hooks/use-confirm', () => ({ useConfirm: () => f.confirm }))
vi.mock('@podium/terminal-client-react', () => ({
  useTerminalSession: () => ({ containerRef: { current: null }, viewportRef: { current: null }, mountedRef: { current: null },
    ready: true, outputSeen: true, atBottom: true, role: 'controller', echoLatency: null }),
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
  preloadTerminalRuntime: vi.fn(), ArrowSwipeKey: () => null,
}))
// Conversation rendering and transcript transport stay on their original path.
// This proof measures chrome/recovery independently from those unchanged rows.
vi.mock('@/features/chat/ChatView', () => ({ ChatView: () => <div>Existing transcript</div> }))
vi.mock('./SessionWatchers', () => ({ SessionWatchers: () => null }))
vi.mock('@/components/GitStamp', () => ({ GitStamp: () => null }))
vi.mock('@/lib/ModelEffortPicker', () => ({
  ModelPicker: ({ value }: { value: string }) => <button data-model={value}>{value}</button>,
  EffortPicker: ({ value }: { value: string }) => <button data-effort={value}>{value}</button>,
}))
vi.mock('@/lib/SnoozeControl', () => ({ SnoozeControl: () => <button>Snooze</button> }))
vi.mock('./use-terminal-appearance', () => ({
  useTerminalAppearance: () => ({ settings: {}, appearance: { theme: { background: '#000' } } }),
}))
vi.mock('@/lib/useNow', () => ({ useNow: () => SESSION_PANE_NOW }))
import { AgentPanel } from './AgentPanel'
import { DockShellPanel } from './DockShellPanel'
import { useChatSurface } from '../chat/use-chat-surface'
import { usePaneSession, usePaneMachines, usePanePanelModes, usePaneSpawnConfirmed, useDockPaneInputs, usePaneOwnership } from './use-session-pane-inputs'

let sessions: SessionView[]
beforeEach(() => {
  f.mode = 'legacy'
  sessions = sessionPaneFixture()
  const state = { sessions, machines: [{ id: 'machine-a', name: 'Host', online: true }, { id: 'machine-b', name: 'Offline host', online: false }],
    panelMode: Object.fromEntries(sessions.map(row => [row.sessionId, 'chat'])), dockShells: { '/synthetic/w19': 'pane-19' },
    reposLoaded: true, pendingSpawnIds: new Set(), pendingSpawnPrompts: new Map(), coarseNow: SESSION_PANE_NOW,
    replica: f.owner, selectedIssueId: null, uiState: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
    hub: { subscribeTranscript: f.transcript }, trpc: { settings: { get: { query: async () => ({ roles: { coding: { startScreen: 'chat' } } }) } },
      sessions: { configure: { mutate: f.configure }, transcriptRead: { query: f.transcriptRead } }, shells: { forWorktree: { mutate: f.resolveShell } } },
    startBtw: vi.fn(), setSessionDraft: vi.fn(), dismissOffer: vi.fn(), sendChat: vi.fn(), openFile: vi.fn(), navigateToSession: vi.fn(),
    endSession: f.end, resurrectSession: f.resurrect, killSession: f.kill, hibernateSession: f.hibernate,
    chatSendsFor: () => [], getUserFocus: () => ({}), discardChat: vi.fn(),
    setPanelMode: vi.fn(), setDockShell: vi.fn(), setDockVisibleSession: vi.fn(),
  } as unknown as Store
  f.state = state
  f.pool = new MobxPool({ selectedIssueId: null, coarseNow: SESSION_PANE_NOW }, undefined,
    { summaries: SESSION_PANE_SUMMARIES, load: (_entity, id) => sessions.find(row => row.sessionId === id) as never, schedule: () => () => {} })
  f.pool.apply({ type: 'replace', rows: sessions.map(row => ({ kind: 'session', id: row.sessionId, value: row as never })) })
  f.pool.header.apply(state.machines.map(row => ({ kind: 'machine', id: row.id, value: row })))
  f.pool.header.order('machine', state.machines.map(row => row.id))
  f.pool.sources.register(SESSION_PANE_ENTITIES, new SessionPaneSource({ getSnapshot: () => state, subscribe: () => () => {} } as ClientRuntime))
  for (const row of sessions) f.pool.row('session', row.sessionId)
  f.pool.hydrate()
  bindStoreStatsOwner(f.owner, f.owner)
  storeStats.enable(); storeStats.reset()
})
afterEach(() => { cleanup(); f.pool?.dispose(); f.pool = null; storeStats.enable(false); vi.clearAllMocks() })

const view = (container: HTMLElement) => ({
  text: container.textContent,
  buttons: [...container.querySelectorAll('button')].map(button => ({ text: button.textContent, disabled: button.disabled,
    title: button.title, label: button.getAttribute('aria-label'), model: button.getAttribute('data-model'), effort: button.getAttribute('data-effort') })),
  bars: [...container.querySelectorAll('.pane-state-bar')].map(node => node.getAttribute('data-tone')),
})

it('renders the same real AgentPanel header, lifecycle text and controls for every corpus state', async () => {
  for (const row of sessions) {
    f.mode = 'legacy'
    const legacy = render(<AgentPanel sessionId={row.sessionId} />)
    const expected = view(legacy.container)
    legacy.unmount()
    f.mode = 'pool'
    const actual = render(<AgentPanel sessionId={row.sessionId} />)
    expect(view(actual.container), row.sessionId).toEqual(expected)
    actual.unmount()
  }
})

it('uses the same wake action and parked shell without resolving a replacement', () => {
  f.mode = 'pool'
  const agent = render(<AgentPanel sessionId={sessions[5]!.sessionId} />)
  fireEvent.click(agent.container.querySelector<HTMLButtonElement>('[data-testid="lifecycle-resume"]')!)
  expect(f.resurrect).toHaveBeenCalledWith(sessions[5]!.sessionId)
  agent.unmount()
  const shell = render(<DockShellPanel cwd="/synthetic/w19" />)
  fireEvent.click(shell.container.querySelector<HTMLButtonElement>('[data-testid="lifecycle-resume"]')!)
  expect(f.resurrect).toHaveBeenCalledWith(sessions[19]!.sessionId)
  expect(f.resolveShell).not.toHaveBeenCalled()
})

it('has zero legacy pane derivations while mounted and after an unrelated session delta', () => {
  f.mode = 'pool'
  const mounted = render(<AgentPanel sessionId={sessions[0]!.sessionId} />)
  const shell = render(<DockShellPanel cwd="/synthetic/w19" />)
  act(() => f.pool!.apply({ type: 'update', rows: [{ kind: 'session', id: sessions[1]!.sessionId, value: { ...sessions[1]!, title: 'Other delta' } as never }] }))
  expect(Object.entries(readRuntimeStoreStats(f.owner)?.slices ?? {}).filter(([name]) => name.startsWith('sessionPane.'))).toEqual([])
  mounted.unmount(); shell.unmount()
  f.mode = 'legacy'
  const legacy = render(<AgentPanel sessionId={sessions[0]!.sessionId} />)
  const counts = readRuntimeStoreStats(f.owner)?.slices ?? {}
  expect(counts['sessionPane.session']).toBeGreaterThan(0)
  expect(counts['sessionPane.machines']).toBeGreaterThan(0)
  expect(counts['sessionPane.panelMode']).toBeGreaterThan(0)
  legacy.unmount()
})

it('never accesses legacy session, machine or window collections on the pool input path', () => {
  f.mode = 'pool'
  f.state = new Proxy(f.state, { get(target, key) {
    if (['sessions', 'machines', 'panelMode', 'pendingSpawnIds', 'dockShells', 'reposLoaded', 'selectedIssueId', 'issueProjections', 'issueUserStates'].includes(String(key))) throw new Error(`Legacy input read: ${String(key)}`)
    return Reflect.get(target, key)
  } })
  function Inputs() {
    const id = sessions[0]!.sessionId
    const row = usePaneSession(id), machines = usePaneMachines(), modes = usePanePanelModes()
    const confirmed = usePaneSpawnConfirmed(id), dock = useDockPaneInputs('/synthetic/w19', null)
    const ownership = usePaneOwnership(row)
    expect(ownership).toMatchObject({ selectedIssueId: null, stampIssue: undefined, issueHex: undefined })
    return <div>{row?.title} {machines.length} {modes[id]} {String(confirmed)} {dock.session?.sessionId}</div>
  }
  expect(render(<Inputs />).container.textContent).toBe('Synthetic pane 0 2 chat true pane-19')
})

it('uses pool facts in the real chat header while leaving transcript reads on the original transport', async () => {
  f.mode = 'pool'
  const row = sessions.find(row => row.machineId === 'machine-b' && row.condition === undefined)!
  function Header() {
    const chat = useChatSurface({ sessionId: row.sessionId, active: true, superThread: undefined,
      compact: false, initialTurnRunning: false, initialPendingText: undefined, deferInitialTranscript: false })
    return <div>{chat.session?.title} {chat.presenceOfflineMachineName}</div>
  }
  const mounted = render(<Header />)
  await waitFor(() => expect(f.transcriptRead).toHaveBeenCalled())
  expect(mounted.container.textContent).toBe(`${row.title} Offline host`)
  expect(f.transcriptRead.mock.calls[0]?.[0]).toMatchObject({ sessionId: row.sessionId })
  expect(f.transcript.mock.calls[0]?.[0]).toBe(row.sessionId)
  expect(Object.entries(readRuntimeStoreStats(f.owner)?.slices ?? {}).filter(([name]) => name.startsWith('sessionPane.'))).toEqual([])
})
