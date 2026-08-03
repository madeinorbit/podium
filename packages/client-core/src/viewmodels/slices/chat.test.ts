import type { SessionMeta, TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { buildChatRows, pairToolResults } from '../chat'
import {
  chatActivityState,
  chatSendRoute,
  chatSessionReference,
  composerState,
  isOperatorPrompt,
  lastAnswer,
  livePendingAskIndex,
  queuedState,
  renderableRows,
  transcriptAttribution,
  transcriptPhase,
  transcriptSearchState,
  UNKNOWN_THREAD_REFUSAL,
  visibleOffer,
} from './chat'

const item = (over: Partial<TranscriptItem> & Pick<TranscriptItem, 'role'>): TranscriptItem => ({
  id: over.id ?? `i-${Math.random().toString(36).slice(2)}`,
  text: '',
  ...over,
})

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    sessionId: 's1',
    cwd: '/repo',
    status: 'live',
    geometry: { cols: 80, rows: 24 },
    epoch: 1,
    clientCount: 0,
    controllerId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    origin: 'operator',
    archived: false,
    readAt: null,
    unread: false,
    title: 't',
    ...over,
  }) as unknown as SessionMeta

const blocksOf = (items: TranscriptItem[]) => pairToolResults(items)

describe('attribution is a pair, read and never synthesised', () => {
  it('keeps actor and on-behalf-of apart, and reports an uncarried half as unknown', () => {
    const pair = transcriptAttribution(
      item({ role: 'assistant', text: 'hi' }),
      session({ name: 'Reviewer', agentKind: 'claude-code' } as Partial<SessionMeta>),
    )
    expect(pair.actorKind).toBe('agent')
    expect(pair.actorId).toBe('Reviewer')
    // The wire does not carry the human half yet (POD-1075). Unknown must not
    // read as "no human behind it" — that is a different, and wrong, statement.
    expect(pair.onBehalfOf).toBeUndefined()
    expect(pair.delegated).toBeUndefined()
  })

  it('never borrows the agent name for a human turn', () => {
    const pair = transcriptAttribution(
      item({ role: 'user', text: 'do the thing' }),
      session({ name: 'Reviewer' } as Partial<SessionMeta>),
    )
    expect(pair.actorKind).toBe('human')
    expect(pair.actorId).toBeUndefined()
  })

  it('reads a carried null as "no human", distinct from unknown', () => {
    const pair = transcriptAttribution(
      item({ role: 'assistant', text: 'x' }),
      session({ onBehalfOf: null } as unknown as Partial<SessionMeta>),
    )
    expect(pair.onBehalfOf).toBeNull()
    expect(pair.delegated).toBe(false)
  })
})

describe('a chat renders a partial world', () => {
  const reference = (state: 'present' | 'not-visible' | 'removed' | 'pending') =>
    ({ state, id: 's1' }) as ReturnType<typeof chatSessionReference>

  it('an evicted session is neither loading nor deleted — the view just leaves', () => {
    const evicted = chatSessionReference('s1', [], () => 'evicted')
    expect(evicted.state).toBe('not-visible')
    expect(evicted.value).toBeUndefined()
    expect(
      transcriptPhase({
        reference: evicted,
        blockCount: 0,
        pendingCount: 0,
        initialLoaded: false,
      }),
    ).toBe('gone')
  })

  it('gives an evicted and a deleted session the SAME phase — no existence oracle', () => {
    const evicted = chatSessionReference('s1', [], () => 'evicted')
    const removed = chatSessionReference('s1', [], () => 'removed')
    expect(
      transcriptPhase({ reference: evicted, blockCount: 0, pendingCount: 0, initialLoaded: true }),
    ).toBe(
      transcriptPhase({ reference: removed, blockCount: 0, pendingCount: 0, initialLoaded: true }),
    )
  })

  it('does not spin forever: a resolved read with no blocks is empty, not loading', () => {
    expect(
      transcriptPhase({
        reference: reference('present'),
        blockCount: 0,
        pendingCount: 0,
        initialLoaded: true,
      }),
    ).toBe('empty')
  })

  it('a re-granted session is present again despite its stale exit record', () => {
    const back = chatSessionReference('s1', [session()], () => 'evicted')
    expect(back.state).toBe('present')
  })
})

