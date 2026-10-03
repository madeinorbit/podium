import type { ClientRuntime } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import { allIssueViewModels } from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { SessionCardModel } from '@podium/client-core/viewmodels'
import type { MobxPool } from '@podium/client-graph'
import { checkMobileSessionContext } from '@podium/client-graph/diagnostics/mobile-session-check'
import {
  MOBILE_SESSION_ENTITIES,
  MOBILE_SESSION_SOURCE_KEY,
} from '@podium/client-graph/mobile-session-schema'
import { SESSION_EXIT_ENTITIES } from '@podium/client-graph/session-exit-schema'
import { SESSION_EXIT_SOURCE_KEY } from '@podium/client-graph/session-exit-source'
import { SESSION_PANE_ENTITIES } from '@podium/client-graph/session-pane-schema'
import { SESSION_PANE_SOURCE_KEY } from '@podium/client-graph/session-pane-source'
import { asSessionId, asUserId, sessionUserStateRowId } from '@podium/model'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { type ComponentProps, type ReactNode, StrictMode, useEffect, useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../../web/test/header-fixture'
import type { PendingTurn } from '../components/TranscriptList'
import type { MobilePool } from './mobile-pool'

type ComposerProps = ComponentProps<typeof import('../components/Composer').Composer>
type TerminalDomProps = ComponentProps<typeof import('../terminal/TerminalDom').default>

const seams = vi.hoisted(() => ({
  host: undefined as MobilePool | undefined,
  terminalInputs: [] as { enabled: boolean; initialGeometry?: { cols: number; rows: number } }[],
  nativeInputs: [] as TerminalDomProps[],
  transcriptInputs: [] as { pendingTurns?: readonly PendingTurn[]; answerInteractionId?: string }[],
  route: 'synthetic-session-0',
  replace: vi.fn(),
}))
vi.mock('./mobile-pool', async (importOriginal) => {
  const real = await importOriginal<typeof import('./mobile-pool')>()
  return {
    ...real,
    mobileDataLayer: () => seams.host?.layer() ?? 'legacy',
    useMobilePool: () => seams.host!.host.usePool(),
    useMobilePoolProjection: <T,>(...args: Parameters<MobilePool['host']['usePoolProjection']>) =>
      seams.host!.host.usePoolProjection(...args) as T,
  }
})
vi.mock('@podium/client-core/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@podium/client-core/react')>()),
  useHarnessDescriptors: () => ({ served: undefined }),
}))
// The transport is offline in this hermetic fixture; model a connected socket
// without replacing any session, issue, draft or conversation read.
vi.mock('./hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hooks')>()),
  useConnected: () => true,
}))
vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: () => {},
    back: () => {},
    replace: seams.replace,
    dismissTo: () => {},
  }),
  useLocalSearchParams: () => ({ sessionId: seams.route }),
  useFocusEffect: (fn: () => (() => void) | void) => useEffect(fn, [fn]),
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Error: 'error' },
  impactAsync: async () => {},
  notificationAsync: async () => {},
}))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../hooks/useKeyboardHeight', () => ({
  useKeyboardLift: () => 0,
  useKeyboardHeight: () => 0,
}))
vi.mock('../components/Screen', () => ({
  Screen: ({
    title,
    subtitle,
    children,
    right,
    leading,
  }: {
    title: string
    subtitle?: string
    children: ReactNode
    right?: ReactNode
    leading?: ReactNode
  }) => (
    <section>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {leading}
      {right}
      {children}
    </section>
  ),
  HeaderButton: ({
    label,
    children,
    onPress,
  }: {
    label: string
    children: ReactNode
    onPress: () => void
  }) => (
    <button type="button" aria-label={label} onClick={onPress}>
      {children}
    </button>
  ),
}))
vi.mock('../components/AgentMark', () => ({
  HarnessChip: ({ kind }: { kind: string }) => <span>{kind}</span>,
}))
vi.mock('../components/Icon', () => ({ Icon: () => null }))
vi.mock('../components/WorkingMark', () => ({ WorkingMark: () => null }))
vi.mock('../components/NewWorkButton', () => ({ NewWorkButton: () => null }))
vi.mock('../components/ActionSheet', () => ({ ActionSheet: () => null }))
vi.mock('../components/LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => children,
  TranscriptSkeleton: () => null,
  DetailSkeleton: () => null,
  WorkSkeleton: () => null,
}))
vi.mock('../components/PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/SessionLifecycle', () => ({ MobileSessionLifecycle: () => null }))
vi.mock('../components/TaskSheet', () => ({
  TaskSheet: ({ issue }: { issue: IssueViewModel | null }) =>
    issue ? (
      <aside>
        {issue.title}:{issue.description}
      </aside>
    ) : null,
}))
vi.mock('../components/PendingInteractionBand', () => ({ PendingInteractionBand: () => null }))
vi.mock('../components/SessionCard', () => ({
  SessionCard: ({ model, onLongPress }: { model: SessionCardModel; onLongPress?: () => void }) => (
    <button type="button" data-session={model.sessionId} onClick={onLongPress}>
      {JSON.stringify(model)}
    </button>
  ),
}))
vi.mock('../components/Composer', () => ({
  Composer: ({ value, onChangeText, onSend }: ComposerProps) => (
    <div>
      <input aria-label="Draft" value={value} onChange={(e) => onChangeText?.(e.target.value)} />
      <button type="button" onClick={() => onSend('New synthetic prompt')}>Send</button>
    </div>
  ),
}))
vi.mock('../components/TranscriptList', () => ({
  TranscriptList: (props: (typeof seams.transcriptInputs)[number]) => {
    seams.transcriptInputs.push(props)
    return (
      <div data-testid="transcript" data-question={props.answerInteractionId}>
        {props.pendingTurns?.map((turn) => (
          <p key={turn.id}>
            {turn.text}:{turn.failed ?? ''}
          </p>
        ))}
      </div>
    )
  },
}))
vi.mock('../terminal/TerminalDom', () => ({
  default: (props: TerminalDomProps) => {
    seams.nativeInputs.push(props)
    return (
      <div
        data-testid="native-terminal"
        data-cols={props.cols}
        data-rows={props.rows}
        data-spawn={props.spawnPending}
      />
    )
  },
}))
vi.mock('@podium/terminal-client-react', () => ({
  useTerminalSession: (input: (typeof seams.terminalInputs)[number]) => {
    seams.terminalInputs.push(input)
    return useRef({
      viewportRef: { current: null },
      containerRef: { current: null },
      toolbarRef: { current: null },
      mountedRef: { current: null },
      ready: true,
      outputSeen: true,
    }).current
  },
  MobileTerminalKeyboard: () => null,
}))

