import { omitGone } from '@podium/client-graph/lookup'
// @vitest-environment happy-dom

import type { ReferenceState } from '../../../../../tests/worklist/diagnostics/reference-state'

type Store = ReferenceState<import('@/app/trpc').Trpc> & { drafts: Record<string, string> }

import { bindStoreStatsOwner, readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import type { MobxPool } from '@podium/client-graph'
import {
  chatArtifactIssue,
  chatInteractions,
  chatItemAttachments,
  chatMentionIssues,
  chatReferenceSessions,
  chatUploadArtifact,
} from '@podium/client-graph/chat-context'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { SESSION_EXIT_ENTITIES } from '@podium/client-graph/session-exit-schema'
import { SESSION_EXIT_SOURCE_KEY } from '@podium/client-graph/session-exit-source'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { asSessionId } from '@podium/model/browser'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { createRef, StrictMode, useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createChatContextFixture } from '../../../test/chat/chat-context-test-fixture'
import '@/test-support/model-catalog-mock'

const f = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  fixture: undefined as Awaited<ReturnType<typeof createChatContextFixture>> | undefined,
  guard: false,
  listeners: new Set<() => void>(),
  seams: {} as Partial<Store>,
}))
const snapshot = () => {
  const state = { ...f.fixture!.state(), ...f.seams }
  return f.guard
    ? new Proxy(state, {
        get(target, key) {
          if (
            [
              'issueProjections',
              'issueUserStates',
              'sessions',
              'machines',
              'repos',
              'drafts',
              'pendingInteractions',
              'messageRecords',
              'outboxDeadLetters',
              'superagentThreads',
              'attachedSessionId',
              'transcriptReveal',
              'chatSendsFor',
            ].includes(String(key))
          ) {
            throw new Error(`Legacy chat input read: ${String(key)}`)
          }
          return Reflect.get(target, key)
        },
      })
    : state
}
const handle = {
  get access() {
    return snapshot()
  },
  subscribe: (_listener: () => void) => () => {},
  readLocal: (key: import('@podium/client-core/engine').LocalKey) =>
    f.fixture!.owner.readLocal(key),
  get drafts() {
    return f.fixture!.owner.drafts
  },
}
vi.mock('@/app/store', () => ({
  useRuntimeSelector: (read: (state: Store) => unknown) => read(snapshot() as unknown as Store),
  useSessionDraft: (id: string) => snapshot().drafts[id] ?? '',
  useSessionExitKind: (id: string) => {
    if (f.guard) throw new Error('Legacy session exit metadata read')
    return f.fixture!.owner.root.replica.exitKind?.('session', id)
  },
}))
vi.mock('@podium/client-core/react', async () => ({
  ...fixtureRuntimeHooks(() => handle),
  ...(await import('@podium/client-core/test-support/react')).fixtureUiHooks(
    () => f.fixture!.owner,
  ),
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () =>
    useSyncExternalStore(
      (fn: () => void) => {
        f.listeners.add(fn)
        return () => {
          f.listeners.delete(fn)
        }
      },
      () => f.pool,
    ),
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T) => {
    const pool = useSyncExternalStore(
      (fn: () => void) => {
        f.listeners.add(fn)
        return () => {
          f.listeners.delete(fn)
        }
      },
      () => f.pool,
    )
    const projection = useMemo(() => (pool ? createPoolProjection(pool, read) : null), [pool, read])
    return useSyncExternalStore(
      projection?.subscribe ?? (() => () => {}),
      projection?.getSnapshot ?? (() => empty),
    )
  },
}))
vi.mock('@/lib/at-mention/useFileMentions', () => ({ useFileMentions: () => [] }))
vi.mock('@/lib/ModelEffortPicker', () => ({
  AllConnectorsModelPicker: () => null,
  EffortPicker: () => null,
}))

import { observer } from 'mobx-react-lite'
import { ChatComposer } from './ChatComposer'
import { ItemAttachments } from './ChatUploadThumb'
import { OfferArtifactStrip } from './OfferArtifactStrip'
import { useChatConversationPorts } from './test-support/conversation-ports'
import { useModelSend } from './test-support/model-send'
import {
  useChatArtifactIssue,
  useChatContextWindow,
  useChatDraft,
  useChatInteractions,
  useChatIssueSeq,
  useChatItemMessage,
  useChatMachines,
  useChatMentions,
  useChatReferenceMachines,
  useChatRepositoryKey,
  useChatSession,
  useChatSessionExitKind,
  useChatThread,
  useChatThreads,
  useChatUploadSrc,
} from './use-chat-context'

