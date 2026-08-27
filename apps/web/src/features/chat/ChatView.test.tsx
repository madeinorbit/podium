import {
  asSessionId,
  type SessionId,
  type SessionMeta,
  type SessionMetaInput,
  type TranscriptItem,
} from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// A controllable fake hub + tRPC, injected via the store mock. The hub records
// the (sessionId, since, cb) of each subscribeTranscript call so a test can push
// deltas (or none) and assert what renders.
// ---------------------------------------------------------------------------

type DeltaCb = (items: TranscriptItem[], meta: { reset: boolean }) => void

interface ReadCall {
  input: { sessionId: SessionId; anchor?: string; direction: 'before' | 'after'; limit: number }
  resolve: (r: { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean }) => void
}

const fakeHub = {
  subscribes: [] as Array<{ sessionId: SessionId; since: string | undefined; cb: DeltaCb }>,
  subscribeTranscript(sessionId: SessionId, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
  // ChatView calls these on the hub indirectly via SessionConnection only in
  // native mode; the chat path doesn't, so stubs suffice.
}

const reads: ReadCall[] = []
const fakeTrpc = {
  sessions: {
    transcriptRead: {
      query(input: ReadCall['input']) {
        return new Promise((resolve) => {
          reads.push({ input, resolve })
        })
      },
    },
    sendText: {
      mutate: vi.fn(
        async (): Promise<{
          ok?: boolean
          disposition: string
          reason?: string
          queued?: boolean
          position?: number
        }> => ({
          disposition: 'delivered',
        }),
      ),
    },
    // `reason` is optional but PRESENT in the contract: a stop can be refused
    // with one, and a fake that could not express that could not test it.
    interrupt: {
      mutate: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
    },
    answerAskUserQuestion: { mutate: vi.fn(async () => {}) },
    uploadImage: { mutate: vi.fn(async () => ({ path: '/x' })) },
  },
  messages: {
    ledger: { query: vi.fn(async (): Promise<unknown> => []) },
    cancel: { mutate: vi.fn(async () => ({ status: 'cancelled' })) },
  },
}

// Store ACTIONS, hoisted out of the `useStore` factory so they survive a
// re-render: the factory runs on every hook call, and inline `vi.fn()`s there
// would hand each render a fresh spy with no recorded calls.
const storeActions = {
  resumeAndSend: vi.fn(async (_sessionId: SessionId, _text: string) => {}),
  setPanelMode: vi.fn((_sessionId: SessionId, _mode: 'chat' | 'native') => {}),
  setSessionDraft: vi.fn(),
}

let storeSessions: SessionMeta[] = []
let storeDrafts: Record<string, string> = {}
let storeExitKind: 'evicted' | 'removed' | undefined
const fakeUiValues = new Map<string, string>()
const fakeUiListeners = new Set<() => void>()
const fakeUiState = {
  get: (key: string) => fakeUiValues.get(key) ?? null,
  set: (key: string, value: string | null) => {
    if (value === null) fakeUiValues.delete(key)
    else fakeUiValues.set(key, value)
    for (const listener of fakeUiListeners) listener()
  },
  subscribe: (listener: () => void) => {
    fakeUiListeners.add(listener)
    return () => fakeUiListeners.delete(listener)
  },
}

// Inert replica stub — the offline-copy path has its own suite (ChatView.offline.test.tsx).
const fakeReplica = {
  available: false,
  hydrate: async () => ({ sessions: [], issues: [], conversations: [], cursor: null }),
  applySnapshot: () => {},
  applyChanges: () => {},
  getCursor: () => null,
  setCursor: () => {},
  transcriptWindow: () => undefined,
  putTranscriptWindow: () => {},
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    replica: fakeReplica,
    sessions: storeSessions,
    drafts: storeDrafts,
    setSessionDraft: storeActions.setSessionDraft,
    resumeAndSend: storeActions.resumeAndSend,
    setPanelMode: storeActions.setPanelMode,
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
    uiState: fakeUiState,
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useSession: (id: string | undefined) =>
      storeSessions.find((session) => session.sessionId === id),
    useSessionDraft: (id: string | undefined) => (id === undefined ? '' : (storeDrafts[id] ?? '')),
    useSessionExitKind: () => storeExitKind,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

// Voice + markdown touch browser APIs that are flaky under happy-dom — stub them.
vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('@/lib/markdown', () => ({
  renderMarkdown: (t: string) => `<p>${t}</p>`,
  isKnownRefPrefix: () => true,
}))

const { ChatView } = await import('./ChatView')

function meta(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    sessionId: asSessionId('s1'),
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActiveAt: '2026-06-03T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...over,
  } as unknown as SessionMeta
}

function item(id: string, cursor: string, text: string): TranscriptItem {
  return { id, cursor, role: 'assistant', text }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reads.length = 0
  fakeHub.subscribes.length = 0
  storeSessions = [meta({})]
  storeDrafts = {}
  storeExitKind = undefined
  fakeUiValues.clear()
  fakeUiListeners.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  // Let pending microtasks (the awaited tRPC query) settle inside act.
  await act(async () => {
    await Promise.resolve()
    // ChatView code-splits TranscriptFeed. A focused test run must not depend on
    // an earlier case having warmed that module before this helper settles.
    await vi.dynamicImportSettled()
    await Promise.resolve()
  })
}

describe('ChatView read-then-subscribe', () => {
  it('double Escape interrupts a working native turn and recalls its prompt', async () => {
    storeSessions = [
      meta({
        agentState: {
          phase: 'working',
          since: '2026-06-03T00:00:01.000Z',
          nativeSubagentCount: 0,
        },
      }),
    ]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [{ id: 'u1', cursor: 'c1', role: 'user', text: 'tighten the copy' }],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()

    const textarea = container.querySelector('textarea')
    if (!textarea) throw new Error('chat composer missing')
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(fakeTrpc.sessions.interrupt.mutate).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(storeActions.setSessionDraft).toHaveBeenCalledWith('s1', 'tighten the copy')
  })

  // POD-1214: the chord is armed by LIVENESS, not by the observed phase. The
  // observation lags the agent, so a session that has gone quiet-but-busy (or
  // whose observer is a beat behind) used to swallow both Escapes in silence —
  // the exact moment the operator wants out.
  it('interrupts a LIVE session whose observed phase is not working', async () => {
    storeSessions = [meta({ status: 'live', agentState: undefined })]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [{ id: 'u1', cursor: 'c1', role: 'user', text: 'keep going' }],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()

    const textarea = container.querySelector('textarea')
    if (!textarea) throw new Error('chat composer missing')
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(fakeTrpc.sessions.interrupt.mutate).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('leaves the chord inert on a session that is not running', async () => {
    storeSessions = [meta({ status: 'exited', agentState: undefined })]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false })
    })
    await flush()

    const textarea = container.querySelector('textarea')
    if (!textarea) throw new Error('chat composer missing')
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(fakeTrpc.sessions.interrupt.mutate).not.toHaveBeenCalled()
  })

  // A refusal RESOLVES `{ ok: false }` — it does not throw. Swallowing it made a
  // stop that never reached the agent look exactly like one that worked.
  it('shows why a refused stop did not stop anything', async () => {
    fakeTrpc.sessions.interrupt.mutate.mockResolvedValueOnce({
      ok: false,
      reason: 'Codex only takes an interrupt while it is working',
    })
    storeSessions = [meta({ status: 'live', agentKind: 'codex', agentState: undefined })]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false })
    })
    await flush()

    const textarea = container.querySelector('textarea')
    if (!textarea) throw new Error('chat composer missing')
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()

    const notice = container.querySelector('[data-notice="interrupt-error"]')
    expect(notice?.textContent).toContain('Not stopped')
    expect(notice?.textContent).toContain('only takes an interrupt while it is working')
  })

  it('renders a LIVE session transcript from the initial read even with ZERO hub deltas', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    // The read-then-subscribe effect fires a transcriptRead.
    expect(reads).toHaveLength(1)
    expect(reads[0]?.input).toMatchObject({ sessionId: asSessionId('s1'), direction: 'before' })
    // Resolve it with a window — and push NO hub deltas.
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'hello from read'), item('b', 'c2', 'world')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    // The regression: items render purely from the read, no live stream needed.
    expect(container.textContent).toContain('hello from read')
    expect(container.textContent).toContain('world')
    // And the live subscribe used the read's tail as `since`.
    expect(fakeHub.subscribes).toHaveLength(1)
    expect(fakeHub.subscribes[0]).toMatchObject({ sessionId: asSessionId('s1'), since: 'c2' })
  })

  it('merges a live delta without duplicating an item already in the read window', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'first'), item('b', 'c2', 'second')],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()
    const cb = fakeHub.subscribes[0]?.cb
    // A live delta that REPEATS the last read item (c2) plus a genuinely new one.
    await act(async () => {
      cb?.([item('b', 'c2', 'second'), item('c', 'c3', 'third')], { reset: false })
    })
    await flush()
    expect(container.textContent).toContain('third')
    // 'second' must appear exactly once (no duplicate from the overlapping delta).
    const occurrences = container.textContent?.split('second').length ?? 0
    expect(occurrences - 1).toBe(1)
  })

  it('re-reads the window when a reset delta arrives', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'old content')],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
    expect(reads).toHaveLength(1)
    const cb = fakeHub.subscribes[0]?.cb
    await act(async () => {
      cb?.([], { reset: true })
    })
    // A reset triggers a fresh read.
    expect(reads).toHaveLength(2)
    await act(async () => {
      reads[1]?.resolve({
        items: [item('z', 'c9', 'fresh content')],
        head: 'c9',
        tail: 'c9',
        hasMore: false,
      })
    })
    await flush()
    expect(container.textContent).toContain('fresh content')
  })

  it('shows the standby state when the read resolves empty', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false })
    })
    await flush()
    expect(container.querySelector('[data-testid="transcript-empty-state"]')).not.toBeNull()
  })

  it('does a read-then-subscribe for a PARKED (hibernated) session too — no parked gate', async () => {
    storeSessions = [meta({ status: 'hibernated' })]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    // Same uniform path: an initial read, then a subscribe — no separate parked fetch.
    expect(reads).toHaveLength(1)
    await act(async () => {
      reads[0]?.resolve({
        items: [item('p', 'cp', 'parked history')],
        head: 'cp',
        tail: 'cp',
        hasMore: false,
      })
    })
    await flush()
    expect(container.textContent).toContain('parked history')
    expect(fakeHub.subscribes).toHaveLength(1)
  })

  it('makes the real operator row sticky after collapsed tools but excludes delivered mail', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    const tools: TranscriptItem[] = [
      { id: 't1', cursor: 'c1', role: 'tool', text: '', toolName: 'Read', toolResult: 'ok' },
      { id: 't2', cursor: 'c2', role: 'tool', text: '', toolName: 'Grep', toolResult: 'ok' },
    ]
    const prompt: TranscriptItem = {
      id: 'u1',
      cursor: 'c3',
      role: 'user',
      text: 'LATEST PROMPT after tools',
    }
    const deliveredMail: TranscriptItem = {
      id: 'u2',
      cursor: 'c4',
      role: 'user',
      text: `[podium message msg_sticky · from issue:POD-16 · to your session · reply: podium mail reply msg_sticky]
This is agent mail, not the operator's latest prompt.
[end podium message msg_sticky]`,
    }
    await act(async () => {
      reads[0]?.resolve({
        items: [...tools, prompt, deliveredMail],
        head: 'c1',
        tail: 'c4',
        hasMore: false,
      })
    })
    await flush()

    const userRow = [...container.querySelectorAll<HTMLElement>('.transcript-row')].find((el) =>
      el.textContent?.includes('LATEST PROMPT after tools'),
    )
    expect(userRow).toBeDefined()
    if (!userRow) return
    // Two transcript tool blocks collapse into row 0, so the user block at
    // block index 2 is rendered as row 1. Sticky lookup must use that row index.
    expect(userRow.dataset.block).toBe('1')
    expect(userRow.dataset.operatorPrompt).toBe('true')
    // POD-993 round 2: the pin left the column. The row stays in flow and is
    // merely MARKED as one the shelf drawn over the feed may carry.
    expect(userRow.dataset.pinnable).toBe('true')
    expect(userRow.className).not.toContain('sticky')
    expect(container.querySelector('[data-testid="sticky-user-message"]')).toBeNull()

    const mailRow = [...container.querySelectorAll<HTMLElement>('.transcript-row')].find((el) =>
      el.textContent?.includes('1 note from Podium'),
    )
    expect(mailRow).toBeDefined()
    expect(mailRow?.dataset.operatorPrompt).toBeUndefined()
    expect(mailRow?.dataset.pinnable).toBeUndefined()
  })

  it('keeps operator prompts in normal flow when the device preference is disabled', async () => {
    fakeUiValues.set('podium.chat.stickyPrompts', 'false')
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [
          { id: 'u1', cursor: 'c1', role: 'user', text: 'NON STICKY PROMPT' },
          item('a1', 'c2', 'answer'),
        ],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()

    const userRow = [...container.querySelectorAll<HTMLElement>('.transcript-row')].find((el) =>
      el.textContent?.includes('NON STICKY PROMPT'),
    )
    expect(userRow?.dataset.operatorPrompt).toBe('true')
    expect(userRow?.className).not.toContain('sticky')
    // With the preference off no row is offered to the shelf at all.
    expect(userRow?.dataset.pinnable).toBeUndefined()
    expect(container.querySelector('[data-testid="pinned-brief"]')).toBeNull()
  })
})

