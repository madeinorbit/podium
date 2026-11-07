import type { MobxPool } from '@podium/client-graph'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createChatContextFixture } from '../../../test/chat/chat-context-test-fixture'
import '@/test-support/model-catalog-mock'

const f = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  fixture: undefined as Awaited<ReturnType<typeof createChatContextFixture>> | undefined,
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => f.pool,
  useWorklistPoolProjection: <T,>(read: (pool: MobxPool) => T, empty: T) => {
    const projection = useMemo(() => (f.pool ? createPoolProjection(f.pool, read) : null), [read])
    return useSyncExternalStore(
      projection?.subscribe ?? (() => () => {}),
      projection?.getSnapshot ?? (() => empty),
    )
  },
}))

import { ChatBlockView } from './ChatBlockView'
import { ItemAttachments } from './ChatUploadThumb'

beforeEach(async () => {
  f.fixture = await createChatContextFixture()
  f.pool = f.fixture.pool
})
afterEach(() => {
  cleanup()
  f.pool?.dispose()
  f.fixture?.owner.drafts.dispose()
  f.pool = null
  f.fixture = undefined
})

it.each([
  ['mixed', 'Please review this screenshot', false],
  ['image-only path', '', false],
  ['image-only placeholder', '', true],
] as const)('renders Codex %s from its confirmed message, including a history remount', async (_name, body, placeholder) => {
  const { transcriptRecordMapperFor } = await import('@podium/harness/metadata')
  const corpus = f.fixture!
  await corpus.load()
  const session = corpus.sessions[0]!
  const issue = corpus.issues[0]!
  const uploadId = '758cc885-68cc-44ec-83c3-531f071689a4'
  const path = `/home/podium/.podium/uploads/${session.sessionId}/${uploadId}.png`
  const raw = placeholder ? '[Image #1]' : [path, body].filter(Boolean).join('\n')
  const [item] = transcriptRecordMapperFor('codex')!({
    type: 'event_msg',
    timestamp: '2026-10-29T20:14:53.927Z',
    payload: {
      type: 'item_completed',
      turn_id: 'codex-turn',
      item: {
        type: 'UserMessage',
        id: 'codex-message',
        content: [{ type: 'text', text: raw }],
      },
    },
  })
  expect(item).toMatchObject({ text: raw, id: 'codex-message', promptEntry: true })
  expect(item!.tags).toBeUndefined()
  expect(item!.toolPaths).toBeUndefined()
  const openImage = vi.fn()
  const quoted = vi.fn()
  const block = (
    <ChatBlockView
      block={{ item: item! }}
      index={0}
      highlighted={false}
      dimmed={false}
      sessionId={session.sessionId}
      cwd="/repo"
      openFile={() => {}}
      httpOrigin="http://synthetic.invalid"
      onOpenImage={openImage}
      askLivePending={false}
      onAnswerAsk={async () => {}}
      onQuote={quoted}
    />
  )
  let view = render(block)
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.querySelector('.chat-md')?.textContent).toContain(raw.split('\n').at(-1))
  act(() => {
    corpus.updateMessages(
      corpus.data.messages.map((row) =>
        row.id === 'notice-message-4'
          ? {
              ...row,
              body,
              status: 'confirmed' as const,
              transcriptItem: { id: item!.id, cursor: 'history-cursor' },
              attachments: [
                {
                  id: uploadId,
                  filename: 'image.png',
                  mediaType: 'image/png',
                  kind: 'image' as const,
                },
              ],
            }
          : row,
      ),
      ['notice-message-4'],
    )
    corpus.pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: issue.id,
          value: {
            ...issue,
            panel: {
              ...issue.panel!,
              artifacts: [
                ...issue.panel!.artifacts,
                {
                  path: `chat-uploads/${uploadId}/image.png`,
                  artifactId: 'saved-codex-image',
                  entry: 'image.png',
                  chatUploadId: uploadId,
                  addedAt: '2026-10-29T20:14:53.927Z',
                },
              ],
            },
          } as never,
        },
      ],
    })
  })
  const url = `http://synthetic.invalid/files/artifact/${issue.id}/saved-codex-image/image.png`
  await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe(url))
  expect(view.container.querySelector('.chat-md')?.textContent?.trimEnd()).toBe(body)
  expect(view.container.querySelectorAll('img')).toHaveLength(1)
  fireEvent.click(view.container.querySelector('img')!)
  expect(openImage).toHaveBeenCalledWith(
    url,
    [expect.objectContaining({ src: url, label: 'image.png' })],
    0,
  )
  if (body) {
    fireEvent.click(view.getByRole('button', { name: 'Add to chat' }))
    expect(quoted).toHaveBeenCalledWith(expect.objectContaining({ text: body }))
  }
  view.unmount()
  view = render(block)
  await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe(url))
  expect(view.container.querySelector('.chat-md')?.textContent?.trimEnd()).toBe(body)
  expect(item!.text).toBe(raw)
})

