import { createPoolTransactions } from '@podium/client-graph/write/transactions'
import { setFixtureSpawnPrompt } from '@podium/client-graph/diagnostics/session-pane-fixture'
import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import type { ReferenceState } from '@podium/client-graph/diagnostics/reference-state'
type Store = ReferenceState<import('@/app/trpc').Trpc>

import {
  bindStoreStatsOwner,
  readRuntimeStoreStats,
  recordStoreSelector,
  storeStats,
} from '@podium/client-core/perf'
import type { SessionView } from '@podium/client-core/session-values'
import type { IssueReferenceSource } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph'
import {
  SESSION_PANE_NOW,
  sessionPaneFixture,
} from '@podium/client-graph/diagnostics/session-pane-fixture'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import {
  SESSION_PANE_ENTITIES,
  SESSION_PANE_SUMMARIES,
} from '@podium/client-graph/session-pane-schema'
import { SessionPaneSource } from '@podium/client-graph/session-pane-source'
import { asIssueId, asRepoId } from '@podium/model/browser'
import type { RefLinkConfig } from '@podium/terminal-client'
import type { MountedSession } from '@podium/terminal-client/session-mount'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
// @vitest-environment happy-dom
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { expectPoolOutput } from '../../../../../packages/worklist-proto/harness/src/oracle/pool-output'