const ItemAttachmentTags = observer(
  ({
    itemId,
    ...props
  }: Omit<Parameters<typeof ItemAttachments>[0], 'attachments'> & { itemId: string }) => {
    const message = useChatItemMessage(props.sessionId, itemId)
    return <ItemAttachments {...props} attachments={message?.attachments ?? []} />
  },
)

beforeEach(async () => {
  f.guard = true
  f.fixture = await createChatContextFixture()
  f.pool = f.fixture.pool
  f.seams = {
    httpOrigin: 'http://synthetic.invalid',
    openArtifact: vi.fn(),
    openFileInWorktree: vi.fn(),
  }
  bindStoreStatsOwner(handle, f.fixture.owner)
  bindStoreStatsOwner(f.fixture.owner.root.replica, f.fixture.owner)
  storeStats.enable()
  storeStats.reset()
})
afterEach(() => {
  cleanup()
  f.fixture?.pool.dispose()
  f.fixture?.owner.drafts.dispose()
  f.pool = null
  f.fixture = undefined
  f.listeners.clear()
  storeStats.enable(false)
  vi.restoreAllMocks()
})

it('declares and batches demand, with zero synchronous replica reads for absent context', async () => {
  const corpus = f.fixture!
  const bootstrapCollections = corpus.counts.collections
  expect(omitGone(corpus.pool.row('chatDraft', corpus.sessions[0]!.sessionId))).toBe(LOADING)
  expect(omitGone(corpus.pool.row('chatHeld', corpus.sessions[0]!.sessionId))).toBe(LOADING)
  expect(corpus.counts.collections).toBe(bootstrapCollections)
  const first = corpus.check()
  expect(first.pending).toBeGreaterThan(0)
  expect(corpus.counts.collections).toBe(bootstrapCollections)
  const loaded = await corpus.load()
  expect(loaded).toMatchObject({ differences: 0, pending: 0 })
  expect(corpus.source.counts).toMatchObject({ outboxReads: 1, orderLists: 2 })
})

it('shares addressed session exits, batches absent evidence and updates removal, eviction and rescope', async () => {
  const corpus = f.fixture!,
    id = 'unavailable-session'
  const shared = await corpus.pool.sources.ensure(
    SESSION_EXIT_SOURCE_KEY,
    SESSION_EXIT_ENTITIES,
    () => {
      throw new Error('Second session exit owner')
    },
  )
  expect(shared).toBe(corpus.exitSource)
  expect(omitGone(corpus.pool.row('sessionExit', id))).toBe(LOADING)
  expect(omitGone(corpus.pool.row('sessionExit', id))).toBe(LOADING)
  expect(corpus.counts.exits).toBe(0)
  await Promise.resolve()
  expect(corpus.counts.exits).toBe(1)
  expect(omitGone(corpus.pool.row('sessionExit', id))).toEqual({ kind: undefined })
  corpus.updateExit(id, 'removed')
  await Promise.resolve()
  expect(omitGone(corpus.pool.row('sessionExit', id))).toEqual({ kind: 'removed' })
  corpus.updateExit(id, 'evicted')
  await Promise.resolve()
  expect(omitGone(corpus.pool.row('sessionExit', id))).toEqual({ kind: 'evicted' })
  corpus.updateExit(id, undefined, true)
  await Promise.resolve()
  expect(omitGone(corpus.pool.row('sessionExit', id))).toEqual({ kind: undefined })
  const before = corpus.counts.exits
  corpus.exitSource.dispose()
  corpus.updateExit(id, 'removed')
  await Promise.resolve()
  expect(corpus.counts.exits).toBe(before)
  expect(omitGone(corpus.pool.row('sessionExit', id))).toBe(LOADING)
})

it('preserves mention ties, pending question order, saved drafts, held sends and reference contexts', async () => {
  const corpus = f.fixture!
  expect(await corpus.load()).toMatchObject({ differences: 0, pending: 0 })
  expect(chatInteractions(corpus.pool, corpus.sessions[0]!.sessionId).question?.id).toBe(
    'notice-ask-6',
  )
  expect(chatMentionIssues(corpus.pool).issues.map((row) => row.id)).toEqual(
    corpus.issues.filter((row) => !row.deletedAt).map((row) => row.id),
  )
  expect(chatReferenceSessions(corpus.pool).sessions.map((row) => row.sessionId)).toEqual(
    corpus.sessions.map((row) => row.sessionId),
  )
  expect(corpus.pool.tables.session.has(corpus.sessions[1]!.sessionId)).toBe(false)
  expect(
    omitGone(corpus.pool.row('session', corpus.sessions[1]!.sessionId, 'summary')),
  ).not.toHaveProperty('privateBody')
  expect(omitGone(corpus.pool.row('chatHeld', corpus.sessions[0]!.sessionId))).toMatchObject({
    sends: [{ mutationId: 'held-failed' }, { mutationId: 'held-live' }],
  })
})

