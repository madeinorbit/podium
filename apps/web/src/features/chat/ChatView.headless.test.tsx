import type { HeadlessActivityEvent, SessionMeta, TranscriptItem } from '@podium/protocol'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// ChatView HEADLESS mode (concierge unification, Phase C): overlay row
// lifecycle on synthetic headlessActivity frames, turn-based composer gating,
// send routing through superagent.sendTurn / conciergeTurn, and the collapsed
// machine-context rendering. Mirrors ChatView.test.tsx's fake store/hub setup.
// ---------------------------------------------------------------------------

type DeltaCb = (items: TranscriptItem[], meta: { reset: boolean }) => void
type HeadlessCb = (e: HeadlessActivityEvent) => void

const fakeHub = {
  subscribes: [] as Array<{ sessionId: string; since: string | undefined; cb: DeltaCb }>,
  headlessSubs: [] as Array<{ sessionId: string; cb: HeadlessCb }>,
  subscribeTranscript(sessionId: string, since: string | undefined, cb: DeltaCb): () => void {
    this.subscribes.push({ sessionId, since, cb })
    return () => {}
  },
  subscribeHeadless(sessionId: string, cb: HeadlessCb): () => void {
    this.headlessSubs.push({ sessionId, cb })
    return () => {}
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
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
    getUserFocus: () => ({ view: 'workspace' as const }),
  })
  // The selector-store hook reads slices off the same store shape.
  return {
    useStore,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})
vi.mock('@/lib/voice', () => ({
  useVoiceInput: () => ({ supported: false, listening: false, toggle: vi.fn() }),
}))
vi.mock('@/lib/markdown', () => ({ renderMarkdown: (t: string) => `<p>${t}</p>` }))

const { ChatView } = await import('./ChatView')

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 'h1',
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
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fakeHub.subscribes.length = 0
  fakeHub.headlessSubs.length = 0
  drafts = {}
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

function mount(superThread = { threadId: 'global', kind: 'global' as const }): void {
  act(() => {
    root.render(<ChatView sessionId="h1" superThread={superThread} compact />)
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
    // A later status frame mid-turn shows the status overlay…
    push({ kind: 'status', status: 'tool', label: 'Bash' })
    expect(overlayEl()?.textContent).toContain('running Bash…')
    // …and turn-end clears everything.
    push({ kind: 'turn-end' })
    expect(overlayEl()).toBeNull()
  })

  it('gates the composer on the running turn, not PTY status', async () => {
    storeSessions = [meta({ status: 'exited' })] // PTY status must be ignored
    mount()
    await flush()
    expect(textarea().disabled).toBe(false)
    push({ kind: 'turn-start' })
    expect(textarea().disabled).toBe(true)
    push({ kind: 'turn-end' })
    expect(textarea().disabled).toBe(false)
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
    const send = container.querySelector('[title="Send (⌘/Ctrl+Enter)"]') as HTMLButtonElement
    await act(async () => {
      send.click()
    })
    // Every turn carries what the user has on screen (#225).
    expect(sendTurn).toHaveBeenCalledWith({
      threadId: 'global',
      text: 'do the thing',
      focus: { view: 'workspace' },
    })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('routes a concierge thread send through superagent.concierge', async () => {
    drafts = { h1: 'file an issue' }
    mount({ threadId: 'c1', kind: 'concierge' as never, repoPath: '/repo' } as never)
    await flush()
    const send = container.querySelector('[title="Send (⌘/Ctrl+Enter)"]') as HTMLButtonElement
    await act(async () => {
      send.click()
    })
    expect(concierge).toHaveBeenCalledWith({
      repoPath: '/repo',
      text: 'file an issue',
      focus: { view: 'workspace' },
    })
    expect(sendTurn).not.toHaveBeenCalled()
  })

  it('surfaces a sendTurn rejection inline (turn running / terminal lock)', async () => {
    sendTurn.mockRejectedValueOnce(new Error('a turn is already running on this thread'))
    drafts = { h1: 'x' }
    mount()
    await flush()
    const send = container.querySelector('[title="Send (⌘/Ctrl+Enter)"]') as HTMLButtonElement
    await act(async () => {
      send.click()
    })
    expect(container.textContent).toContain('a turn is already running on this thread')
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