const f = vi.hoisted(() => ({
  state: {} as Store,
  pool: null as MobxPool | null,
  owner: { transcriptWindow: () => undefined, putTranscriptWindow: vi.fn() },
  issues: [] as IssueReferenceSource[],
  mounted: { current: null as MountedSession | null },
  end: vi.fn(async () => ({ ok: true })),
  resurrect: vi.fn(async () => {}),
  kill: vi.fn(async () => {}),
  hibernate: vi.fn(async () => {}),
  configure: vi.fn(async () => ({ ok: true })),
  resolveShell: vi.fn(async () => ({ sessionId: 'pane-19' })),
  transcriptRead: vi.fn(async (_input: unknown) => ({ items: [], hasMore: false })),
  transcript: vi.fn((_session: unknown, _since?: unknown, _listener?: unknown) => () => {}),
  confirm: vi.fn(async () => true),
}))
const paneStoreHandle = withKeyedInputs({
  getSnapshot: () => f.state,
  subscribe: (_listener: () => void) => () => {},
})
vi.mock('@/app/store', () => ({
  useRuntimeSelector: (select: (s: Store) => unknown) => {
    recordStoreSelector(f.owner)
    return select(
      new Proxy(f.state, {
        get(target, key) {
          if (key === 'pendingSpawnPrompts' || key === 'drafts')
            throw new Error(`Legacy pane local read: ${String(key)}`)
          return Reflect.get(target, key)
        },
      }),
    )
  },
  useReplicaIssues: vi.fn(() => {
    throw new Error('Session pane read the legacy issue list')
  }),
  useSessionDraft: () => '',
  useSessionExitKind: () => undefined,
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => f.pool,
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T) => {
    const view = useMemo(() => (f.pool ? createPoolProjection(f.pool, read) : null), [read])
    return useSyncExternalStore(
      view?.subscribe ?? (() => () => {}),
      view?.getSnapshot ?? (() => empty),
    )
  },
}))
vi.mock('@podium/client-core/react', async () => ({
  ...(await import('./test-support/presence-mock')).presenceSeamStub(),
  useStoreHandle: () => paneStoreHandle,
}))
vi.mock('@/lib/hooks/use-confirm', () => ({ useConfirm: () => f.confirm }))
vi.mock('@podium/terminal-client-react', () => ({
  useTerminalSession: () => ({
    containerRef: { current: null },
    viewportRef: { current: null },
    mountedRef: f.mounted,
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
// Conversation rendering and transcript transport stay on their original path.
// This proof measures chrome/recovery independently from those unchanged rows.
vi.mock('@/features/chat/ChatView', () => ({
  ChatView: ({
    initialPendingText,
    onInitialPendingSettled,
  }: {
    initialPendingText?: string
    onInitialPendingSettled?: () => void
  }) => (
    <div>
      Existing transcript
      {initialPendingText === undefined ? null : (
        <button type="button" data-testid="spawn-prompt" onClick={onInitialPendingSettled}>
          {initialPendingText}
        </button>
      )}
    </div>
  ),
}))
vi.mock('./SessionWatchers', () => ({ SessionWatchers: () => null }))
vi.mock('@/components/GitStamp', () => ({ GitStamp: () => null }))
vi.mock('@/lib/ModelEffortPicker', () => ({
  ModelPicker: ({ value }: { value: string }) => (
    <button type="button" data-model={value}>
      {value}
    </button>
  ),
  EffortPicker: ({ value }: { value: string }) => (
    <button type="button" data-effort={value}>
      {value}
    </button>
  ),
}))
vi.mock('@/lib/SnoozeControl', () => ({
  SnoozeControl: () => <button type="button">Snooze</button>,
}))
vi.mock('./use-terminal-appearance', () => ({
  useTerminalAppearance: () => ({ settings: {}, appearance: { theme: { background: '#000' } } }),
}))
vi.mock('@/lib/useNow', () => ({ useNow: () => SESSION_PANE_NOW }))

const useFixtureIssues = () => f.issues
import { useChatSurface } from '../chat/use-chat-surface'
import { AgentPanel } from './AgentPanel'
import { DockShellPanel } from './DockShellPanel'
import {
  useDockPaneInputs,
  usePaneMachines,
  usePaneOwnership,
  usePanePanelModes,
  usePaneSession,
  usePaneSpawnConfirmed,
} from './use-session-pane-inputs'

let paneTransactions: ReturnType<typeof createPoolTransactions>
let sessions: SessionView[]
beforeEach(() => {
  f.issues = []
  f.mounted.current = null
  sessions = sessionPaneFixture()
  const state = {
    sessions,
    machines: [
      { id: 'machine-a', name: 'Host', online: true },
      { id: 'machine-b', name: 'Offline host', online: false },
    ],
    panelMode: Object.fromEntries(sessions.map((row) => [row.sessionId, 'chat'])),
    dockShells: { '/synthetic/w19': 'pane-19' },
    reposLoaded: true,
    pendingSpawnIds: new Set(),
    pendingSpawnPrompts: new Map(),
    drafts: {},
    coarseNow: SESSION_PANE_NOW,
    replica: f.owner,
    selectedIssueId: null,
    uiState: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
    hub: { subscribeTranscript: f.transcript },
    trpc: {
      settings: { get: { query: async () => ({ roles: { coding: { startScreen: 'chat' } } }) } },
      sessions: { configure: { mutate: f.configure }, transcriptRead: { query: f.transcriptRead } },
      shells: { forWorktree: { mutate: f.resolveShell } },
    },
    startBtw: vi.fn(),
    setSessionDraft: vi.fn(),
    dismissOffer: vi.fn(),
    sendChat: vi.fn(),
    openFile: vi.fn(),
    navigateToSession: vi.fn(),
    endSession: f.end,
    resurrectSession: f.resurrect,
    killSession: f.kill,
    hibernateSession: f.hibernate,
    chatSendsFor: () => [],
    getUserFocus: () => ({}),
    discardChat: vi.fn(),
    setPanelMode: vi.fn(),
    setDockShell: vi.fn(),
    setDockVisibleSession: vi.fn(),
  } as unknown as Store
  f.state = state
  f.pool = new MobxPool({ selectedIssueId: null, coarseNow: SESSION_PANE_NOW }, undefined, {
    summaries: SESSION_PANE_SUMMARIES,
    load: (entity, id) =>
      (entity === 'session'
        ? sessions.find((row) => row.sessionId === id)
        : f.issues.find((row) => row.id === id)) as never,
    issueIdByRef: (ref) => f.issues.find((row) => row.displayRef === ref)?.id,
    schedule: () => () => {},
  })
  paneTransactions = createPoolTransactions({
    userId: 'operator', outbox: { pending: () => [], awaiting: () => [], deadLetters: () => [], subscribe: () => () => {} },
    outcomes: () => () => {}, addressed: () => () => {}, enqueue: async () => {},
  })
  f.pool.attachTransactions(paneTransactions)
  f.pool.apply({
    type: 'replace',
    rows: sessions.map((row) => ({ kind: 'session', id: row.sessionId, value: row as never })),
  })
  f.pool.header.apply(state.machines.map((row) => ({ kind: 'machine', id: row.id, value: row })))
  f.pool.header.order(
    'machine',
    state.machines.map((row) => row.id),
  )
  f.pool.sources.register(
    SESSION_PANE_ENTITIES,
    new SessionPaneSource(withKeyedInputs({ getSnapshot: () => state, subscribe: () => () => {} })),
  )
  for (const row of sessions) f.pool.row('session', row.sessionId)
  f.pool.hydrate()
  bindStoreStatsOwner(f.owner, f.owner)
  bindStoreStatsOwner(paneStoreHandle, f.owner)
  storeStats.enable()
  storeStats.reset()
})
afterEach(() => {
  cleanup()
  paneTransactions.dispose()
  f.pool?.dispose()
  f.pool = null
  storeStats.enable(false)
  vi.clearAllMocks()
})

const view = (container: HTMLElement) => ({
  text: container.textContent,
  buttons: [...container.querySelectorAll('button')].map((button) => ({
    text: button.textContent,
    disabled: button.disabled,
    title: button.title,
    label: button.getAttribute('aria-label'),
    model: button.getAttribute('data-model'),
    effort: button.getAttribute('data-effort'),
  })),
  bars: [...container.querySelectorAll('.pane-state-bar')].map((node) =>
    node.getAttribute('data-tone'),
  ),
})

it('renders the same real AgentPanel header, lifecycle text and controls for every corpus state', async () => {
  for (const row of sessions) {
    const actual = render(<AgentPanel sessionId={row.sessionId} />)
    expectPoolOutput(view(actual.container), row.sessionId)
    actual.unmount()
  }
})

it('retains the keyed spawn prompt through confirmation and a parked surface until the transcript echoes it', () => {
  const row = sessions[0]!
  setFixtureSpawnPrompt(paneTransactions, row.sessionId, 'First operator prompt')
  const panel = render(<AgentPanel sessionId={row.sessionId} />)
  expect(panel.getByTestId('spawn-prompt').textContent).toBe('First operator prompt')
  act(() => setFixtureSpawnPrompt(paneTransactions, row.sessionId, undefined))
  act(() =>
    f.pool!.apply({
      type: 'update',
      rows: [
        { kind: 'session', id: row.sessionId, value: { ...row, status: 'hibernated' } as never },
      ],
    }),
  )
  panel.rerender(<AgentPanel sessionId={row.sessionId} />)
  expect(panel.getByTestId('spawn-prompt').textContent).toBe('First operator prompt')
  fireEvent.click(panel.getByTestId('spawn-prompt'))
  expect(panel.queryByTestId('spawn-prompt')).toBeNull()
  act(() => setFixtureSpawnPrompt(paneTransactions, row.sessionId, 'Later prompt'))
  panel.rerender(<AgentPanel sessionId={row.sessionId} />)
  expect(panel.getByTestId('spawn-prompt').textContent).toBe('Later prompt')
  panel.rerender(<AgentPanel sessionId={sessions[1]!.sessionId} />)
  expect(panel.queryByTestId('spawn-prompt')).toBeNull()
})

it('uses the same wake action and parked shell without resolving a replacement', () => {
  const agent = render(<AgentPanel sessionId={sessions[5]!.sessionId} />)
  fireEvent.click(
    agent.container.querySelector<HTMLButtonElement>('[data-testid="lifecycle-resume"]')!,
  )
  expect(f.resurrect).toHaveBeenCalledWith(sessions[5]!.sessionId)
  agent.unmount()
  const shell = render(<DockShellPanel cwd="/synthetic/w19" />)
  fireEvent.click(
    shell.container.querySelector<HTMLButtonElement>('[data-testid="lifecycle-resume"]')!,
  )
  expect(f.resurrect).toHaveBeenCalledWith(sessions[19]!.sessionId)
  expect(f.resolveShell).not.toHaveBeenCalled()
})

it('has zero legacy pane derivations while mounted and after an unrelated session delta', () => {
  const mounted = render(<AgentPanel sessionId={sessions[0]!.sessionId} />)
  const shell = render(<DockShellPanel cwd="/synthetic/w19" />)
  act(() =>
    f.pool!.apply({
      type: 'update',
      rows: [
        {
          kind: 'session',
          id: sessions[1]!.sessionId,
          value: { ...sessions[1]!, title: 'Other delta' } as never,
        },
      ],
    }),
  )
  expect(
    Object.entries(readRuntimeStoreStats(f.owner)?.slices ?? {}).filter(([name]) =>
      name.startsWith('sessionPane.'),
    ),
  ).toEqual([])
  mounted.unmount()
  shell.unmount()
})

it('keeps native reference underlines equal and live without legacy issue reads on the pool path', async () => {
  f.state.panelMode[sessions[0]!.sessionId] = 'native'
  const issues = [
    { seq: 1, stage: 'in_progress' as const },
    { seq: 2, stage: 'review' as const, archived: true },
    { seq: 3, stage: 'done' as const, deletedAt: '2026-10-01' },
  ].map((patch) => ({
    id: asIssueId(`underline-${patch.seq}`),
    repoId: asRepoId('synthetic'),
    prefix: 'POD',
    displayRef: `POD-${patch.seq}`,
    title: `Reference ${patch.seq}`,
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
    archived: false,
    repoPath: '/synthetic',
    worktreePath: null,
    deps: [],
    ...patch,
  }))
  f.issues = issues
  f.pool!.apply({
    type: 'update',
    rows: [
      { kind: 'worktree', id: '/synthetic', value: { path: '/synthetic', repoId: 'synthetic', prefix: 'POD', repoPath: '/synthetic', repoName: 'Synthetic' } as never },
      ...issues.map((row) => ({ kind: 'issue' as const, id: row.id, value: row as never })),
    ],
  })
  const tokens = ['POD-1', ' POD-01 ', 'POD-2', 'POD-3', 'POD-99', 'POD-1-a', '#1', 'bad']
  const config = { current: null as RefLinkConfig | null }
  let stages: Array<string | null> = []
  const paint = vi.fn((next: RefLinkConfig) => {
    config.current = next
    next.beginPaint?.()
    stages = tokens.map((token) => next.resolveStage?.(token) ?? null)
    next.endPaint?.()
  })
  f.mounted.current = {
    setAppearance: vi.fn(),
    view: { setRefLinks: paint, setFileLinks: vi.fn() },
  } as unknown as MountedSession
  const actual = render(<AgentPanel sessionId={sessions[0]!.sessionId} />)
  await waitFor(() => {
    // Demand lookup is nonblocking while cold identities/rows load locally.
    f.pool!.hydrate()
    expect(stages).toEqual(['in_progress', 'in_progress', 'review', null, null, null, null, null])
  })
  expectPoolOutput({ ...view(actual.container), stages }, 'reference underlines')
  expect(readRuntimeStoreStats(f.owner)).toBeDefined()
  expect(readRuntimeStoreStats(f.owner)?.slices['sessionPane.referenceIssues'] ?? 0).toBe(0)

  paint.mockClear()
  const updated = { ...issues[0]!, stage: 'review' as const }
  act(() =>
    f.pool!.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: updated.id, value: updated as never }],
    }),
  )
  expect(stages).toEqual(['review', 'review', 'review', null, null, null, null, null])
  expect(paint).toHaveBeenCalledTimes(1)
  paint.mockClear()
  act(() =>
    f.pool!.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: updated.id, value: { ...updated, title: 'Renamed' } as never }],
    }),
  )
  expect(paint).not.toHaveBeenCalled()
  actual.unmount()
  act(() =>
    f.pool!.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: updated.id, value: { ...updated, stage: 'done' } as never }],
    }),
  )
  expect(paint).not.toHaveBeenCalled()
  expect(config.current?.resolveStage?.('POD-1')).toBeNull()
})