it('collapses parked resume twins while keeping active identities and headless rows', async () => {
  const corpus = await createChatContextFixture(true)
  try {
    expect(await corpus.load()).toMatchObject({ differences: 0, pending: 0 })
    expect(chatReferenceSessions(corpus.pool).sessions.map((row) => row.sessionId)).toEqual(
      corpus.sessions.map((row) => row.sessionId),
    )
    expect(corpus.sessions.map((row) => row.sessionId)).toEqual([
      'synthetic-session-0',
      'parked-twin',
      'active-twin',
      'headless-twin',
    ])
  } finally {
    corpus.pool.dispose()
  }
})

it('drops deleted issue artifacts while preserving addressed issue-sequence lookup', async () => {
  const corpus = f.fixture!
  await corpus.load()
  corpus.deleteIssue()
  expect(chatArtifactIssue(corpus.pool, corpus.sessions[0]!)).toBeUndefined()
  expect(corpus.check()).toMatchObject({ differences: 0, pending: 0 })
})

it('resolves a chat attachment id to its stored copy on the session issue (POD-2148)', async () => {
  const corpus = f.fixture!
  await corpus.load()
  const session = corpus.sessions[0]!
  const issue = corpus.issues[0]!
  const upload = {
    path: 'chat-uploads/att-1/shot.png',
    title: 'shot.png',
    artifactId: 'upload-copy',
    entry: 'shot.png',
    chatUploadId: 'att-1',
    addedAt: '2026-10-01T12:05:00Z',
  }
  const { result } = renderHook(() =>
    useChatUploadSrc(session.sessionId, 'att-1', 'http://synthetic.invalid'),
  )
  expect(result.current).toBeNull()

  act(() => {
    corpus.issues[0] = {
      ...issue,
      panel: { ...issue.panel!, artifacts: [...issue.panel!.artifacts, upload] },
    } as never
    corpus.pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: issue.id, value: corpus.issues[0] as never }],
    })
  })
  expect(chatUploadArtifact(corpus.pool, session.sessionId, 'att-1')).toEqual({
    issueId: issue.id,
    artifact: expect.objectContaining({ artifactId: 'upload-copy' }),
  })
  expect(result.current).toBe(
    `http://synthetic.invalid/files/artifact/${issue.id}/upload-copy/shot.png`,
  )
  // Only chat uploads resolve, by their id: a published artifact's path and an
  // unknown id keep the caller's fallback.
  expect(chatUploadArtifact(corpus.pool, session.sessionId, 'concept.html')).toBeUndefined()
  expect(chatUploadArtifact(corpus.pool, session.sessionId, 'att-2')).toBeUndefined()
})