describe('superagent threads are per-user and private', () => {
  const composer = { sendable: true, canResume: false }

  it('routes the principal’s own thread to its turn mutation', () => {
    expect(
      chatSendRoute({
        sessionId: 's1',
        headless: true,
        superThread: { threadId: 't1', kind: 'global' },
        composer,
        ownThreadIds: new Set(['t1']),
      }),
    ).toEqual({ kind: 'superagent-turn', threadId: 't1' })
  })

  it('refuses a FOREIGN thread and a NONEXISTENT one identically', () => {
    const foreign = chatSendRoute({
      sessionId: 's1',
      headless: true,
      superThread: { threadId: 'someone-elses', kind: 'global' },
      composer,
      ownThreadIds: new Set(['mine']),
    })
    const nonexistent = chatSendRoute({
      sessionId: 's1',
      headless: true,
      superThread: { threadId: 'never-existed', kind: 'global' },
      composer,
      ownThreadIds: new Set(['mine']),
    })
    expect(foreign).toEqual({ kind: 'refused', reason: UNKNOWN_THREAD_REFUSAL })
    expect(foreign).toEqual(nonexistent)
  })

  it('falls back to the server as the only gate when no roster is held', () => {
    expect(
      chatSendRoute({
        sessionId: 's1',
        headless: true,
        superThread: { threadId: 't1', kind: 'global' },
        composer,
      }),
    ).toEqual({ kind: 'superagent-turn', threadId: 't1' })
  })

  it('routes a concierge thread by repo path, and a native session by id', () => {
    expect(
      chatSendRoute({
        sessionId: 's1',
        headless: true,
        superThread: { threadId: 't1', kind: 'concierge', repoPath: '/repo' },
        composer,
        ownThreadIds: new Set(['t1']),
      }),
    ).toEqual({ kind: 'concierge', repoPath: '/repo' })
    expect(
      chatSendRoute({ sessionId: 's1', headless: false, superThread: undefined, composer }),
    ).toEqual({
      kind: 'session',
      sessionId: 's1',
    })
    expect(
      chatSendRoute({
        sessionId: 's1',
        headless: false,
        superThread: undefined,
        composer: { sendable: false, canResume: true },
      }),
    ).toEqual({ kind: 'resume', sessionId: 's1' })
  })
})

describe('search maps a block hit to the row that renders it', () => {
  const items = [
    item({ role: 'user', text: 'find me' }),
    item({ role: 'tool', toolName: 'Bash', toolInput: 'find me', toolUseId: 'a' }),
    item({ role: 'tool', toolName: 'Read', toolInput: 'nope', toolUseId: 'b' }),
    item({ role: 'assistant', text: 'done' }),
  ]
  const blocks = blocksOf(items)
  const rows = buildChatRows(blocks)

  it('finds hits inside a collapsed batch and resolves them to the batch row', () => {
    const state = transcriptSearchState({ blocks, rows, query: 'find me', cursor: 0 })
    expect(state.total).toBe(2)
    expect(state.position).toBe(1)
    expect(state.activeMatch).toBe(0)
    expect(state.activeRow).toBe(0)
    const second = transcriptSearchState({ blocks, rows, query: 'find me', cursor: 1 })
    expect(second.activeMatch).toBe(1)
    // Block 1 is folded into the tools batch row, which is what the view scrolls to.
    expect(rows[second.activeRow ?? -1]?.kind).toBe('tools')
  })

  it('is inert with no query', () => {
    const state = transcriptSearchState({ blocks, rows, query: '  ', cursor: 0 })
    expect(state).toMatchObject({ total: 0, position: 0, filtering: false })
    expect(state.activeRow).toBeUndefined()
  })
})

describe('operator prompts and the sticky continuation', () => {
  const opts = { collapseMachineContext: false }

  it('excludes interrupts, blanks and (when collapsing) machine context', () => {
    expect(isOperatorPrompt(item({ role: 'user', text: 'hello' }), opts)).toBe(true)
    expect(isOperatorPrompt(item({ role: 'user', text: '  ' }), opts)).toBe(false)
    expect(isOperatorPrompt(item({ role: 'user', text: 'x', event: 'interrupt' }), opts)).toBe(
      false,
    )
    const ctx = item({ role: 'user', text: '[BTW CONTEXT] seed' })
    expect(isOperatorPrompt(ctx, opts)).toBe(true)
    expect(isOperatorPrompt(ctx, { collapseMachineContext: true })).toBe(false)
  })

  it('respects an envelope whose operator half is empty', () => {
    const enveloped = item({ role: 'user', text: '<envelope/>' })
    expect(isOperatorPrompt(enveloped, { ...opts, operatorTextOf: () => '' })).toBe(false)
    expect(isOperatorPrompt(enveloped, { ...opts, operatorTextOf: () => 'typed' })).toBe(true)
    // Not an envelope at all → undefined → the plain text rule applies.
    expect(isOperatorPrompt(enveloped, { ...opts, operatorTextOf: () => undefined })).toBe(true)
  })

  it('mounts the closest prompt above the window, with its ABSOLUTE index', () => {
    const rows = buildChatRows(
      blocksOf([
        item({ role: 'user', text: 'first question' }),
        item({ role: 'assistant', text: 'a' }),
        item({ role: 'assistant', text: 'b' }),
        item({ role: 'assistant', text: 'c' }),
      ]),
    )
    const out = renderableRows({
      rows,
      visibleRows: rows.slice(2),
      renderStart: 2,
      stickyEnabled: true,
      promptOptions: opts,
    })
    expect(out.map((r) => r.index)).toEqual([0, 2, 3])
    const off = renderableRows({
      rows,
      visibleRows: rows.slice(2),
      renderStart: 2,
      stickyEnabled: false,
      promptOptions: opts,
    })
    expect(off.map((r) => r.index)).toEqual([2, 3])
  })
})