describe('ChatView composer', () => {
  it('shows the queue position returned by a busy live session', async () => {
    fakeTrpc.sessions.sendText.mutate.mockResolvedValueOnce({
      ok: true,
      queued: true,
      position: 2,
      disposition: 'queued',
    })
    storeDrafts = { s1: 'second thought' }
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()

    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    if (!textarea) return
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
    await flush()

    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: asSessionId('s1'), text: 'second thought' }),
    )
    expect(container.querySelector('.transcript-delivery')?.textContent).toBe(
      'pending · queue position 2',
    )
  })

  it('restores a queued chat message from the durable ledger after refresh', async () => {
    fakeTrpc.messages.ledger.query.mockResolvedValueOnce([
      {
        id: 'msg_queued',
        from: 'operator',
        to: 'session:s1',
        body: 'please do this next',
        createdAt: '2026-06-03T00:00:01.000Z',
        status: 'queued',
        queuePosition: 2,
      },
    ])
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()

    const queued = container.querySelector('[data-testid="queued-chat-message"]')
    expect(queued?.textContent).toContain('please do this next')
    // One noun for every not-yet-delivered bubble, whatever parked it.
    expect(queued?.textContent).toContain('pending · sends after this turn')
    expect(queued?.textContent).toContain('pending · sends after this turn · queue position 2')
    expect(queued?.querySelector('.msg-action--retract')).not.toBeNull()
    // The bubble IS the queue notice now: the composer no longer repeats the
    // count above the field.
    expect(container.querySelector('[data-notice="queue"]')).toBeNull()
  })

  it('restores a dead-lettered chat message with its reason and retries it', async () => {
    fakeTrpc.messages.ledger.query.mockResolvedValueOnce([
      {
        id: 'msg_failed',
        from: 'operator',
        to: 'session:s1',
        body: 'please try this again',
        createdAt: '2026-06-03T00:00:01.000Z',
        status: 'dead_letter',
        deliveryDeferredReason: 'never-live',
      },
      {
        id: 'msg_other_session',
        from: 'operator',
        to: 'session:s2',
        body: 'do not show this here',
        createdAt: '2026-06-03T00:00:02.000Z',
        status: 'dead_letter',
        deliveryDeferredReason: 'teardown',
      },
      {
        id: 'msg_delivered',
        from: 'operator',
        to: 'session:s1',
        body: 'already delivered',
        createdAt: '2026-06-03T00:00:03.000Z',
        status: 'delivered',
      },
      {
        id: 'msg_delivered_then_failed',
        from: 'operator',
        to: 'session:s1',
        body: 'delivery later failed',
        createdAt: '2026-06-03T00:00:04.000Z',
        status: 'dead_letter',
        deliveredAt: '2026-06-03T00:00:04.500Z',
        deliveredTo: 'session:s1',
        deliveryDeferredReason: 'delivery-failed',
      },
    ])
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()

    const failed = container.querySelector('[data-testid="dead-lettered-chat-message"]')
    expect(failed?.textContent).toContain('please try this again')
    expect(failed?.textContent).toContain('not delivered · session never became ready')
    expect(container.textContent).not.toContain('do not show this here')
    expect(container.textContent).not.toContain('already delivered')
    expect(container.textContent).toContain('delivery later failed')
    expect(container.textContent).toContain('not delivered · delivery failed')

    await act(async () => {
      failed?.querySelector<HTMLButtonElement>('[aria-label="Retry failed message"]')?.click()
      await Promise.resolve()
    })
    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', text: 'please try this again' }),
    )
  })

  describe('dead-letter retry state matrix', () => {
    const failedRow = {
      id: 'msg_failed_matrix',
      from: 'operator',
      to: 'session:s1',
      body: 'retry this safely',
      createdAt: '2026-06-03T00:00:01.000Z',
      status: 'dead_letter',
      deliveryDeferredReason: 'delivery-failed',
    } as const

    it.each([
      {
        label: 'live',
        session: meta({ status: 'live' }),
        exitKind: undefined,
        route: 'send',
      },
      {
        label: 'hibernated',
        session: meta({ status: 'hibernated', resumable: true }),
        exitKind: undefined,
        route: 'resume',
      },
      {
        label: 'exited resumable',
        session: meta({ status: 'exited', resumable: true }),
        exitKind: undefined,
        route: 'resume',
      },
      {
        label: 'exited non-resumable',
        session: meta({ status: 'exited', resumable: false }),
        exitKind: undefined,
        route: null,
      },
      {
        label: 'gone',
        session: null,
        exitKind: 'removed',
        route: null,
      },
      {
        label: 'archived resumable',
        session: meta({ status: 'hibernated', resumable: true, archived: true }),
        exitKind: undefined,
        route: null,
      },
      {
        label: 'archived non-resumable',
        session: meta({ status: 'exited', resumable: false, archived: true }),
        exitKind: undefined,
        route: null,
      },
    ] as const)(
      '$label session exposes only a deliverable retry route',
      async ({ session, exitKind, route }) => {
        storeSessions = session ? [session] : []
        storeExitKind = exitKind
        fakeTrpc.messages.ledger.query.mockResolvedValueOnce([failedRow])

        act(() => {
          root.render(<ChatView sessionId={asSessionId('s1')} />)
        })
        await flush()

        const retry = container.querySelector<HTMLButtonElement>(
          '[aria-label="Retry failed message"]',
        )
        expect(
          container.querySelector('[data-testid="dead-lettered-chat-message"]'),
        ).not.toBeNull()
        expect(retry !== null).toBe(route !== null)
        if (!retry || route === null) return

        await act(async () => {
          retry.click()
          await Promise.resolve()
        })
        if (route === 'send') {
          expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: 's1', text: failedRow.body }),
          )
          expect(storeActions.resumeAndSend).not.toHaveBeenCalled()
        } else {
          expect(storeActions.resumeAndSend).toHaveBeenCalledWith(
            asSessionId('s1'),
            failedRow.body,
          )
          expect(fakeTrpc.sessions.sendText.mutate).not.toHaveBeenCalled()
        }
      },
    )

    it('shows an accepted retry as a new pending attempt while preserving failure history', async () => {
      // The original failed attempt remains durable when the accepted retry's
      // immediate refresh reads the ledger again.
      fakeTrpc.messages.ledger.query.mockResolvedValue([failedRow])
      fakeTrpc.sessions.sendText.mutate.mockResolvedValueOnce({
        ok: true,
        disposition: 'accepted',
      })
      act(() => {
        root.render(<ChatView sessionId={asSessionId('s1')} />)
      })
      await flush()

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[aria-label="Retry failed message"]')
          ?.click()
        await Promise.resolve()
      })
      await flush()

      expect(container.querySelector('[data-testid="dead-lettered-chat-message"]')).not.toBeNull()
      const retryAttempt = container.querySelector(
        '.transcript-pending:not(.transcript-pending--failed)',
      )
      expect(retryAttempt?.textContent).toContain(failedRow.body)
      expect(retryAttempt?.textContent).toContain('pending')
    })

    it('shows a refused retry as a distinct failed attempt with the refusal reason', async () => {
      fakeTrpc.messages.ledger.query.mockResolvedValueOnce([failedRow])
      fakeTrpc.sessions.sendText.mutate.mockResolvedValueOnce({
        ok: false,
        disposition: 'dead_letter',
        reason: 'session became unavailable',
      })
      act(() => {
        root.render(<ChatView sessionId={asSessionId('s1')} />)
      })
      await flush()

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[aria-label="Retry failed message"]')
          ?.click()
        await Promise.resolve()
      })
      await flush()

      expect(container.querySelectorAll('.transcript-pending--failed')).toHaveLength(2)
      expect(container.textContent).toContain('not delivered — session became unavailable')
    })
  })

  it('stops calling a queued message pending once the CLI has been handed it', async () => {
    fakeTrpc.messages.ledger.query.mockResolvedValueOnce([
      {
        id: 'msg_injected',
        from: 'operator',
        to: 'session:s1',
        body: 'merge this branch',
        createdAt: '2026-06-03T00:00:01.000Z',
        // Typed into the harness, not yet taken as a turn. The agent may already
        // be acting on it — Claude Code shows queued input to the running turn —
        // so a bubble that still says "sends after this turn" sits under the work
        // it caused and offers a Retract that can no longer retract (POD-1242).
        injectedAt: '2026-06-03T00:00:02.000Z',
        status: 'queued',
      },
    ])
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()

    const queued = container.querySelector('[data-testid="queued-chat-message"]')
    expect(queued?.textContent).toContain('merge this branch')
    expect(queued?.textContent).not.toContain('pending')
    expect(queued?.querySelector('.msg-action--retract')).toBeNull()
    // It reads as a message in flight, which is what it is: no reserved-place rim.
    expect(queued?.querySelector('.transcript-you-bubble--queued')).toBeNull()
  })

  it('retracts a pending durable message and removes it from the transcript', async () => {
    fakeTrpc.messages.ledger.query.mockResolvedValueOnce([
      {
        id: 'msg_retract',
        from: 'operator',
        to: 'session:s1',
        body: 'do not send this',
        createdAt: '2026-06-03T00:00:01.000Z',
        status: 'queued',
      },
    ])
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()

    const retract = container.querySelector<HTMLButtonElement>(
      '[aria-label="Retract pending message"]',
    )
    expect(retract).not.toBeNull()
    await act(async () => {
      retract?.click()
      await Promise.resolve()
    })

    expect(fakeTrpc.messages.cancel.mutate).toHaveBeenCalledWith({ id: 'msg_retract' })
    expect(container.textContent).not.toContain('do not send this')
  })

  it('does not submit Enter during composition and submits after composition ends', async () => {
    storeDrafts = { s1: '日本語' }
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    if (!textarea) return

    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
            isComposing: true,
            ...modifiers,
          }),
        )
      }
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      await Promise.resolve()
    })

    expect(fakeTrpc.sessions.sendText.mutate).not.toHaveBeenCalled()

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })

    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledTimes(1)
    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: asSessionId('s1'), text: '日本語' }),
    )
  })

  it('sends a staged attachment ref without pasting its path into message text', async () => {
    const attachment = {
      id: 'staged-1',
      path: '/staged/shot.png',
      filename: 'shot.png',
      mediaType: 'image/png',
      kind: 'image' as const,
    }
    fakeTrpc.sessions.uploadImage.mutate.mockResolvedValueOnce({
      path: attachment.path,
      attachment,
    } as never)
    storeDrafts = { s1: 'describe this image' }
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    const input = container.querySelector<HTMLInputElement>('input[type=file]')
    const textarea = container.querySelector('textarea')
    expect(input).not.toBeNull()
    expect(textarea).not.toBeNull()
    if (!input || !textarea) return

    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['pixels'], 'shot.png', { type: 'image/png' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await vi.waitFor(() => expect(fakeTrpc.sessions.uploadImage.mutate).toHaveBeenCalledTimes(1))
    await act(async () => Promise.resolve())
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })

    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: asSessionId('s1'),
        text: 'describe this image',
        attachments: [attachment],
      }),
    )
  })

  it('shows the exact send refusal and preserves failed attachment chips', async () => {
    const attachment = {
      id: 'att-1',
      path: '/state/uploads/s1/att-1.png',
      filename: 'ready.png',
      mediaType: 'image/png',
      kind: 'image' as const,
    }
    fakeTrpc.sessions.uploadImage.mutate
      .mockResolvedValueOnce({ path: attachment.path, attachment } as never)
      .mockResolvedValueOnce({
        refusal: { reason: 'unsupported', detail: 'This agent refused failed.png' },
      } as never)
    fakeTrpc.sessions.sendText.mutate.mockResolvedValueOnce({
      ok: false,
      disposition: 'dead_letter',
      reason: 'driver rejected staged file',
    } as never)
    storeDrafts = { s1: 'send what is ready' }
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    const input = container.querySelector<HTMLInputElement>('input[type=file]')
    const textarea = container.querySelector('textarea')
    expect(input).not.toBeNull()
    expect(textarea).not.toBeNull()
    if (!input || !textarea) return

    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['ready'], 'ready.png', { type: 'image/png' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.waitFor(() => expect(fakeTrpc.sessions.uploadImage.mutate).toHaveBeenCalledTimes(1))
    })
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['failed'], 'failed.png', { type: 'image/png' })],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await vi.waitFor(() => expect(fakeTrpc.sessions.uploadImage.mutate).toHaveBeenCalledTimes(2))
    await act(async () => Promise.resolve())
    expect(container.textContent).toContain('This agent refused failed.png')

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    await vi.waitFor(() => expect(container.textContent).toContain('driver rejected staged file'))

    expect(fakeTrpc.sessions.sendText.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [attachment] }),
    )
    const strip = container.querySelector('[data-testid="attachment-strip"]')
    expect(strip?.textContent).toContain('failed.png')
    expect(strip?.textContent).toContain('This agent refused failed.png')
    expect(strip?.textContent).not.toContain('ready.png')
  })

  it('does not submit Enter when the browser only reports IME keyCode 229', async () => {
    storeDrafts = { s1: '中文' }
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    if (!textarea) return

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(enter, 'keyCode', { value: 229 })
    await act(async () => {
      textarea.dispatchEvent(enter)
      await Promise.resolve()
    })

    expect(fakeTrpc.sessions.sendText.mutate).not.toHaveBeenCalled()
  })
})