it('drops gallery lookup with the private session while its task artifact stays shared', async () => {
  const corpus = f.fixture!
  await corpus.load()
  const aliceSession = corpus.sessions[0]!
  const issue = corpus.issues[0]!
  const bobSession = { ...aliceSession, sessionId: asSessionId('bob-shared-run') }
  const attachment = { id: 'shared-upload', filename: 'shared.png', kind: 'image' as const }
  const sharedIssue = {
    ...issue,
    panel: {
      ...issue.panel!,
      artifacts: [
        ...issue.panel!.artifacts,
        {
          path: 'chat-uploads/shared-upload/shared.png',
          title: 'shared.png',
          artifactId: 'shared-copy',
          entry: 'shared.png',
          chatUploadId: attachment.id,
          addedAt: '2026-11-05T12:00:00Z',
        },
      ],
    },
  }
  corpus.pool.apply({
    type: 'update',
    rows: [{ kind: 'issue', id: issue.id, value: sharedIssue as never }],
  })
  const props = {
    attachments: [attachment],
    tags: [],
    httpOrigin: 'http://synthetic.invalid',
    onOpenImage: vi.fn(),
  }
  const gallery = render(<ItemAttachments {...props} sessionId={aliceSession.sessionId} />)
  const hook = renderHook(() =>
    useChatUploadSrc(aliceSession.sessionId, attachment.id, props.httpOrigin),
  )
  const expected = `http://synthetic.invalid/files/artifact/${issue.id}/shared-copy/shared.png`
  expect(hook.result.current).toBe(expected)
  expect(gallery.container.querySelector('img')?.getAttribute('src')).toBe(expected)

  // Model the server's member rescope: the shared task remains, Alice's full
  // session leaves the projection and Bob's own session on that task arrives.
  act(() =>
    corpus.pool.apply({
      type: 'update',
      rows: [
        { kind: 'session', id: aliceSession.sessionId, value: undefined },
        { kind: 'session', id: bobSession.sessionId, value: bobSession as never },
      ],
    }),
  )
  expect(hook.result.current).toBeNull()
  expect(gallery.container.querySelector('img')).toBeNull()
  expect(chatUploadArtifact(corpus.pool, aliceSession.sessionId, attachment.id)).toBeUndefined()
  expect(chatUploadArtifact(corpus.pool, bobSession.sessionId, attachment.id)).toMatchObject({
    issueId: issue.id,
    artifact: { artifactId: 'shared-copy' },
  })

  gallery.rerender(<ItemAttachments {...props} sessionId={bobSession.sessionId} />)
  expect(gallery.container.querySelector('img')?.getAttribute('src')).toBe(expected)
  fireEvent.click(gallery.getByRole('button', { name: 'Open shared.png, image 1 of 1' }))
  expect(props.onOpenImage).toHaveBeenCalledWith(
    expected,
    [expect.objectContaining({ src: expected, label: 'shared.png' })],
    0,
  )
})

it('shows a path-less image turn from its matched message record’s stored copy (POD-2148)', async () => {
  // Claude Code's record for an image prompt sent while it was busy: the image
  // block and a bare `[Image #1]` placeholder, with no `[Image: source: …]`
  // marker, so the entry has an image tag and nothing to find the copy by.
  const { transcriptRecordMapperFor } = await import('@podium/harness/metadata')
  const toItems = transcriptRecordMapperFor('claude-code')!
  const [item] = toItems({
    type: 'user',
    uuid: 'u-queued',
    timestamp: '2026-10-01T12:00:10.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: '[Image #1]Strict second: cat picture' },
      ],
    },
  })
  expect(item).toMatchObject({ id: 'u-queued', tags: [{ kind: 'image' }] })
  expect(item).not.toHaveProperty('toolPaths')

  const corpus = f.fixture!
  await corpus.load()
  const session = corpus.sessions[0]!
  const issue = corpus.issues[0]!
  const view = render(
    <ItemAttachmentTags
      sessionId={session.sessionId}
      itemId={item!.id}
      tags={item!.tags!}
      httpOrigin="http://synthetic.invalid"
      onOpenImage={() => {}}
    />,
  )
  // No matched record yet: the chip it always was.
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.textContent).toBe('image')

  act(() => {
    corpus.updateMessages(
      corpus.data.messages.map((row) =>
        row.id === 'notice-message-4'
          ? {
              ...row,
              transcriptItem: { id: 'u-queued', cursor: 'c-queued' },
              attachments: [
                {
                  id: 'att-9',
                  filename: 'cat.png',
                  mediaType: 'image/png',
                  kind: 'image' as const,
                },
              ],
            }
          : row,
      ),
      ['notice-message-4'],
    )
    corpus.issues[0] = {
      ...issue,
      panel: {
        ...issue.panel!,
        artifacts: [
          ...issue.panel!.artifacts,
          {
            path: 'chat-uploads/att-9/cat.png',
            title: 'cat.png',
            artifactId: 'cat-copy',
            entry: 'cat.png',
            chatUploadId: 'att-9',
            addedAt: '2026-10-01T12:00:11Z',
          },
        ],
      },
    } as never
    corpus.pool.apply({
      type: 'update',
      rows: [{ kind: 'issue', id: issue.id, value: corpus.issues[0] as never }],
    })
  })
  expect(chatItemAttachments(corpus.pool, session.sessionId, 'u-queued')).toEqual([
    expect.objectContaining({ id: 'att-9' }),
  ])
  await waitFor(() =>
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(
      `http://synthetic.invalid/files/artifact/${issue.id}/cat-copy/cat.png`,
    ),
  )
  expect(view.container.querySelectorAll('.chat-image-gallery')).toHaveLength(1)
  expect(view.getByRole('button', { name: 'Open cat.png, image 1 of 1' })).toBeTruthy()
})

