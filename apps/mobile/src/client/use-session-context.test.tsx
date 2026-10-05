import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import type { ClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { SessionCardModel } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import { chatContextReadStats } from '@podium/client-graph/chat-context'
import { noticeFixture } from '@podium/client-graph/diagnostics/notice-fixture'
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
import { mobileSessionSnapshot } from '../../test/pool-snapshots'
import type { PendingTurn } from '../components/TranscriptList'
import type { MobilePool } from './mobile-pool'

type ComposerProps = ComponentProps<typeof import('../components/Composer').Composer>
type TerminalDomProps = ComponentProps<typeof import('../terminal/TerminalDom').default>
type TaskSheetProps = ComponentProps<typeof import('../components/TaskSheet').TaskSheet>

const seams = vi.hoisted(() => ({
  host: undefined as MobilePool | undefined,
  terminalInputs: [] as { enabled: boolean; initialGeometry?: { cols: number; rows: number } }[],
  nativeInputs: [] as TerminalDomProps[],
  transcriptInputs: [] as {
    pendingTurns?: readonly PendingTurn[]
    answerInteractionId?: string
    onRefPress?: (ref: string) => void
  }[],
  sheet: undefined as TaskSheetProps | undefined,
  route: 'synthetic-session-0',
  replace: vi.fn(),
}))
vi.mock('./mobile-pool', async (importOriginal) => {
  const real = await importOriginal<typeof import('./mobile-pool')>()
  return {
    ...real,
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
  TaskSheet: (props: TaskSheetProps) => {
    seams.sheet = props
    const { issue } = props
    return issue ? (
      <aside>
        {issue.title}:{issue.description}
      </aside>
    ) : null
  },
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
      <button type="button" onClick={() => onSend('New synthetic prompt')}>
        Send
      </button>
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
const { SessionConversation } = await import('../components/SessionConversation')
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
  seams.sheet = undefined
})
afterEach(() => {
  cleanup()
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

async function mount(
  screen: 'all' | 'probe' | 'conversation' = 'all',
  cold = false,
  onOpenTerminalRef?: (issue: IssueViewModel) => void,
) {
  const host = createMobilePool(false)
  seams.host = host
  const data = createHeaderFixture(12),
    errors: (Error | string)[] = [],
    seen: (MobxPool | null)[] = []
  const draftRecent = data.records.get('session:synthetic-session-1')!
  data.records.set('session:synthetic-session-1', {
    ...draftRecent,
    value: {
      ...(draftRecent.value as object),
      draftUpdatedAt: '2026-10-03T00:01:00Z',
      status: 'exited',
      lastActiveAt: '2020-01-01T00:00:00Z',
      stoppedAt: '2020-01-01T00:00:00Z',
    },
  })
  // Bound sessions inherit task coldness, including the drafted history row
  // still shown in the roster and the archived row addressed by the check.
  for (const index of [1, 11]) {
    const key = `issueProjection:synthetic-${index}`
    const record = data.records.get(key)
    if (!record) throw new Error('Synthetic history task is missing')
    data.records.set(key, {
      ...record,
      value: { ...(record.value as object), archived: true, stage: 'done' },
    })
  }
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
  const notices = noticeFixture(SID)
  for (const [entity, rows] of [
    ['message', notices.messages],
    ['pendingInteraction', notices.interactions],
  ] as const) {
    for (const row of rows)
      data.records.set(`${entity}:${row.id}`, {
        entity,
        entityId: row.id,
        provenance: { seq: 1 },
        value: row,
      })
  }
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
      question?: ReturnType<typeof hooks.useSessionContextQuestion>
    } = {}
  function Probe() {
    const session = hooks.useSessionContextSession(SID),
      prompt = hooks.useSessionContextSpawnPrompt(SID),
      pending = hooks.useSessionContextSpawnPending(SID)
    const exit = hooks.useSessionContextExit(SID),
      booting = hooks.useSessionContextBooting(),
      ports = hooks.useSessionConversationPorts(SID)
    const question = hooks.useSessionContextQuestion(SID)
    latest = { session, prompt, pending, exit, booting, ports, question }
    return (
      <output>
        {JSON.stringify({ session, prompt, pending, exit, booting, ready: ports.ready })}
      </output>
    )
  }
  function Conversation() {
    const session = hooks.useSessionContextSession(SID)
    const issue = hooks.useSessionContextIssue(session?.issueId)
    return session ? (
      <SessionConversation session={session} issue={issue} onOpenTerminalRef={onOpenTerminalRef} />
    ) : null
  }
  function Surface() {
    runtime = useStoreHandle() as ClientRuntime

    seen.push(useMobilePool())
    return screen === 'probe' ? (
      <Probe />
    ) : screen === 'conversation' ? (
      <Conversation />
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
          data.publishMachines()
          referenceState(owner).setSessionDraft(SID, 'Saved synthetic draft')
          const stop = host.host.attach(owner, (error) => errors.push(error))
          return stop
        }}
      >
        <Surface />
      </StoreProvider>
    </StrictMode>,
  )
  await waitFor(() => expect(runtime).toBeDefined())
  await waitFor(
    () => expect(seen.at(-1)?.row('mobileSessionReader', 'reader')).toBeTypeOf('object'),
    { timeout: 10000 },
  )
  if (screen !== 'probe')
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
  }
}

it('opens a conversation with zero mention reads, then matches the accepted reference and open-sheet catalogs', async () => {
  // Recorded after the accepted OFF/ON control passed at b4d0134f17.
  const expected = {
    issue: { id: 'synthetic-1', title: 'Synthetic task 1' },
    issues: [
      'synthetic-0',
      'synthetic-1',
      'synthetic-10',
      'synthetic-11',
      'synthetic-2',
      'synthetic-3',
      'synthetic-4',
      'synthetic-5',
      'synthetic-6',
      'synthetic-7',
      'synthetic-8',
      'synthetic-9',
    ],
    sessions: [
      'synthetic-guest-0',
      'synthetic-guest-1',
      'synthetic-session-0',
      'synthetic-session-1',
      'synthetic-session-10',
      'synthetic-session-11',
      'synthetic-session-2',
      'synthetic-session-3',
      'synthetic-session-4',
      'synthetic-session-5',
      'synthetic-session-6',
      'synthetic-session-7',
      'synthetic-session-8',
      'synthetic-session-9',
    ],
  }
  const enabled = await mount('conversation')
  const counts = chatContextReadStats(enabled.pool())
  expect(counts).toEqual({
    mentionBuilds: 0,
    mentionIssueReads: 0,
    referenceBuilds: 0,
    referenceSessionReads: 0,
  })
  await act(async () => seams.transcriptInputs.at(-1)!.onRefPress!('SYN-1001'))
  await waitFor(() => expect(seams.sheet?.issue?.id).toBe('synthetic-1'))
  expect({
    issue: { id: seams.sheet!.issue!.id, title: seams.sheet!.issue!.title },
    issues: seams.sheet!.issues.map((row) => row.id),
    sessions: seams.sheet!.sessions.map((row) => row.sessionId),
  }).toEqual(expected)
  expect(counts.mentionBuilds).toBeGreaterThan(0)
  expect(counts.mentionIssueReads).toBeGreaterThan(0)
  expect(counts.referenceSessionReads).toBeGreaterThan(0)
  await act(async () => seams.sheet!.onClose())
  const closedCounts = { ...counts }
  await act(async () =>
    enabled.data.patch('issueProjection', 'synthetic-0', { title: 'Conversation update' }),
  )
  expect(counts).toEqual(closedCounts)
  expect(enabled.errors).toEqual([])
}, 30_000)

it('resolves a cold terminal reference without building either conversation catalog', async () => {
  const onOpen = vi.fn()
  const enabled = await mount('conversation', false, onOpen)
  const counts = chatContextReadStats(enabled.pool())
  const references = vi.spyOn(enabled.pool(), 'references', 'get')
  await act(async () => seams.transcriptInputs.at(-1)!.onRefPress!('SYN-1001'))
  await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
  expect(onOpen.mock.calls[0]![0]).toMatchObject({ id: 'synthetic-1' })
  expect(seams.sheet?.issue).toBeNull()
  expect(counts).toEqual({
    mentionBuilds: 0,
    mentionIssueReads: 0,
    referenceBuilds: 0,
    referenceSessionReads: 0,
  })
  expect(enabled.errors).toEqual([])
  expect(references).not.toHaveBeenCalled()
  references.mockRestore()
}, 30_000)

it('renders the same six phone readers through real late attachment with no React errors', async () => {
  const enabled = await mount()
  expect(rendered(enabled.view.container)).toMatchSnapshot('last green pilot-ON session readers')
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

it('updates conversation ports without a whole-record store or whole-kind reads', async () => {
  const enabled = await mount()
  const wholeRows = vi.spyOn(enabled.runtime.replica, 'rows')
  expect(enabled.runtime).not.toHaveProperty('getSnapshot')
  await act(async () => {
    enabled.data.activity(1)
    enabled.runtime.services.setSessionDraft(SID, 'Changed draft')
  })
  await waitFor(() =>
    expect((enabled.view.getByLabelText('Draft') as HTMLInputElement).value).toBe('Changed draft'),
  )
  expect(wholeRows.mock.calls).toEqual([])
  expect(enabled.runtime).not.toHaveProperty('subscribe')
})

it('compares roster, addressed context, read state, geometry and ports with a planted mismatch', async () => {
  const enabled = await mount('probe')
  expect(enabled.pool().row('session', 'synthetic-session-11', 'summary')).not.toHaveProperty(
    'privateBody',
  )
  const state = referenceState(enabled.runtime)
  const ids = [SID, 'synthetic-session-11', 'missing-session']
  // The mounted probe asks only for SID. The complete frozen output also asks
  // for the archived and absent addresses, so settle their batched loads first.
  for (let turn = 0; turn < 64; turn++) {
    mobileSessionSnapshot(enabled.pool(), ids, state.coarseNow)
    let loaded = 0
    await act(async () => {
      loaded = enabled.pool().hydrate()
    })
    if (loaded === 0) break
    if (turn === 63) throw new Error('Complete session fixture did not settle')
  }
  expect(mobileSessionSnapshot(enabled.pool(), ids, state.coarseNow)).toMatchSnapshot(
    'last green pilot-ON complete session output',
  )
  const before = mobileSessionSnapshot(enabled.pool(), [SID], state.coarseNow)
  await act(async () =>
    enabled.data.patch('session', SID, { title: 'Planted session output error' }),
  )
  await waitFor(() =>
    expect(mobileSessionSnapshot(enabled.pool(), [SID], state.coarseNow)).not.toEqual(before),
  )
  expect(enabled.latest().session).toMatchObject({
    readAt: '2026-10-03T00:00:00Z',
    unread: false,
    snoozedUntil: null,
  })
  expect(enabled.latest().question).toMatchObject({ id: 'notice-ask-2', kind: 'question' })
  expect(enabled.pool().row('mobileSessionReader', 'reader')).toBeDefined()
  expect(referenceState(enabled.runtime).machines).toHaveLength(3)
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
  const enabled = await mount('probe'),
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
  expect(records.getSnapshot().map((row) => row.id)).toEqual([
    'notice-message-0',
    'notice-message-3',
    'notice-message-4',
  ])
  await act(async () => {
    enabled.data.patch('message', 'notice-message-0', { body: 'Updated replicated message' })
    enabled.data.patch('pendingInteraction', 'notice-ask-2', { status: 'answered' })
    await enabled.runtime.outbox.enqueue('sendText', { sessionId: SID, text: 'Held owner send' })
    referenceState(enabled.runtime).setSessionDraft(SID, 'Later draft')
  })
  await waitFor(() => expect(outbox.held()).toMatchObject([{ text: 'Held owner send' }]))
  expect(outboxWake).toHaveBeenCalled()
  await waitFor(() => expect(records.getSnapshot()[0]?.body).toBe('Updated replicated message'))
  expect(recordWake).toHaveBeenCalled()
  await waitFor(() => expect(enabled.latest().question?.id).not.toBe('notice-ask-2'))
  expect(enabled.latest().ports?.records).toBe(records)
  expect(enabled.latest().ports?.outbox).toBe(outbox)
  expect(enabled.runtime.drafts.get(SID)).toBe('Later draft')
  expect(enabled.latest().ports?.ready).toBe(true)
  stopRecord()
  stopOutbox()
})

it('keeps the original mutation owner when the pool conversation edits its draft and sends', async () => {
  const enabled = await mount()
  fireEvent.change(enabled.view.getByLabelText('Draft'), { target: { value: 'Draft by operator' } })
  await waitFor(() => expect(referenceState(enabled.runtime).drafts[SID]).toBe('Draft by operator'))
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
  const enabled = await mount('probe', true)
  expect(enabled.latest().booting).toBe(true)
  expect(enabled.latest().session).toBeUndefined()
  expect(enabled.latest().pending).toBe(false)
  expect(enabled.errors).toEqual([])
})