describe('ChatView delivered send boundary', () => {
  beforeEach(() => {
    storeSessions = [meta({ status: 'live' })]
    storeDrafts = { s1: 'already delivered' }
    fakeTrpc.messages.ledger.query.mockResolvedValue([])
  })

  it('does not rewrite a delivered bubble as failed when a provider error follows', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()

    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    if (!textarea) return
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
    await flush()

    const delivered = container.querySelector('.transcript-pending')
    expect(delivered?.textContent).toContain('already delivered')
    expect(delivered?.classList.contains('transcript-pending--failed')).toBe(false)

    storeSessions = [
      meta({
        status: 'live',
        agentState: {
          phase: 'errored',
          since: '2026-06-03T00:00:01.000Z',
          nativeSubagentCount: 0,
          error: { class: 'usage_limit', retryable: false, detail: 'balance exhausted' },
        },
      }),
    ]
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()

    expect(container.querySelector('.transcript-pending--failed')).toBeNull()
    expect(container.querySelector('.transcript-pending')?.textContent).toContain(
      'already delivered',
    )
  })
})

/**
 * SENDING INTO A HIBERNATED AGENT (POD-762).
 *
 * The bug was never in delivery — the server durably queues the text and drains
 * it when the resumed PTY binds. It was that the chat said nothing about any of
 * that and then handed the operator a terminal they had not asked for. These pin
 * the three halves of the answer: the panel stays on the surface the send came
 * from, the message reads as QUEUED rather than as eternally in flight, and the
 * durable row is pulled in at once so it is still there after you walk away.
 */