it('updates addressed records, question membership and outbox without re-reading collections', async () => {
  const corpus = f.fixture!
  await corpus.load()
  const before = corpus.source.counts.orderLists
  corpus.updateMessages(
    corpus.data.messages.map((row) =>
      row.id === 'notice-message-0' ? { ...row, body: 'Updated authored text' } : row,
    ),
    ['notice-message-0'],
  )
  corpus.updateInteractions(
    [...corpus.data.interactions]
      .reverse()
      .map((row) => (row.id === 'notice-ask-6' ? { ...row, status: 'answered' as const } : row)),
    ['notice-ask-6'],
  )
  corpus.updateDraft('Changed draft')
  corpus.discardHeld()
  await Promise.resolve()
  expect(corpus.check()).toMatchObject({ differences: 0, pending: 0 })
  expect(corpus.source.counts.orderLists).toBe(before)
  expect(chatInteractions(corpus.pool, corpus.sessions[0]!.sessionId).question?.id).toBe(
    'notice-ask-5',
  )
  corpus.updateMessages(corpus.data.messages.slice(1), ['notice-message-0'])
  expect(corpus.check().differences).toBe(0)
  expect(
    omitGone(corpus.pool.row('noticeSession', corpus.sessions[0]!.sessionId)),
  ).not.toMatchObject({
    messages: expect.arrayContaining(['notice-message-0']),
  })
})

it('reports missing cold summaries pending and batches their hydration', async () => {
  const corpus = f.fixture!
  await corpus.load()
  const summary = corpus.pool.residency!.summary.bind(corpus.pool.residency!)
  const missing = vi
    .spyOn(corpus.pool.residency!, 'summary')
    .mockImplementation((entity, id) =>
      entity === 'session' && id === corpus.sessions[1]!.sessionId
        ? undefined
        : summary(entity, id),
    )
  expect(chatReferenceSessions(corpus.pool).pending).toBe(1)
  expect(chatReferenceSessions(corpus.pool).pending).toBe(1)
  missing.mockRestore()
  expect(corpus.pool.hydrate()).toBe(1)
  expect(corpus.check()).toMatchObject({ differences: 0, pending: 0 })
})

it('clears rescope inputs and releases all borrowed subscriptions on disposal', async () => {
  const corpus = f.fixture!
  await corpus.load()
  corpus.replaceEmpty()
  corpus.check() // The next imperative read starts the replacement's loading pass.
  await Promise.resolve()
  expect(corpus.check()).toMatchObject({ differences: 0, pending: 0 })
  expect(omitGone(corpus.pool.row('noticeSession', corpus.sessions[0]!.sessionId))).toBeUndefined()
  corpus.pool.dispose()
  expect(corpus.addressed.size).toBe(0)
  expect(corpus.listeners.size).toBe(0)
  expect(corpus.outboxListeners.size).toBe(0)
})

it('detects a planted wrong value for every new comparison section', async () => {
  const corpus = f.fixture!
  await corpus.load()
  const state = corpus.state()
  for (const wrong of [
    { ...state, drafts: {} },
    { ...state, attachedSessionId: null },
    { ...state, pendingInteractions: [] },
    { ...state, messageRecords: [] },
    { ...state, chatSendsFor: () => [] },
    { ...state, superagentThreads: [] },
    { ...state, repos: [] },
    { ...state, machines: [] },
    { ...state, replica: { ...state.replica, exitKind: () => 'removed' } },
    {
      ...state,
      sessions: state.sessions.map((row) => ({
        ...row,
        displayRef: 'SYN-DRAFT-99',
        archived: true,
      })),
    },
  ])
    expect(corpus.check(wrong as Store).differences).toBeGreaterThan(0)
  for (const wrongIssues of [
    corpus.issues.map((row) => ({ ...row, title: 'Wrong title', panel: undefined })),
    corpus.issues.map((row) => ({ ...row, seq: row.seq + 999, displayRef: `WRONG-${row.seq}` })),
  ])
    expect(
      corpus.check(
        state,
        wrongIssues.filter((row) => !row.deletedAt),
      ).differences,
    ).toBeGreaterThan(0)
})