it('never accesses legacy session, machine or window collections on the pool input path', () => {
  f.state = new Proxy(f.state, {
    get(target, key) {
      if (
        [
          'sessions',
          'machines',
          'panelMode',
          'pendingSpawnIds',
          'dockShells',
          'reposLoaded',
          'selectedIssueId',
          'issueProjections',
          'issueUserStates',
        ].includes(String(key))
      )
        throw new Error(`Legacy input read: ${String(key)}`)
      return Reflect.get(target, key)
    },
  })
  function Inputs() {
    const id = sessions[0]!.sessionId
    const row = usePaneSession(id),
      machines = usePaneMachines(),
      modes = usePanePanelModes()
    const confirmed = usePaneSpawnConfirmed(id),
      dock = useDockPaneInputs('/synthetic/w19', null)
    const ownership = usePaneOwnership(row)
    expect(ownership).toMatchObject({
      selectedIssueId: null,
      stampIssue: undefined,
      issueHex: undefined,
    })
    return (
      <div>
        {row?.title} {machines.length} {modes[id]} {String(confirmed)} {dock.session?.sessionId}
      </div>
    )
  }
  expect(render(<Inputs />).container.textContent).toBe('Synthetic pane 0 2 chat true pane-19')
})

it('uses pool facts in the real chat header while leaving transcript reads on the original transport', async () => {
  const row = sessions.find((row) => row.machineId === 'machine-b' && row.condition === undefined)!
  function Header() {
    const chat = useChatSurface({
      sessionId: row.sessionId,
      active: true,
      superThread: undefined,
      compact: false,
      initialTurnRunning: false,
      initialPendingText: undefined,
      deferInitialTranscript: false,
    })
    return (
      <div>
        {chat.session?.title} {chat.presenceOfflineMachineName}
      </div>
    )
  }
  const mounted = render(<Header />)
  await waitFor(() => expect(f.transcriptRead).toHaveBeenCalled())
  expect(mounted.container.textContent).toBe(`${row.title} Offline host`)
  expect(f.transcriptRead.mock.calls[0]?.[0]).toMatchObject({ sessionId: row.sessionId })
  expect(f.transcript.mock.calls[0]?.[0]).toBe(row.sessionId)
  expect(
    Object.entries(readRuntimeStoreStats(f.owner)?.slices ?? {}).filter(([name]) =>
      name.startsWith('sessionPane.'),
    ),
  ).toEqual([])
})