const { createMobilePool, useMobilePool } = await import('./mobile-pool')
const hooks = await import('./use-session-context')
const { SessionScreen } = await import('../screens/SessionScreen')
const { SessionsScreen } = await import('../screens/SessionsScreen')
const { TerminalPane: WebPane } = await import('../terminal/TerminalPane.web')
const { TerminalPane: NativePane } = await import('../terminal/TerminalPane.native')
const { default: TerminalRoute } = await import('../../app/session/[sessionId]/terminal')
const SID = asSessionId('synthetic-session-0')
const NOW = Date.parse('2026-10-03T00:00:00Z')
const reactErrors: string[] = []

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  reactErrors.length = 0
  vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) =>
    reactErrors.push(values.map(String).join(' ')),
  )
  seams.route = SID
  seams.terminalInputs.length = 0
  seams.nativeInputs.length = 0
  seams.transcriptInputs.length = 0
})
afterEach(() => {
  cleanup()
  storeStats.enable(false)
  vi.restoreAllMocks()
  expect(reactErrors).toEqual([])
})

// React adds newly resolved attributes in commit order. Compare their values,
// text and DOM order without treating attribute insertion order as rendering.
function rendered(node: Node): unknown {
  if (!(node instanceof Element)) return node.textContent
  return {
    tag: node.tagName,
    attributes: [...node.attributes]
      .map(({ name, value }) => [name, value] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
    children: [...node.childNodes].map(rendered),
  }
}

async function mount(on: boolean, screen: 'all' | 'probe' = 'all', cold = false) {
  const host = createMobilePool(false, () => ({ get: () => undefined, device: () => on }))
  seams.host = host
  const data = createHeaderFixture(12),
    errors: (Error | string)[] = [],
    seen: (MobxPool | null)[] = []
  const draftRecent = data.records.get('session:synthetic-session-1')!
  data.records.set('session:synthetic-session-1', {
    ...draftRecent,
    value: { ...(draftRecent.value as object), draftUpdatedAt: '2026-10-03T00:01:00Z' },
  })
  const stateId = sessionUserStateRowId(asUserId('operator'), SID)
  data.records.set(`sessionUserState:${stateId}`, {
    entity: 'sessionUserState',
    entityId: stateId,
    provenance: { seq: 1 },
    value: {
      userId: 'operator',
      sessionId: SID,
      readAt: '2026-10-03T00:00:00Z',
      snoozedUntil: null,
    },
  })
  const archived = data.records.get('session:synthetic-session-11')!
  data.records.set('session:synthetic-session-11', {
    ...archived,
    value: {
      ...(archived.value as object),
      archived: true,
      status: 'exited',
      lastActiveAt: '2020-01-01T00:00:00Z',
      stoppedAt: '2020-01-01T00:00:00Z',
      geometry: { cols: 132, rows: 37 },
      privateBody: 'Not a summary field',
    },
  })
  if (cold) data.records.clear()
  Object.assign(data.api, {
    sessions: {
      transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
      resolve: { query: async () => ({ kind: 'absent' }) },
    },
    messages: {
      records: { query: async () => ({ records: [] }) },
      cancel: { mutate: async () => ({ deliveryStatus: 'cancelled' }) },
      dismissNotice: { mutate: async () => {} },
    },
  })
  let runtime!: ClientRuntime,
    latest: {
      session?: unknown
      prompt?: unknown
      pending?: unknown
      exit?: unknown
      booting?: boolean
      ports?: ReturnType<typeof hooks.useSessionConversationPorts>
    } = {}
  function Probe() {
    const session = hooks.useSessionContextSession(SID),
      prompt = hooks.useSessionContextSpawnPrompt(SID),
      pending = hooks.useSessionContextSpawnPending(SID)
    const exit = hooks.useSessionContextExit(SID),
      booting = hooks.useSessionContextBooting(),
      ports = hooks.useSessionConversationPorts(SID)
    latest = { session, prompt, pending, exit, booting, ports }
    return (
      <output>
        {JSON.stringify({ session, prompt, pending, exit, booting, ready: ports.ready })}
      </output>
    )
  }
  function Surface() {
    runtime = useStoreHandle() as ClientRuntime
    host.initialize(runtime.ui)
    seen.push(useMobilePool())
    return screen === 'probe' ? (
      <Probe />
    ) : (
      <>
        <SessionScreen />
        <SessionsScreen />
        <TerminalRoute />
        <WebPane sessionId={SID} active />
        <NativePane sessionId={SID} active />
      </>
    )
  }
  storeStats.enable()
  storeStats.reset()
  const view = render(
    <StrictMode>
      <StoreProvider
        principal={asClientPrincipal(asUserId('operator'))}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={data.api}
        createReplicaFn={() => data.newReplica()}
        networkEnabled={false}
        routerWindow={createMemoryRouterWindow()}
        onFatalError={(error) => errors.push(error)}
        attachRuntime={(owner) => {
          data.bindHub(owner.hub)
          owner.getSnapshot().setSessionDraft(SID, 'Saved synthetic draft')
          const stop = host.host.attach(owner, (error) => errors.push(error))
          return stop
        }}
      >
        <Surface />
      </StoreProvider>
    </StrictMode>,
  )
  await waitFor(() => expect(runtime).toBeDefined())
  if (on)
    await waitFor(
      () => expect(seen.at(-1)?.row('mobileSessionReader', 'reader')).toBeTypeOf('object'),
      { timeout: 10000 },
    )
  if (screen === 'all')
    await waitFor(
      () =>
        expect((view.getByLabelText('Draft') as HTMLInputElement).value).toBe(
          'Saved synthetic draft',
        ),
      { timeout: 10000 },
    )
  else await waitFor(() => expect(latest.ports?.ready).toBe(true), { timeout: 10000 })
  return {
    data,
    runtime,
    view,
    errors,
    seen,
    host,
    latest: () => latest,
    pool: () => seen.at(-1)!,
    check() {
      const state = runtime.getSnapshot()
      return checkMobileSessionContext(
        seen.at(-1)!,
        state,
        allIssueViewModels(state.replica, state.issueProjections, state.issueUserStates),
        [SID, 'synthetic-session-11', 'missing-session'],
      )
    },
  }
}

it('renders the same six phone readers through real late attachment with no React errors', async () => {
  const legacy = await mount(false),
    expected = rendered(legacy.view.container)
  legacy.view.unmount()
  const enabled = await mount(true)
  expect(rendered(enabled.view.container)).toEqual(expected)
  expect(enabled.errors).toEqual([])
  expect(enabled.seen[0]).toBeNull()
  expect(enabled.seen.some((pool) => pool !== null)).toBe(true)
  expect(seams.terminalInputs.some((input) => input.enabled === false)).toBe(true)
  expect(seams.terminalInputs.at(-1)).toMatchObject({
    enabled: true,
    initialGeometry: { cols: 80, rows: 24 },
  })
  expect(seams.nativeInputs.at(-1)).toMatchObject({ spawnPending: false, cols: 80, rows: 24 })
})

it('has zero legacy selectors and conversation-port reads on relevant updates; legacy is the red control', async () => {
  const enabled = await mount(true)
  const stats = () => readRuntimeStoreStats(enabled.runtime)!
  expect(stats().selectorRuns).toBe(0)
  expect(Object.keys(stats().slices).filter((key) => key.startsWith('mobileSession.'))).toEqual([])
  await act(async () => {
    enabled.data.activity(1)
    enabled.runtime.getSnapshot().setSessionDraft(SID, 'Changed draft')
  })
  await waitFor(() =>
    expect((enabled.view.getByLabelText('Draft') as HTMLInputElement).value).toBe('Changed draft'),
  )
  expect(stats().selectorRuns).toBe(0)
  expect(Object.keys(stats().slices).filter((key) => key.startsWith('mobileSession.'))).toEqual([])
  enabled.view.unmount()
  const legacy = await mount(false)
  expect(readRuntimeStoreStats(legacy.runtime)?.selectorRuns).toBeGreaterThan(0)
  expect(readRuntimeStoreStats(legacy.runtime)?.slices['mobileSession.context']).toBeGreaterThan(0)
  expect(readRuntimeStoreStats(legacy.runtime)?.slices['mobileSession.ports']).toBeGreaterThan(0)
})

it('compares roster, addressed context, read state, geometry and ports with a planted mismatch', async () => {
  const enabled = await mount(true, 'probe')
  expect(enabled.pool().row('session', 'synthetic-session-11', 'summary')).not.toHaveProperty(
    'privateBody',
  )
  await waitFor(() => expect(enabled.check()).toMatchObject({ differences: 0, pending: 0 }))
  const state = enabled.runtime.getSnapshot()
  const wrong = { ...state, pendingSpawnPrompts: new Map([[SID, 'Planted wrong prompt']]) }
  expect(
    checkMobileSessionContext(enabled.pool(), wrong, allIssueViewModels(state.replica), [SID])
      .differences,
  ).toBeGreaterThan(0)
  expect(enabled.latest().session).toMatchObject({
    readAt: '2026-10-03T00:00:00Z',
    unread: false,
    snoozedUntil: null,
  })
  await act(async () =>
    enabled.data.patch('sessionUserState', sessionUserStateRowId(asUserId('operator'), SID), {
      readAt: null,
      snoozedUntil: '2026-10-04T00:00:00Z',
    }),
  )
  await waitFor(() =>
    expect(enabled.latest().session).toMatchObject({
      readAt: null,
      unread: true,
      snoozedUntil: '2026-10-04T00:00:00Z',
    }),
  )
})

it('borrows each shared source once and keeps the conversation bridge across draft and held-send updates', async () => {
  const enabled = await mount(true, 'probe'),
    pool = enabled.pool()
  for (const [key, entities] of [
    [SESSION_PANE_SOURCE_KEY, SESSION_PANE_ENTITIES],
    [SESSION_EXIT_SOURCE_KEY, SESSION_EXIT_ENTITIES],
    [MOBILE_SESSION_SOURCE_KEY, MOBILE_SESSION_ENTITIES],
  ] as const) {
    const duplicate = vi.fn(() => {
      throw new Error('Second owner')
    })
    const first = await pool.sources.ensure(key, entities, duplicate)
    expect(await pool.sources.ensure(key, entities, duplicate)).toBe(first)
    expect(duplicate).not.toHaveBeenCalled()
  }
  const ports = enabled.latest().ports!,
    records = ports.records,
    outbox = ports.outbox
  const recordWake = vi.fn(),
    outboxWake = vi.fn()
  const stopRecord = records.subscribe(recordWake),
    stopOutbox = outbox.subscribe(outboxWake)
  await act(async () => {
    await enabled.runtime.outbox.enqueue('sendText', { sessionId: SID, text: 'Held owner send' })
    enabled.runtime.getSnapshot().setSessionDraft(SID, 'Later draft')
  })
  await waitFor(() => expect(outbox.held()).toMatchObject([{ text: 'Held owner send' }]))
  expect(outboxWake).toHaveBeenCalled()
  expect(enabled.latest().ports?.records).toBe(records)
  expect(enabled.latest().ports?.outbox).toBe(outbox)
  expect(enabled.latest().ports?.draft).toBe('Saved synthetic draft')
  expect(enabled.latest().ports?.ready).toBe(true)
  stopRecord()
  stopOutbox()
})

it('keeps the original mutation owner when the pool conversation edits its draft and sends', async () => {
  const enabled = await mount(true)
  fireEvent.change(enabled.view.getByLabelText('Draft'), { target: { value: 'Draft by operator' } })
  await waitFor(() => expect(enabled.runtime.getSnapshot().drafts[SID]).toBe('Draft by operator'))
  fireEvent.click(enabled.view.getByText('Send'))
  await waitFor(() =>
    expect(enabled.runtime.outbox.pending()).toContainEqual(
      expect.objectContaining({
        kind: 'sendText',
        input: expect.objectContaining({ sessionId: SID, text: 'New synthetic prompt' }),
      }),
    ),
  )
})

it('retains loading on an empty cold replica instead of claiming the roster is empty', async () => {
  const enabled = await mount(true, 'probe', true)
  expect(enabled.latest().booting).toBe(true)
  expect(enabled.latest().session).toBeUndefined()
  expect(enabled.latest().pending).toBe(false)
  expect(enabled.errors).toEqual([])
})