function Inputs() {
  const id = f.fixture!.sessions[0]!.sessionId
  const session = useChatSession(id),
    machines = useChatMachines(),
    mentions = useChatMentions('task')
  const exit = useChatSessionExitKind(id)
  const draft = useChatDraft(id),
    asks = useChatInteractions(id),
    window = useChatContextWindow(),
    seq = useChatIssueSeq()
  const threads = useChatThreads(),
    refs = useChatReferenceMachines(),
    repos = useChatRepositoryKey()
  const artifact = useChatArtifactIssue(f.fixture!.sessions[0]!),
    ports = useChatConversationPorts(id)
  return (
    <div>
      {JSON.stringify({
        title: session?.title,
        exit,
        machines: machines.length,
        mentions,
        draft,
        question: asks.question?.id,
        attached: window.attachedSessionId,
        seq: seq('chat-issue'),
        threads,
        refs: refs.length,
        repos,
        artifact: artifact?.id,
        ready: ports.ready,
        held: ports.outbox.held().map((row) => row.mutationId),
        records: ports.records.getSnapshot().map((row) => row.id),
      })}
    </div>
  )
}

it('preserves saved chat inputs with zero legacy derivations', async () => {
  await f.fixture!.load()
  storeStats.reset()
  f.guard = true
  const actual = render(<Inputs />)
  expect(actual.container.textContent).toMatchSnapshot('last green chat inputs')
  expect(
    Object.entries(readRuntimeStoreStats(f.fixture!.owner)?.slices ?? {}).filter(
      ([key]) => key.startsWith('chatContext.') || key.startsWith('sessionPane.'),
    ),
  ).toEqual([])
})

it('keeps hooks stable through null-pool attachment and restores saved controller inputs', async () => {
  f.guard = true
  const graph = f.pool
  f.pool = null
  const restored: ReturnType<typeof useModelSend>[] = []
  const blocks: [] = []
  function Send() {
    const id = f.fixture!.sessions[0]!.sessionId
    const value = useModelSend({
      sessionId: id,
      trpc: { messages: { records: { query: async () => ({ records: [] }) } } } as never,
      sendChat: vi.fn(async () => ({ state: 'sent' as const })),
      chatSendsFor: () => {
        throw new Error('Legacy held sends')
      },
      discardChat: vi.fn(async () => {}),
      dismissOffer: vi.fn(async () => {}),
      setPanelMode: vi.fn(),
      setSessionDraft: (id, text) => f.fixture!.state().setSessionDraft(id, text),
      getUserFocus: () => ({}) as never,
      attachedSessionId: null,
      clearAttachedSession: vi.fn(),
      getIssueSeq: () => null,
      headless: false,
      superThread: undefined,
      compact: false,
      composer: { sendable: true, canResume: false },
      ownThreadIds: undefined,
      blocks,
      session: undefined,
      headlessTurn: { sendTurn: vi.fn(), interrupt: vi.fn() } as never,
      canInterrupt: false,
      latestOperatorPrompt: null,
      pinToBottom: vi.fn(),
      initialPendingText: undefined,
    })
    restored.push(value)
    return (
      <div>
        {value.ready ? value.draft : 'Loading'} {value.pending.map((row) => row.text).join('|')}
      </div>
    )
  }
  const errors = vi.spyOn(console, 'error')
  const mounted = render(
    <StrictMode>
      <Send />
    </StrictMode>,
  )
  expect(mounted.container.textContent).toContain('Loading')
  await act(async () => {
    f.pool = graph
    for (const fn of f.listeners) fn()
    await f.fixture!.load()
  })
  await waitFor(() => expect(mounted.container.textContent).toContain('Saved draft'))
  expect(mounted.container.textContent).toContain('Saved synthetic send')
  expect(
    errors.mock.calls.flat().some((value) => /hook|cache|maximum update/i.test(String(value))),
  ).toBe(false)
  expect(restored.at(-1)?.ready).toBe(true)
  act(() => restored.at(-1)!.setDraft('Active controller draft'))
  const model = graph!.model.bind(graph!)
  const missing = vi
    .spyOn(graph!, 'model')
    .mockImplementation(((entity: string, id: string) =>
      entity === 'messageRecord' && id === 'new-record'
        ? LOADING
        : model(entity as never, id)) as MobxPool['model'])
  await act(async () => {
    const messages = [
      ...f.fixture!.data.messages,
      { ...f.fixture!.data.messages[0]!, id: 'new-record' },
    ]
    f.fixture!.updateMessages(messages, ['new-record'])
    await Promise.resolve()
  })
  expect(restored.at(-1)?.ready).toBe(true)
  expect(restored.at(-1)?.draft).toBe('Active controller draft')
  expect(mounted.container.textContent).toContain('Saved synthetic send')
  missing.mockRestore()
})