describe('answerable questions and the last answer', () => {
  it('lights up only the last unanswered ask, and only on a live session', () => {
    const blocks = blocksOf([
      item({ role: 'tool', toolName: 'AskUserQuestion', toolInputJson: '{}', toolUseId: 'q1' }),
      item({ role: 'tool', toolResult: 'answered', toolUseId: 'q1' }),
      item({ role: 'tool', toolName: 'AskUserQuestion', toolInputJson: '{}', toolUseId: 'q2' }),
    ])
    expect(livePendingAskIndex(blocks, 'live')).toBe(1)
    expect(livePendingAskIndex(blocks, 'hibernated')).toBe(-1)
  })

  it('reports the end-of-turn answer index and the latest assistant prose apart', () => {
    const blocks = blocksOf([
      item({ role: 'assistant', text: 'final', answer: true }),
      item({ role: 'assistant', text: 'narration after' }),
    ])
    expect(lastAnswer(blocks)).toEqual({ blockIndex: 0, text: 'narration after' })
    expect(lastAnswer([])).toEqual({ blockIndex: -1, text: '' })
  })
})

describe('composer, queue, offer and activity', () => {
  it('opens on live, on resumable-parked, and on headless between turns', () => {
    expect(
      composerState({ session: session(), headless: false, turnRunning: false, compact: false })
        .enabled,
    ).toBe(true)
    expect(
      composerState({
        session: session({ status: 'exited', resumable: true }),
        headless: false,
        turnRunning: false,
        compact: false,
      }),
    ).toMatchObject({ enabled: true, sendable: false, canResume: true })
    expect(
      composerState({ session: session(), headless: true, turnRunning: true, compact: false }),
    ).toMatchObject({ enabled: false, placeholder: 'Working — stop to interject…' })
    expect(
      composerState({
        session: session({ status: 'exited', resumable: false }),
        headless: false,
        turnRunning: false,
        compact: false,
      }),
    ).toMatchObject({ enabled: false, placeholder: 'Session is not running.' })
  })

  it('consumes duplicate restored rows FIFO against optimistic bubbles', () => {
    const state = queuedState({
      session: session({ queuedMessageCount: 2 } as Partial<SessionMeta>),
      queuedMessages: [{ text: 'again' }, { text: 'again' }, { text: 'other' }],
      pending: [{ text: 'again', state: 'sending' }],
    })
    expect(state.restored.map((r) => r.text)).toEqual(['again', 'other'])
    expect(state.total).toBe(5)
    // A FAILED bubble claims nothing — the durable row must still render.
    expect(
      queuedState({
        session: undefined,
        queuedMessages: [{ text: 'again' }],
        pending: [{ text: 'again', state: 'failed' }],
      }).restored,
    ).toHaveLength(1)
  })

  it('hides the offer optimistically by createdAt, and always for headless', () => {
    const offer = { createdAt: 'T1', message: 'm', actions: [] }
    const withOffer = session({ offer } as unknown as Partial<SessionMeta>)
    expect(visibleOffer({ session: withOffer, headless: false, dismissedOfferAt: null })).toBe(
      offer,
    )
    expect(visibleOffer({ session: withOffer, headless: false, dismissedOfferAt: 'T1' })).toBeNull()
    expect(visibleOffer({ session: withOffer, headless: true, dismissedOfferAt: null })).toBeNull()
  })

  it('follows turn boundaries when headless, and agent state otherwise', () => {
    expect(
      chatActivityState({ session: session(), headless: true, turnRunning: true, justSent: false }),
    ).toEqual({ label: 'Working…', tone: 'working' })
    expect(
      chatActivityState({ session: session(), headless: true, turnRunning: false, justSent: true }),
    ).toEqual({ label: 'Sending…', tone: 'working' })
    expect(
      chatActivityState({
        session: session(),
        headless: true,
        turnRunning: false,
        justSent: false,
      }),
    ).toBeNull()
    expect(
      chatActivityState({
        session: session(),
        headless: false,
        turnRunning: false,
        justSent: true,
      }),
    ).toEqual({ label: 'Sending…', tone: 'working' })
  })
})
