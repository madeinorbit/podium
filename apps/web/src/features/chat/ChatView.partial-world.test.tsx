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

/**
 * THE CHAT SURFACE OVER A PARTIAL WORLD (POD-405).
 *
 * Three properties from `docs/multi-user-readiness.md`, driven through the real
 * component rather than asserted about the slice alone — because every one of
 * them is a claim about what a user SEES, and the slice being right does not
 * prove the view read it.
 *
 *  1. An INVISIBLE referent (POD-1077 eviction: a share revoked, the row gone
 *     from the replica, its revision untouched) renders as neither
 *     loading-forever nor deleted.
 *  2. An EVICTED open chat leaves with NO deletion affordance — no toast, no
 *     tombstone, no removal animation — and does not re-request the vanished id
 *     (a heal loop against a row that is not coming back).
 *  3. NO COMMAND PAYLOAD carries actor, owner or origin (§3.1.3 A3 / ADR 3 D7:
 *     the authority stamps both halves from the authenticated transport).
 */

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
}

const reads: ReadCall[] = []
const sendText = vi.fn(async (_input: Record<string, unknown>) => ({ disposition: 'delivered' }))
const answerAsk = vi.fn(async (_input: Record<string, unknown>) => {})
const fakeTrpc = {
  sessions: {
    transcriptRead: {
      query(input: ReadCall['input']) {
        return new Promise((resolve) => {
          reads.push({ input, resolve })
        })
      },
    },
    sendText: { mutate: sendText },
    answerAskUserQuestion: { mutate: answerAsk },
    uploadImage: { mutate: vi.fn(async () => ({ path: '/x' })) },
  },
  messages: { ledger: { query: vi.fn(async (): Promise<unknown> => []) } },
}

let storeSessions: SessionMeta[] = []
let storeDrafts: Record<string, string> = {}
let exits: Record<string, 'removed' | 'evicted'> = {}

const fakeReplica = {
  available: false,
  transcriptWindow: () => undefined,
  putTranscriptWindow: () => {},
  exitKind: (_entity: string, id: string) => exits[id],
}

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hub: fakeHub,
    trpc: fakeTrpc,
    replica: fakeReplica,
    sessions: storeSessions,
    drafts: storeDrafts,
    setSessionDraft: vi.fn(),
    resumeAndSend: vi.fn(async () => {}),
    openFile: vi.fn(),
    httpOrigin: 'http://x',
    tldrSession: vi.fn(),
    getUserFocus: () => ({ view: 'chat' }),
    issues: [],
    superThreads: [],
  })
  return {
    useStore,
    useReplicaIssues: () => [],
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

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

const item = (id: string, cursor: string, text: string): TranscriptItem => ({
  id,
  cursor,
  role: 'assistant',
  text,
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reads.length = 0
  fakeHub.subscribes.length = 0
  storeSessions = [meta({})]
  storeDrafts = {}
  exits = {}
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

describe('an invisible referent', () => {
  it('renders as neither loading-forever nor deleted', async () => {
    // The session is not in the replica AND the replica reports it evicted:
    // visible to someone, not to this principal.
    storeSessions = []
    exits.s1 = 'evicted'
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await flush()

    const text = container.textContent ?? ''
    // Not loading-forever: the loading object is not shown for a terminal referent, and
    // no amount of flushing turns it into one.
    expect(text).not.toContain('Loading transcript')
    expect(container.querySelector('[role="status"]')).toBeNull()
    // Not deleted: nothing on screen says the session was removed, and there is
    // no tombstone row standing in for it.
    expect(text.toLowerCase()).not.toContain('deleted')
    expect(text.toLowerCase()).not.toContain('removed')
    expect(text.toLowerCase()).not.toContain('no longer exists')
  })

  it('settles the bounded loading state once an empty read resolves', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    expect(container.textContent).toContain('Loading transcript')
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false })
    })
    await flush()
    expect(container.textContent).not.toContain('Loading transcript')
    expect(container.querySelector('[data-testid="transcript-empty-state"]')).not.toBeNull()
  })
})