const attachments = {
  attachments: [],
  dragOver: false,
  fileInputRef: createRef<HTMLInputElement>(),
  openFilePicker() {},
  processFiles: async () => {},
  remove() {},
  clear() {},
  clearReady() {},
  uploading: false,
  ready: () => ({ paths: [], legacyPaths: [], refs: [], tags: [], draftArtifacts: [] }),
  dropHandlers: {},
  onPaste() {},
  onFileInputChange() {},
}
function Composer() {
  const id = f.fixture!.sessions[0]!.sessionId,
    draft = useChatDraft(id)
  return (
    <ChatComposer
      taRef={createRef()}
      draft={draft}
      onDraftChange={vi.fn()}
      deliverable
      placeholder="Synthetic prompt"
      compact={false}
      isMobile={false}
      onSend={vi.fn()}
      voice={{ supported: false, listening: false, toggle() {} } as never}
      attachments={attachments as never}
      turnRunning={false}
      canInterrupt={false}
      onInterrupt={vi.fn()}
      interruptError={null}
      offer={null}
      onOfferAction={async () => {}}
      onOfferDismiss={async () => {}}
      session={f.fixture!.sessions[0]}
      turnError={null}
      transcriptFreshness="saved"
      offlineAsOf={null}
      autoFocusKey={id}
      transcriptSettled
    />
  )
}
it('renders the real composer and artifact strip identically and keeps artifact dispatch on its owner', async () => {
  await f.fixture!.load()
  const offer = {
    message: 'Synthetic concept ready',
    at: '2026-10-01T12:00:01Z',
    artifacts: ['concept.html'],
    actions: [],
  } as never
  const Surface = () => (
    <>
      <Composer />
      <OfferArtifactStrip session={f.fixture!.sessions[0]!} offer={offer} />
    </>
  )
  const visible = (container: HTMLElement) => ({
    text: container.textContent,
    draft: container.querySelector('textarea')?.value,
    buttons: [...container.querySelectorAll('button')].map((row) => ({
      label: row.title,
      disabled: row.disabled,
      text: row.textContent,
    })),
  })
  storeStats.reset()
  f.guard = true
  const actual = render(<Surface />)
  expect(visible(actual.container)).toMatchSnapshot('last green composer and artifacts')
  fireEvent.click(actual.getByTestId('offer-artifact-thumb'))
  expect(f.seams.openArtifact).toHaveBeenCalledWith(
    expect.objectContaining({
      issueId: 'chat-issue',
      artifactId: 'opaque-artifact',
      path: 'concept.html',
    }),
  )
  expect(
    Object.keys(readRuntimeStoreStats(f.fixture!.owner)?.slices ?? {}).filter((key) =>
      key.startsWith('chatContext.'),
    ),
  ).toEqual([])
})