describe('ChatView sending into a hibernated session', () => {
  const submit = async (): Promise<void> => {
    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    if (!textarea) return
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    storeSessions = [meta({ status: 'hibernated' })]
    storeDrafts = { s1: 'pick this back up' }
  })

  it('wakes it, and keeps the panel on the chat the send came from', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()
    await submit()

    expect(storeActions.resumeAndSend).toHaveBeenCalledWith(asSessionId('s1'), 'pick this back up')
    // The live path is not the parked path.
    expect(fakeTrpc.sessions.sendText.mutate).not.toHaveBeenCalled()
    // The mode is pinned to chat as part of the send, so the parked→live flip
    // that follows the wake cannot swap the conversation for a booting terminal.
    expect(storeActions.setPanelMode).toHaveBeenCalledWith(asSessionId('s1'), 'chat')
  })

  it('shows the message as queued rather than forever "sending…"', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()
    await submit()
    await flush()

    const bubble = container.querySelector('.transcript-pending')
    expect(bubble?.textContent).toContain('pick this back up')
    // 'pending' is the one word every not-yet-delivered bubble wears since
    // 5bc2fd241; the restored-from-ledger case above already asserts it. What
    // this case is really about is the NEGATIVE below — the bubble must not sit
    // in "sending…", which is the state that becomes a lie once the turn parks.
    expect(bubble?.textContent).toContain('pending')
    expect(bubble?.textContent).not.toContain('sending…')
  })

  it('pulls the durable ledger row in at once, so leaving does not lose it', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()
    const before = fakeTrpc.messages.ledger.query.mock.calls.length
    await submit()
    await flush()

    expect(fakeTrpc.messages.ledger.query.mock.calls.length).toBeGreaterThan(before)
    expect(fakeTrpc.messages.ledger.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: asSessionId('s1') }),
    )
  })
})