describe('an evicted open chat', () => {
  it('leaves once, with no deletion affordance and no heal loop', async () => {
    const onLeave = vi.fn()
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} onLeave={onLeave} />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [item('a', 'c1', 'hello')],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
    expect(container.textContent).toContain('hello')
    const readsBefore = reads.length

    // The share is revoked: the row leaves the replica WITHOUT its revision
    // moving, and the replica records the exit as an eviction.
    await act(async () => {
      storeSessions = []
      exits.s1 = 'evicted'
      root.render(<ChatView sessionId={asSessionId('s1')} onLeave={onLeave} />)
    })
    await flush()

    expect(onLeave).toHaveBeenCalledWith(asSessionId('s1'))
    const text = container.textContent ?? ''
    expect(text.toLowerCase()).not.toContain('deleted')
    expect(text.toLowerCase()).not.toContain('was removed')
    // No heal loop: the vanished id is never re-requested.
    expect(reads.length).toBe(readsBefore)
  })

  it('gives a DELETED session the same exit as an evicted one', async () => {
    const seen: string[] = []
    for (const exit of ['evicted', 'removed'] as const) {
      storeSessions = []
      exits = { s1: exit }
      const localRoot = createRoot(document.createElement('div'))
      const onLeave = vi.fn()
      act(() => {
        localRoot.render(<ChatView sessionId={asSessionId('s1')} onLeave={onLeave} />)
      })
      await flush()
      seen.push(`${onLeave.mock.calls.length}`)
      act(() => localRoot.unmount())
    }
    // Indistinguishable by construction — §3.1.5's consistent-error rule applied
    // to the surface: a UI that treated the two differently would answer "does
    // this exist?" for an entity the principal may not see.
    expect(seen[0]).toBe(seen[1])
  })
})

describe('no chat payload carries attribution', () => {
  it('sends only the message and its idempotency key', async () => {
    storeDrafts = { s1: 'ship it' }
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({ items: [], hasMore: false })
    })
    await flush()

    const send = container.querySelector<HTMLButtonElement>('button[title="Send (Enter)"]')
    expect(send).not.toBeNull()
    await act(async () => {
      send?.click()
    })
    await flush()

    expect(sendText).toHaveBeenCalledTimes(1)
    const payload = sendText.mock.calls[0]?.[0] ?? {}
    expect(Object.keys(payload).sort()).toEqual(['mutationId', 'sessionId', 'text'])
    for (const forbidden of ['actor', 'actorId', 'owner', 'onBehalfOf', 'origin', 'userId']) {
      expect(payload).not.toHaveProperty(forbidden)
    }
  })

  it('answers a question without naming who answered', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [
          {
            id: 'q',
            cursor: 'c1',
            role: 'tool',
            text: '',
            toolName: 'AskUserQuestion',
            toolUseId: 'u1',
            toolInputJson: JSON.stringify({
              questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] }],
            }),
          },
        ],
        head: 'c1',
        tail: 'c1',
        hasMore: false,
      })
    })
    await flush()
    const yes = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Yes'),
    )
    expect(yes).toBeDefined()
    await act(async () => {
      yes?.click()
    })
    await flush()
    expect(answerAsk).toHaveBeenCalledTimes(1)
    const payload = answerAsk.mock.calls[0]?.[0] ?? {}
    expect(Object.keys(payload).sort()).toEqual(['choices', 'sessionId'])
  })
})

describe('the attribution pair is rendered from server fields', () => {
  it('marks each row with its actor kind, and never invents the human half', async () => {
    act(() => {
      root.render(<ChatView sessionId={asSessionId('s1')} />)
    })
    await act(async () => {
      reads[0]?.resolve({
        items: [
          { id: 'u', cursor: 'c1', role: 'user', text: 'do it' },
          { id: 'a', cursor: 'c2', role: 'assistant', text: 'done', answer: true },
        ],
        head: 'c1',
        tail: 'c2',
        hasMore: false,
      })
    })
    await flush()

    const marks = [...container.querySelectorAll('[data-attribution]')]
    expect(marks.length).toBeGreaterThanOrEqual(2)
    expect(marks.map((m) => m.getAttribute('data-actor-kind'))).toEqual(
      expect.arrayContaining(['human', 'agent']),
    )
    // The agent half comes from the session's server-stamped identity.
    const agentMark = marks.find((m) => m.getAttribute('data-actor-kind') === 'agent')
    expect(agentMark?.getAttribute('data-actor')).toBe('claude-code')
    // A human turn's actor is the person, so the agent name is NOT borrowed.
    const humanMark = marks.find((m) => m.getAttribute('data-actor-kind') === 'human')
    expect(humanMark?.getAttribute('data-actor')).toBe('')
    // The on-behalf-of half is not on this wire yet (POD-1075): absent, and NOT
    // rendered as "nobody", which is a different and false claim.
    for (const mark of marks) {
      expect(mark.hasAttribute('data-on-behalf-of')).toBe(false)
      expect(mark.textContent).toBe('')
    }
  })
})