it.each([
  'Please review this saved image',
  '',
])('loads historical attachments outside the live feed without delaying text: %s', async (body) => {
  const { createWebConversation } = await import('./use-conversation')
  const { chatItemMessage } = await import('@podium/client-graph/chat-context')
  const corpus = f.fixture!
  await corpus.load()
  const sessionId = corpus.sessions[0]!.sessionId
  const uploadId = '758cc885-68cc-44ec-83c3-531f071689a4'
  const path = `/home/podium/.podium/uploads/${sessionId}/${uploadId}.png`
  const item = {
    id: 'old-attachment-turn',
    role: 'user' as const,
    text: body ? `${path}\n${body}` : '',
  }
  let resolveRecords!: (answer: { records: unknown[] }) => void
  const records = vi.fn(
    () =>
      new Promise<{ records: unknown[] }>((resolve) => {
        resolveRecords = resolve
      }),
  )
  const runtime = {
    ...corpus.owner,
    access: {
      hub: { subscribeTranscript: () => () => {} },
      trpc: {
        sessions: { transcriptRead: { query: async () => ({ items: [item], hasMore: false }) } },
        messages: { records: { query: records } },
      },
    },
  }
  const conversation = createWebConversation(runtime as never, corpus.pool, sessionId, {})
  try {
    await conversation.transcript.refresh()
    expect(conversation.transcript.byId.get(item.id)?.text).toBe(item.text)
    expect(records).toHaveBeenCalledExactlyOnceWith({ sessionId, transcriptItemIds: [item.id] })
    expect(chatItemMessage(corpus.pool, sessionId, item.id)).toBeUndefined()
    await act(async () => {
      resolveRecords({
        records: [
          {
            id: 'saved-history-message',
            sessionId,
            senderUserId: 'owner',
            body,
            createdAt: '2026-10-01T00:00:00Z',
            status: 'confirmed',
            transcriptItem: { id: item.id },
            attachments: [
              { id: uploadId, filename: 'image.png', mediaType: 'image/png', kind: 'image' },
            ],
          },
        ],
      })
    })
    expect(chatItemMessage(corpus.pool, sessionId, item.id)?.body).toBe(body)
    expect(corpus.data.messages.some((record) => record.id === 'saved-history-message')).toBe(false)
    const view = render(
      <ChatBlockView
        block={{ item }}
        index={0}
        highlighted={false}
        dimmed={false}
        sessionId={sessionId}
        cwd="/repo"
        openFile={() => {}}
        httpOrigin="http://synthetic.invalid"
        onOpenImage={() => {}}
        askLivePending={false}
        onAnswerAsk={async () => {}}
      />,
    )
    // No saved copy in this fixture: keep the named image chip, not the path.
    expect(view.container.querySelector('.chat-md')?.textContent?.trimEnd()).toBe(body)
    expect(view.container.textContent).toContain('image.png')
    await conversation.transcript.refresh()
    expect(records).toHaveBeenCalledTimes(1)
  } finally {
    conversation.dispose()
  }
})

it('groups mixed image sources once, prefers durable copies, and retains file dispatch', async () => {
  const corpus = f.fixture
  if (!corpus) throw new Error('Missing attachment fixture')
  await corpus.load()
  const session = corpus.sessions[0],
    issue = corpus.issues[0]
  if (!session || !issue) throw new Error('Missing session or issue')
  const id = '758cc885-68cc-44ec-83c3-531f071689a4'
  const staged = `/home/podium/.podium/uploads/${session.sessionId}/${id}.png`
  const openFile = vi.fn(),
    openImage = vi.fn()
  const view = render(
    <ItemAttachments
      sessionId={session.sessionId}
      cwd="/repo"
      httpOrigin="http://synthetic.invalid"
      paths={[staged, '/repo/second.png', '/repo/spec.md']}
      attachments={[{ id, filename: 'original-name.png', kind: 'image' }]}
      tags={[]}
      openFile={openFile}
      onOpenImage={openImage}
    />,
  )
  expect(view.container.querySelectorAll('.chat-image-gallery')).toHaveLength(1)
  expect(view.getAllByRole('img')).toHaveLength(2)
  const oldImage = view.getByRole('img', { name: 'original-name.png' })
  const thumbnailButton = view.getByRole('button', { name: 'Open original-name.png, image 1 of 2' })
  expect(oldImage.getAttribute('src')).toContain('/files/asset?')
  fireEvent.error(oldImage)
  fireEvent.click(view.getByRole('button', { name: 'Open original-name.png, image 1 of 2' }))
  expect(openFile).toHaveBeenLastCalledWith(session.sessionId, staged)
  act(() => {
    corpus.pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'issue',
          id: issue.id,
          value: {
            ...issue,
            panel: {
              ...issue.panel,
              artifacts: [
                {
                  path: `chat-uploads/${id}/original-name.png`,
                  artifactId: 'durable-copy',
                  entry: 'original-name.png',
                  chatUploadId: id,
                  addedAt: '2026-11-05T12:00:00Z',
                },
              ],
            },
          } as never,
        },
      ],
    })
  })
  const saved = `http://synthetic.invalid/files/artifact/${issue.id}/durable-copy/original-name.png`
  await waitFor(() =>
    expect(view.getByRole('img', { name: 'original-name.png' }).getAttribute('src')).toBe(saved),
  )
  expect(view.getByRole('button', { name: 'Open original-name.png, image 1 of 2' })).toBe(
    thumbnailButton,
  )
  fireEvent.click(view.getByRole('button', { name: 'Open original-name.png, image 1 of 2' }))
  expect(openImage).toHaveBeenLastCalledWith(
    saved,
    [expect.objectContaining({ src: saved }), expect.objectContaining({ label: 'second.png' })],
    0,
  )
  fireEvent.click(view.getByRole('button', { name: 'spec.md' }))
  expect(openFile).toHaveBeenLastCalledWith(session.sessionId, '/repo/spec.md')
})
