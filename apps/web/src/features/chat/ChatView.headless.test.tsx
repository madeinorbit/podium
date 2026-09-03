import {
  asSessionId,
  asThreadId,
  type SessionId,
  type SessionMeta,
  type SessionMetaInput,
  type TranscriptItem,
} from '@podium/model'
import type { HeadlessActivityEvent, TurnPreviewMessage } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './test-support/client-core-mock'

// ---------------------------------------------------------------------------
// ChatView HEADLESS mode (concierge unification, Phase C): overlay row
// lifecycle on synthetic headlessActivity frames, turn-based composer gating,
// send routing through superagent.sendTurn / conciergeTurn, and the collapsed
// machine-context rendering. Mirrors ChatView.test.tsx's fake store/hub setup.
// ---------------------------------------------------------------------------

type DeltaCb = (items: TranscriptItem[], meta: { reset: boolean }) => void
type HeadlessCb = (e: HeadlessActivityEvent) => void
type PreviewCb = (sessionId: SessionId, frame: TurnPreviewMessage) => void

const fakeHub = {
  subscribes: [] as Array<{ sessionId: SessionId; since: string | undefined; cb: DeltaCb }>,
  headlessSubs: [] as Array<{ sessionId: SessionId; cb: HeadlessCb }>,
  previewSubs: [] as PreviewCb[],
  subscribeTranscript(sessionId: SessionId, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
  subscribeHeadless(sessionId: SessionId, cb: HeadlessCb): () => void {
    this.headlessSubs.push({ sessionId, cb })
    return () => {}
  },
  on(event: string, cb: PreviewCb): () => void {
    if (event !== 'turnPreview') return () => {}
    this.previewSubs.push(cb)
    return () => {
      const index = this.previewSubs.indexOf(cb)
      if (index >= 0) this.previewSubs.splice(index, 1)
    }
  },
}

const sendTurn = vi.fn(async () => ({ threadId: 'global', podiumSessionId: 'h1' }))
const concierge = vi.fn(async () => ({ threadId: 'c1', podiumSessionId: 'h1', isNew: false }))
const interruptTurn = vi.fn(async () => {})
const sendText = vi.fn(async () => {})

const fakeTrpc = {
  sessions: {
    transcriptRead: {
      query: vi.fn(async () => ({ items: [] as TranscriptItem[], hasMore: false })),
    },
    sendText: { mutate: sendText },
    answerAskUserQuestion: { mutate: vi.fn(async () => {}) },
    uploadImage: { mutate: vi.fn(async () => ({ path: '/x' })) },
  },
  superagent: {
    sendTurn: { mutate: sendTurn },
    concierge: { mutate: concierge },
    interruptTurn: { mutate: interruptTurn },
  },
}

let storeSessions: SessionMeta[] = []
let drafts: Record<string, string> = {}
// "Ask superagent (BTW)" (POD-1069): the session staged for the next turn.
let attachedSessionId: SessionId | null = null
const clearAttachedSession = vi.fn(() => {
  attachedSessionId = null
})

const fakeReplica = {
  available: false,
  transcriptWindow: () => undefined,
  putTranscriptWindow: () => {},
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    replica: fakeReplica,
    sessions: storeSessions,
    drafts,
    setSessionDraft: (id: string, text: string) => {
      drafts = { ...drafts, [id]: text }
    },
    resumeAndSend: vi.fn(async () => {}),
    setPanelMode: vi.fn(),
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
    getUserFocus: () => ({ view: 'workspace' as const }),
    attachedSessionId,
    clearAttachedSession,
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useReplicaIssues: () => (useStore() as unknown as { issues?: unknown[] }).issues ?? [],
    useSession: (id: string | undefined) =>
      storeSessions.find((session) => session.sessionId === id),
    useSessionDraft: (id: string | undefined) => (id === undefined ? '' : (drafts[id] ?? '')),
    useSessionExitKind: () => undefined,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})
vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('@/lib/markdown', () => ({ renderMarkdown: (t: string) => `<p>${t}</p>` }))

const { ChatView } = await import('./ChatView')

function meta(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    sessionId: asSessionId('h1'),
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
    headless: true,
    ...over,
  } as unknown as SessionMeta
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fakeHub.subscribes.length = 0
  fakeHub.headlessSubs.length = 0
  fakeHub.previewSubs.length = 0
  drafts = {}
  attachedSessionId = null
  storeSessions = [meta({})]
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
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function push(event: HeadlessActivityEvent): void {
  act(() => {
    for (const s of fakeHub.headlessSubs) s.cb(event)
  })
}

function pushPreview(text: string): void {
  act(() => {
    for (const cb of fakeHub.previewSubs) {
      cb(asSessionId('h1'), {
        type: 'turnPreview',
        sessionId: asSessionId('h1'),
        turnEpoch: 1,
        seq: 1,
        items: [{ kind: 'text', itemId: 'grok-assistant-1', text }],
      })
    }
  })
}

function mount(superThread = { threadId: asThreadId('global'), kind: 'global' as const }): void {
  act(() => {
    root.render(<ChatView sessionId={asSessionId('h1')} superThread={superThread} compact />)
  })
}

const overlayEl = () => container.querySelector('[data-headless-overlay]')
const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement

describe('ChatView headless mode', () => {
  it('subscribes to headlessActivity for the session', async () => {
    mount()
    await flush()
    expect(fakeHub.headlessSubs.map((s) => s.sessionId)).toEqual(['h1'])
  })

  it('overlay row lifecycle: partial-text shows, transcript items clear the text, turn-end removes it', async () => {
    mount()
    await flush()
    expect(overlayEl()).toBeNull()
    push({ kind: 'turn-start' })
    push({ kind: 'partial-text', text: 'streaming hello' })
    expect(overlayEl()?.textContent).toContain('streaming hello')
    // The real assistant item lands via the transcript tail → accumulated
    // partial text clears (the item now renders as a normal row).
    act(() => {
      for (const s of fakeHub.subscribes)
        s.cb([{ id: 'a1', cursor: '1', role: 'assistant', text: 'streaming hello world' }], {
          reset: false,
        })
    })
    expect(overlayEl()).toBeNull()
    // A later status frame mid-turn shows in the permanent tail…
    push({ kind: 'status', status: 'tool', label: 'Bash' })
    expect(container.querySelector('[data-testid="feed-tail"]')?.textContent).toContain(
      'running Bash',
    )
    // …and turn-end clears everything.
    push({ kind: 'turn-end' })
    expect(overlayEl()).toBeNull()
  })

  it('renders one streaming copy when legacy activity and turn preview carry the same text', async () => {
    mount()
    await flush()
    push({ kind: 'turn-start' })
    push({ kind: 'partial-text', text: 'one Grok answer' })
    expect(overlayEl()?.textContent).toContain('one Grok answer')
    pushPreview('one Grok answer')
    expect(overlayEl()).toBeNull()
    expect(container.textContent?.split('one Grok answer')).toHaveLength(2)
  })

  // POD-3219: the gate is on the SEND. The textarea itself is never disabled —
  // the operator can keep writing while the turn runs and send when it ends.
  it('gates the send on the running turn, not PTY status, and never the box', async () => {
    storeSessions = [meta({ status: 'exited' })] // PTY status must be ignored
    mount()
    await flush()
    expect(textarea().disabled).toBe(false)
    expect(textarea().placeholder).not.toContain('Working')
    push({ kind: 'turn-start' })
    expect(textarea().disabled).toBe(false)
    expect(textarea().placeholder).toContain('Working')
    push({ kind: 'turn-end' })
    expect(textarea().placeholder).not.toContain('Working')
  })

  it('starts gated for a late-joining client when the query says the turn is running', async () => {
    act(() => {
      root.render(
        <ChatView
          sessionId={asSessionId('h1')}
          superThread={{ threadId: asThreadId('global'), kind: 'global' }}
          compact
          initialTurnRunning
        />,
      )
    })
    await flush()
    expect(textarea().disabled).toBe(false)
    expect(textarea().placeholder).toContain('Working')
    expect(container.querySelector('[data-tail="working"]')?.textContent).toContain('Working')
    expect(container.querySelector('[title="Stop this turn"]')).not.toBeNull()
  })

  it('keeps the first submitted prompt visible through the fresh-thread session swap', async () => {
    act(() => {
      root.render(
        <ChatView
          sessionId={asSessionId('h1')}
          superThread={{ threadId: asThreadId('global'), kind: 'global' }}
          compact
          initialTurnRunning
          initialPendingText="Plan the release"
        />,
      )
    })
    await flush()
    expect(container.textContent).toContain('Plan the release')
    expect(container.querySelector('[data-tail="working"]')?.textContent).toContain('Working')
    expect(container.querySelector('[data-testid="transcript-empty-state"]')).toBeNull()
  })

  it('shows a Stop control while a turn runs, wired to interruptTurn', async () => {
    mount()
    await flush()
    expect(container.querySelector('[title="Stop this turn"]')).toBeNull()
    push({ kind: 'turn-start' })
    const stop = container.querySelector('[title="Stop this turn"]') as HTMLButtonElement
    expect(stop).not.toBeNull()
    act(() => stop.click())
    expect(interruptTurn).toHaveBeenCalledWith({ threadId: 'global' })
  })

  it('routes send through superagent.sendTurn (never sessions.sendText)', async () => {
    drafts = { h1: 'do the thing' } // draft lives in the store, keyed by session
    mount()
    await flush()
    const send = container.querySelector('[title="Send (Enter)"]') as HTMLButtonElement
    await act(async () => {
      send.click()
    })
    // Every turn carries what the user has on screen (#225), and since the
    // superagent header grew a model picker, the picker's current selection
    // travels with it — 'auto' being "follow the configured default".
    expect(sendTurn).toHaveBeenCalledWith({
      threadId: 'global',
      text: 'do the thing',
      focus: { view: 'workspace' },
      model: 'auto',
      effort: 'auto',
    })
    expect(sendText).not.toHaveBeenCalled()
  })

  /**
   * "ASK SUPERAGENT (BTW)" (POD-1069). The action used to aim the dock at a
   * `btw_<sessionId>` thread this pane has not been able to render since
   * POD-782 — a blank, composer-less box until a reload. The session is context
   * on the one chat now, so these pin the two halves that replace it: the
   * composer SAYS the attachment is there, and the turn CARRIES it.
   */
  it('names the attached session on the composer and sends it with the turn', async () => {
    storeSessions = [meta({}), meta({ sessionId: asSessionId('s-other'), name: 'auth refactor' })]
    attachedSessionId = asSessionId('s-other')
    drafts = { h1: 'what is it stuck on?' }
    mount()
    await flush()

    // The chip is the whole reason the menu item does not read as a no-op.
    const chip = container.querySelector('[data-notice="attached"]')
    expect(chip?.textContent).toContain('auth refactor')

    const send = container.querySelector('[title="Send (Enter)"]') as HTMLButtonElement
    await act(async () => {
      send.click()
    })

    expect(sendTurn).toHaveBeenCalledWith({
      threadId: 'global',
      text: 'what is it stuck on?',
      focus: { view: 'workspace' },
      attachSessionId: 's-other',
      model: 'auto',
      effort: 'auto',
    })
    // Spent, not sticky: the NEXT message is an ordinary one.
    expect(clearAttachedSession).toHaveBeenCalledTimes(1)
  })

  it('keeps the attachment when the send is rejected', async () => {
    // The turn never reached the orchestrator, so the question is still
    // unanswered — dropping the session here would make the retry a weaker
    // question than the one the operator asked.
    storeSessions = [meta({}), meta({ sessionId: asSessionId('s-other'), name: 'auth refactor' })]
    attachedSessionId = asSessionId('s-other')
    drafts = { h1: 'what is it stuck on?' }
    sendTurn.mockRejectedValueOnce(new Error('offline'))
    mount()
    await flush()

    const send = container.querySelector('[title="Send (Enter)"]') as HTMLButtonElement
    await act(async () => {
      send.click()
    })

    expect(clearAttachedSession).not.toHaveBeenCalled()
  })

  it('routes a concierge thread send through superagent.concierge', async () => {
    drafts = { h1: 'file an issue' }
    mount({ threadId: 'c1', kind: 'concierge' as never, repoPath: '/repo' } as never)
    await flush()
    const send = container.querySelector('[title="Send (Enter)"]') as HTMLButtonElement
    await act(async () => {
      send.click()
    })
    expect(concierge).toHaveBeenCalledWith({
      repoPath: '/repo',
      text: 'file an issue',
      focus: { view: 'workspace' },
      model: 'auto',
      effort: 'auto',
    })
    expect(sendTurn).not.toHaveBeenCalled()
  })

  /**
   * The translated "turn is already running" copy is GONE with the refusal it
   * translated (POD-782): the server queues a second send now, so the client no
   * longer has a rejection to dress up. What remains is the honest general case
   * — a refusal the server DOES still make (the terminal one-writer lock) is
   * shown verbatim rather than re-worded into a guess about which one it was.
   */
  it('surfaces a sendTurn rejection inline, in the server’s own words', async () => {
    sendTurn.mockRejectedValueOnce(
      new Error('this thread is open in a terminal session — close it to chat here'),
    )
    drafts = { h1: 'x' }
    mount()
    await flush()
    const send = container.querySelector('[title="Send (Enter)"]') as HTMLButtonElement
    await act(async () => {
      send.click()
    })
    expect(container.textContent).toContain('open in a terminal session')
  })

  /**
   * QUEUED IS NOT FAILED (POD-782). A send that arrives mid-turn resolves with
   * `queued: true`, and the optimistic bubble must take the queued affordance —
   * the same one the PTY path has always had — instead of sitting in a "sending"
   * state that settles into a lie 30 seconds later.
   */
  it('marks the optimistic bubble queued when the server queues the turn', async () => {
    sendTurn.mockResolvedValueOnce({
      threadId: 'global',
      podiumSessionId: 'h1',
      queued: true,
    } as never)
    drafts = { h1: 'and another thing' }
    mount()
    await flush()
    const send = container.querySelector('[title="Send (Enter)"]') as HTMLButtonElement
    await act(async () => {
      send.click()
    })
    await flush()
    // The text is still on screen, wearing the queued mark and NOT the failed one.
    // The mark READS 'pending' — 5bc2fd241 settled on one word for every
    // not-yet-delivered bubble so a revived message and a queued one do not
    // describe the same state two ways. `state` is still 'queued'; only the copy
    // moved, which is why this asserts the rendered word rather than the state.
    expect(container.textContent).toContain('and another thing')
    expect(container.querySelector('.transcript-delivery')?.textContent).toBe('pending')
    expect(container.querySelector('.transcript-pending--failed')).toBeNull()
  })

  it('collapses machine-authored [CONCIERGE CONTEXT] user blocks into a disclosure row', async () => {
    mount()
    await flush()
    act(() => {
      for (const s of fakeHub.subscribes)
        s.cb(
          [
            {
              id: 'u1',
              cursor: '1',
              role: 'user',
              text: '[CONCIERGE CONTEXT — repo digest]\nlots of machine context',
            },
          ],
          { reset: false },
        )
    })
    expect(container.textContent).toContain('repo context')
    expect(container.textContent).not.toContain('lots of machine context')
  })

  it('does not subscribe to headlessActivity for a normal (non-headless) session', async () => {
    storeSessions = [meta({ headless: false })]
    mount()
    await flush()
    expect(fakeHub.headlessSubs).toHaveLength(0)
  })
})
