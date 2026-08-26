// @vitest-environment happy-dom
import { asClientPrincipal } from '@podium/client-core/principal'
import {
  createKernelReplica,
  createSideCache,
  type KernelCacheRead,
  memoryStorage,
  type Replica,
} from '@podium/client-core/replica'
import {
  issueViewModelProjectionStats,
  type IssueViewModel,
  useAllIssueViewModels,
  useIssueViewModel,
  useIssueViewModels,
} from '@podium/client-core/react'
import {
  asIssueId,
  asSessionId,
  asUserId,
  type IssueId,
  type IssueProjection,
  type SessionMeta,
} from '@podium/model'
import type { EntityRecord, ReplicaEvent } from '@podium/sync/replica'
import { Profiler, act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renderCommits = vi.hoisted(() => new Map<string, number>())
const recordCommit = vi.hoisted(() => (id: string): void => {
  renderCommits.set(id, (renderCommits.get(id) ?? 0) + 1)
})

const fakeTrpc = {
  sync: { changesSince: { query: () => new Promise(() => {}) } },
  discovery: { refreshRepos: { mutate: async () => ({ repositories: [], diagnostics: [] }) } },
  pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
  tabs: { listOrders: { query: async () => ({}) } },
  settings: {
    get: {
      query: async () => ({
        sidebar: { repoSort: 'lastUsed', repoOrder: [] },
        roles: { coding: { startScreen: 'chat' } },
      }),
    },
  },
  quota: { summary: { query: () => new Promise(() => {}) } },
  sessions: {
    transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
    sendText: { mutate: async () => ({ disposition: 'delivered' }) },
    answerAskUserQuestion: { mutate: async () => ({ ok: true }) },
    uploadImage: { mutate: async () => ({ path: '/upload' }) },
    dismissOffer: { mutate: async () => ({}) },
  },
  messages: { ledger: { query: async () => [] } },
}

vi.mock('../app/trpc', () => ({ makeTrpc: () => fakeTrpc }))

type TerminalClientReactModule = typeof import('@podium/terminal-client-react')
type ImportOriginal = <T extends TerminalClientReactModule = TerminalClientReactModule>() => Promise<T>

vi.mock('@podium/terminal-client-react', async (importOriginal: ImportOriginal) => {
  const real = await importOriginal<typeof import('@podium/terminal-client-react')>()
  const React = await import('react')
  return {
    ...real,
    useTerminalSession: () => ({
      viewportRef: React.useRef<HTMLDivElement | null>(null),
      containerRef: React.useRef<HTMLDivElement | null>(null),
      toolbarRef: React.useRef<HTMLDivElement | null>(null),
      mountedRef: React.useRef(null),
      ready: true,
      outputSeen: true,
      atBottom: true,
    }),
    useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
  }
})

// The profiler is about subscription fan-out, not panel arbitration. Keep all
// eight warm panels on their chat surface without mounting PTYs; the selectors
// and store beneath AgentPanel remain the shipped implementations.
vi.mock('../features/terminal/use-panel-surface', () => ({
  usePanelSurface: ({ paneActive }: { paneActive: boolean }) => ({
    surface: { kind: 'live', view: 'chat' },
    gates: {
      terminalMounted: false,
      terminalActive: false,
      ptySizingAllowed: false,
      modeSwitchOffered: true,
      takeControlOffered: false,
      offerDockOffered: false,
    },
    mode: 'chat',
    modeSettled: true,
    chatCapable: true,
    pickMode: vi.fn(),
    paneActive,
  }),
}))

// A tiny profiler sentinel is a child of AgentPanel but not an ancestor of its
// draft bridge. It therefore records the panel function re-running, not a draft
// leaf committing below another branch of the panel.
vi.mock('../features/terminal/SessionWatchers', async () => {
  const React = await import('react')
  function Sentinel(): null {
    return null
  }
  return {
    SessionWatchers: ({ sessionId }: { sessionId: string }) => (
      <React.Profiler id={`panel:${sessionId}`} onRender={() => recordCommit(`panel:${sessionId}`)}>
        <Sentinel />
      </React.Profiler>
    ),
  }
})

// Keep the shell cheap while exercising the real use-chat-surface source and
// the real addressed draft reader as separate profiler leaves.
vi.mock('../features/chat/ChatView', async () => {
  const React = await import('react')
  const { useSessionDraft } = await import('../app/store')
  const { useChatSurface } = await import('../features/chat/use-chat-surface')

  function Surface({ sessionId, active }: { sessionId: string; active: boolean }): null {
    useChatSurface({
      sessionId: asSessionId(sessionId),
      active,
      superThread: undefined,
      compact: false,
      initialTurnRunning: false,
      initialPendingText: undefined,
    })
    return null
  }

  function Draft({ sessionId }: { sessionId: string }): null {
    useSessionDraft(asSessionId(sessionId))
    return null
  }

  return {
    ChatView: ({ sessionId, active = true }: { sessionId: string; active?: boolean }) => (
      <>
        <React.Profiler id={`chat:${sessionId}`} onRender={() => recordCommit(`chat:${sessionId}`)}>
          <Surface sessionId={sessionId} active={active} />
        </React.Profiler>
        <React.Profiler
          id={`draft:${sessionId}`}
          onRender={() => recordCommit(`draft:${sessionId}`)}
        >
          <Draft sessionId={sessionId} />
        </React.Profiler>
      </>
    ),
  }
})

const { StoreProvider, useStore, useStoreSelector } = await import('../app/store')
const { FlightDeck } = await import('../app/FlightDeck')
const { OperatorFocusProvider } = await import('../app/operator-focus')
const { AgentPanel } = await import('../features/terminal/AgentPanel')
const { ConfirmProvider } = await import('../lib/hooks/use-confirm')

class FakeWS {
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  send(): void {}
  close(): void {}
}

const session = (index: number): SessionMeta =>
  ({
    sessionId: asSessionId(`s${index}`),
    agentKind: 'claude-code',
    title: `Session ${index}`,
    cwd: '/repo',
    status: 'live',
    controllerId: `controller-${index}`,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-08-12T12:00:00.000Z',
    lastActiveAt: '2026-08-12T12:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    transcriptAvailable: true,
  }) as unknown as SessionMeta

/** In-memory durable view behind the shipped kernel Replica facade. Updating
 * one record retains every untouched row object, matching the production store
 * contract addressed selectors rely on. */
class RenderProbeCache implements KernelCacheRead {
  records: EntityRecord[] = []

  readCursor(): { seq: number } | null {
    return { seq: 1 }
  }

  readEntities(): readonly EntityRecord[] {
    return this.records
  }

  read(entity: string, entityId: string): EntityRecord | undefined {
    return this.records.find(
      (candidate) => candidate.entity === entity && candidate.entityId === entityId,
    )
  }

  durability(): 'durable' {
    return 'durable'
  }

  put(entity: string, entityId: string, value: unknown): EntityRecord {
    const record = { entity, entityId, value, provenance: { seq: 1 } }
    this.records = [
      ...this.records.filter(
        (candidate) => candidate.entity !== entity || candidate.entityId !== entityId,
      ),
      record,
    ]
    return record
  }
}

const upserted = (record: EntityRecord): ReplicaEvent => ({
  type: 'upserted',
  record,
  readmitted: false,
})

let root: Root
let container: HTMLDivElement
let realWebSocket: typeof WebSocket
let latestStore: ReturnType<typeof useStore> | null
const issueArrays = new Map<number, unknown>()
const issueIndexes = new Map<number, unknown>()
const addressedIssues = new Map<string, IssueViewModel | undefined>()

function StoreCapture(): null {
  latestStore = useStore()
  return null
}

/** Controls that reproduce the pre-change subscriptions over the same real
 * store. Their counts make the before/after fan-out explicit in one run. */
function CoarseDraftProbe(): null {
  useStoreSelector((store) => store.drafts)
  return null
}

function CoarseSessionProbe(): null {
  useStoreSelector((store) => store.sessions)
  return null
}

function SharedIssueProjectionProbe({
  reader,
  replica,
}: {
  reader: number
  replica: Replica
}): null {
  issueArrays.set(reader, useAllIssueViewModels(replica))
  issueIndexes.set(reader, useIssueViewModels(replica))
  return null
}

function AddressedIssueProbe({ issueId, replica }: { issueId: IssueId; replica: Replica }): null {
  addressedIssues.set(issueId, useIssueViewModel(replica, issueId))
  return null
}

const issueProjection = (index: number): IssueProjection =>
  ({
    id: `i${index}`,
    seq: index + 1,
    repoId: 'repo-1',
    stage: 'in_progress',
    title: `Issue ${index}`,
    description: { value: '' },
    readAt: '2026-08-12T12:10:00.000Z',
    createdAt: '2026-08-12T12:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
  }) as unknown as IssueProjection

const issueSession = (index: number): SessionMeta =>
  ({
    ...session(index),
    issueId: `i${index}`,
    phase: 'working',
  }) as unknown as SessionMeta

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-12T12:05:00.000Z'))
  localStorage.clear()
  renderCommits.clear()
  issueArrays.clear()
  issueIndexes.clear()
  addressedIssues.clear()
  latestStore = null
  realWebSocket = globalThis.WebSocket
  globalThis.WebSocket = FakeWS as unknown as typeof WebSocket
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.WebSocket = realWebSocket
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scoped session render subscriptions', () => {
  it('keeps eight warm panels, chat sources, and an open Flight Deck isolated', async () => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(index))
    const cache = new RenderProbeCache()
    for (const row of sessions) cache.put('session', row.sessionId, row)
    const replica = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })

    act(() => {
      root.render(
        <StoreProvider
          principal={asClientPrincipal(asUserId('operator'))}
          createReplicaFn={() => replica}
          config={{ httpOrigin: 'http://x', wsClientUrl: 'ws://x' }}
          onFatalError={() => {}}
        >
          <StoreCapture />
          <Profiler id="coarse-drafts" onRender={() => recordCommit('coarse-drafts')}>
            <CoarseDraftProbe />
          </Profiler>
          <Profiler id="coarse-sessions" onRender={() => recordCommit('coarse-sessions')}>
            <CoarseSessionProbe />
          </Profiler>
          <ConfirmProvider>
            {sessions.map((row, index) => (
              <AgentPanel key={row.sessionId} sessionId={row.sessionId} active={index === 0} />
            ))}
          </ConfirmProvider>
          <OperatorFocusProvider missionId="render-probe">
            <Profiler id="flight-deck" onRender={() => recordCommit('flight-deck')}>
              <FlightDeck onCollapse={() => {}} />
            </Profiler>
          </OperatorFocusProvider>
        </StoreProvider>,
      )
    })
    await flush()
    expect(latestStore).not.toBeNull()

    renderCommits.clear()
    for (let index = 0; index < 50; index++) {
      act(() => {
        latestStore?.setSessionDraft(asSessionId('s7'), `background draft ${index}`)
      })
    }
    await flush()

    for (let index = 0; index < 7; index++) {
      expect(renderCommits.get(`panel:s${index}`) ?? 0).toBe(0)
      expect(renderCommits.get(`chat:s${index}`) ?? 0).toBe(0)
      expect(renderCommits.get(`draft:s${index}`) ?? 0).toBe(0)
    }
    expect(renderCommits.get('panel:s7') ?? 0).toBe(0)
    expect(renderCommits.get('chat:s7') ?? 0).toBe(0)
    expect(renderCommits.get('draft:s7') ?? 0).toBe(50)
    expect(renderCommits.get('flight-deck') ?? 0).toBe(0)
    expect(renderCommits.get('coarse-drafts') ?? 0).toBe(50)
    expect(renderCommits.get('coarse-sessions') ?? 0).toBe(0)

    renderCommits.clear()
    act(() => latestStore?.setSessionDraft(asSessionId('s0'), 'focused draft'))
    await flush()

    expect(renderCommits.get('draft:s0') ?? 0).toBeGreaterThan(0)
    for (let index = 0; index < 8; index++) {
      expect(renderCommits.get(`panel:s${index}`) ?? 0).toBe(0)
      expect(renderCommits.get(`chat:s${index}`) ?? 0).toBe(0)
      if (index !== 0) expect(renderCommits.get(`draft:s${index}`) ?? 0).toBe(0)
    }
    expect(renderCommits.get('flight-deck') ?? 0).toBe(0)
    expect(renderCommits.get('coarse-drafts') ?? 0).toBe(1)
    expect(renderCommits.get('coarse-sessions') ?? 0).toBe(0)

    renderCommits.clear()
    act(() => {
      const renamed = { ...sessions[7]!, name: 'Renamed session' }
      replica.onKernelEvent(upserted(cache.put('session', renamed.sessionId, renamed)))
    })
    await flush()

    for (let index = 0; index < 7; index++) {
      expect(renderCommits.get(`panel:s${index}`) ?? 0).toBe(0)
      expect(renderCommits.get(`chat:s${index}`) ?? 0).toBe(0)
    }
    expect(renderCommits.get('panel:s7') ?? 0).toBeGreaterThan(0)
    expect(renderCommits.get('chat:s7') ?? 0).toBeGreaterThan(0)
    expect(renderCommits.get('coarse-drafts') ?? 0).toBe(0)
    expect(renderCommits.get('coarse-sessions') ?? 0).toBe(1)
  })

  it('shares one 674-issue projection and keeps by-id readers entity-scoped', async () => {
    const cache = new RenderProbeCache()
    const issueCount = 674
    const sessionCount = 530
    // Both halves per issue: `buildIssueViewModel` publishes a model only once a
    // projection row and its retained legacy row are both present, so a fixture
    // that seeds 674 of the first and one of the second projects one model.
    for (let index = 0; index < issueCount; index++) {
      const issue = issueProjection(index)
      cache.put('issueProjection', issue.id, issue)
      cache.put('issue', issue.id, { id: issue.id, pinned: false })
    }
    cache.put('repo', 'repo-1', { id: 'repo-1', prefix: 'POD' })
    for (let index = 0; index < sessionCount; index++) {
      const row = issueSession(index)
      cache.put('session', row.sessionId, row)
    }
    const replica = createKernelReplica({
      cache,
      side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    })

    act(() => {
      root.render(
        <StoreProvider
          principal={asClientPrincipal(asUserId('operator'))}
          createReplicaFn={() => replica}
          config={{ httpOrigin: 'http://x', wsClientUrl: 'ws://x' }}
          onFatalError={() => {}}
        >
          {Array.from({ length: 12 }, (_, reader) => (
            <SharedIssueProjectionProbe key={reader} reader={reader} replica={replica} />
          ))}
          <Profiler id="issue:i0" onRender={() => recordCommit('issue:i0')}>
            <AddressedIssueProbe issueId={asIssueId('i0')} replica={replica} />
          </Profiler>
          <Profiler id="issue:i529" onRender={() => recordCommit('issue:i529')}>
            <AddressedIssueProbe issueId={asIssueId('i529')} replica={replica} />
          </Profiler>
        </StoreProvider>,
      )
    })
    await flush()

    expect(new Set(issueArrays.values()).size).toBe(1)
    expect(new Set(issueIndexes.values()).size).toBe(1)
    expect((issueArrays.get(0) as unknown[]).length).toBe(issueCount)
    expect((issueIndexes.get(0) as Map<string, unknown>).size).toBe(issueCount)
    const buildsBeforeDelta = issueViewModelProjectionStats(replica).builds

    renderCommits.clear()
    const changed = { ...issueSession(529), phase: 'waiting' } as unknown as SessionMeta
    act(() => {
      replica.onKernelEvent(upserted(cache.put('session', changed.sessionId, changed)))
    })
    await flush()

    expect(issueViewModelProjectionStats(replica).builds - buildsBeforeDelta).toBe(1)
    expect(renderCommits.get('issue:i0') ?? 0).toBe(0)
    expect(renderCommits.get('issue:i529') ?? 0).toBe(1)
    expect(new Set(issueArrays.values()).size).toBe(1)
    expect(new Set(issueIndexes.values()).size).toBe(1)

    renderCommits.clear()
    const unrelated = { ...issueProjection(528), title: 'Unrelated changed issue' }
    const buildsBeforeUnrelated = issueViewModelProjectionStats(replica).builds
    act(() => {
      replica.onKernelEvent(upserted(cache.put('issueProjection', unrelated.id, unrelated)))
    })
    await flush()

    expect(issueViewModelProjectionStats(replica).builds - buildsBeforeUnrelated).toBe(1)
    expect(renderCommits.get('issue:i0') ?? 0).toBe(0)
    expect(renderCommits.get('issue:i529') ?? 0).toBe(0)

    renderCommits.clear()
    const addressed = { ...issueProjection(529), title: 'Addressed changed issue' }
    act(() => {
      replica.onKernelEvent(upserted(cache.put('issueProjection', addressed.id, addressed)))
    })
    await flush()

    expect(renderCommits.get('issue:i0') ?? 0).toBe(0)
    expect(renderCommits.get('issue:i529') ?? 0).toBe(1)

    renderCommits.clear()
    const buildsBeforeLegacy = issueViewModelProjectionStats(replica).builds
    act(() => {
      replica.onKernelEvent(upserted(cache.put('issue', 'i0', { id: 'i0', pinned: true })))
    })
    await flush()

    expect(issueViewModelProjectionStats(replica).builds - buildsBeforeLegacy).toBe(1)
    expect(addressedIssues.get('i0')?.pinned).toBe(true)
    expect(renderCommits.get('issue:i0') ?? 0).toBe(1)
    expect(renderCommits.get('issue:i529') ?? 0).toBe(0)
  })
})