it('types 60 characters with zero renders outside the composer and zero outbox or order scans', async () => {
  const corpus = f.fixture!
  await corpus.load()
  corpus.discardHeld()
  const id = corpus.sessions[0]!.sessionId
  const outside = { shell: 0, transcript: 0 }
  let send!: ReturnType<typeof useModelSend>
  const blocks: [] = []
  const options = {
    sessionId: id,
    observeDraft: false,
    trpc: { messages: { records: { query: async () => ({ records: [] }) } } } as never,
    sendChat: vi.fn(async () => ({ state: 'sent' as const })),
    discardChat: vi.fn(async () => {}),
    dismissOffer: vi.fn(async () => {}),
    setPanelMode: vi.fn(),
    setSessionDraft: (id: import('@podium/model').SessionId, text: string) =>
      corpus.state().setSessionDraft(id, text),
    getUserFocus: () => ({}) as never,
    attachedSessionId: null,
    clearAttachedSession: vi.fn(),
    getIssueSeq: () => null,
    headless: false,
    superThread: undefined,
    compact: false,
    composer: { sendable: true, canResume: false },
    ownThreadIds: undefined,
    blocks,
    session: undefined,
    headlessTurn: { sendTurn: vi.fn(), interrupt: vi.fn() } as never,
    canInterrupt: false,
    latestOperatorPrompt: null,
    pinToBottom: vi.fn(),
    initialPendingText: undefined,
  }
  function Transcript() {
    outside.transcript++
    return <div>Transcript</div>
  }
  const composerRef = createRef<HTMLTextAreaElement>()
  const Composer = observer(function Composer() {
    const draft = send.conversation.draft
    return (
      <ChatComposer
        taRef={composerRef}
        draft={draft}
        onDraftChange={(text) => send.setDraft(text)}
        deliverable
        placeholder="Message agent"
        compact={false}
        isMobile={false}
        onSend={() => {}}
        voice={{ supported: false, listening: false, toggle: () => {} } as never}
        attachments={attachments as never}
        turnRunning={false}
        canInterrupt={false}
        onInterrupt={() => {}}
        offer={null}
        onOfferAction={async () => {}}
        onOfferDismiss={async () => {}}
        session={undefined}
        turnError={null}
        transcriptFreshness={null}
        offlineAsOf={null}
        autoFocusKey={id}
        transcriptSettled
      />
    )
  })

  function Shell() {
    outside.shell++
    send = useModelSend(options)
    return (
      <>
        <Transcript />
        <Composer />
      </>
    )
  }
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const valueWrites = vi.spyOn(HTMLTextAreaElement.prototype, 'value', 'set')
  const mounted = render(<Shell />)
  await act(async () => {
    await Promise.resolve()
  })
  outside.shell = outside.transcript = 0
  valueWrites.mockClear()
  const work = { ...corpus.source.counts }
  const textarea = mounted.container.querySelector('textarea')!
  const initialDefault = textarea.defaultValue
  for (let i = 1; i <= 60; i++) {
    await act(async () => {
      nativeSet.call(textarea, 'x'.repeat(i))
      fireEvent.input(textarea)
      await Promise.resolve()
    })
    expect(textarea.value).toBe('x'.repeat(i))
    expect(outside).toEqual({ shell: 0, transcript: 0 })
    expect(valueWrites).not.toHaveBeenCalled()
    expect(textarea.defaultValue).toBe(initialDefault)
  }
  expect(corpus.state().drafts[id]).toBe('x'.repeat(60))
  textarea.focus()
  textarea.setSelectionRange(5, 8, 'backward')
  const edited = `${textarea.value.slice(0, 5)}Z${textarea.value.slice(8)}`
  await act(async () => {
    nativeSet.call(textarea, edited)
    textarea.setSelectionRange(6, 6)
    fireEvent.input(textarea)
    await Promise.resolve()
  })
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([6, 6])
  expect(corpus.state().drafts[id]).toBe(edited)
  expect(textarea.defaultValue).toBe(initialDefault)
  expect(valueWrites).not.toHaveBeenCalled()
  expect(outside).toEqual({ shell: 0, transcript: 0 })
  expect(corpus.source.counts.outboxReads).toBe(work.outboxReads)
  expect(corpus.source.counts.orderLists).toBe(work.orderLists)
  expect(corpus.source.counts.orderIds).toBe(work.orderIds)
})

it('requests no thread for ordinary chat and only the selected backend row for a superthread', async () => {
  const rows = vi.spyOn(f.pool!, 'row')
  const hook = renderHook(({ id }: { id: string | undefined }) => useChatThread(id), {
    initialProps: { id: undefined as string | undefined },
  })
  expect(hook.result.current).toBeUndefined()
  expect(
    rows.mock.calls.some(
      ([kind]) => String(kind) === 'superThread' || String(kind) === 'superThreadCatalog',
    ),
  ).toBe(false)
  await act(async () => hook.rerender({ id: 'own-thread' }))
  await waitFor(() => expect(hook.result.current).toMatchObject({ id: 'own-thread' }))
  expect(rows.mock.calls.some(([kind]) => String(kind) === 'superThreadCatalog')).toBe(false)
  expect(
    rows.mock.calls
      .filter(([kind]) => String(kind) === 'superThread')
      .every(([, id]) => id === 'own-thread'),
  ).toBe(true)
})

it('keeps mention catalog demand off until the picker is visible', async () => {
  const rows = vi.spyOn(f.pool!, 'row')
  const hook = renderHook(({ query }: { query: string | null }) => useChatMentions(query), {
    initialProps: { query: null as string | null },
  })
  expect(hook.result.current).toEqual([])
  expect(rows).not.toHaveBeenCalled()
  await act(async () => hook.rerender({ query: 'task' }))
  await waitFor(() => expect(hook.result.current.length).toBeGreaterThan(0))
  expect(rows.mock.calls.some(([kind]) => String(kind) === 'chatIssueOrder')).toBe(false)
})
