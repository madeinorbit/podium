import { LOADING } from '@podium/client-graph/loading'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  attachments: [] as { id: string; filename: string; kind: 'image' }[],
}))
vi.mock('../client/chat-uploads', () => ({
  useChatUploadUrl: () => LOADING,
  useChatItemAttachments: () => state.attachments,
}))
vi.mock('../client/mobile-pool', () => ({ useMobilePool: () => null }))
vi.mock('../client/ServerProfileGate', () => ({ useServerProfile: () => ({ bearer: null }) }))
vi.mock('./Icon', () => ({ Icon: () => null }))
vi.mock('./ImageLightbox', () => ({ ImageLightbox: () => null }))
vi.mock('./ActivityModal', () => ({ ActivityModal: () => null }))
const { SharedFiles } = await import('./SharedFiles')
afterEach(() => {
  cleanup()
  state.attachments = []
})
const context = {
  sessionId: asSessionId('chat'),
  httpOrigin: 'https://example.com',
  cwd: '/synthetic',
}

it('shows a named legacy image from its session URL while its stored copy loads', () => {
  const view = render(
    <SharedFiles
      context={context}
      item={{ id: 'turn', toolPaths: ['/synthetic/photo.png'] } as TranscriptItem}
    />,
  )
  expect(view.getByRole('img', { name: 'photo.png' })).toBeTruthy()
  expect(view.queryByTestId('body-pending')).toBeNull()
})

it('keeps an upload known only by ID pending instead of inventing a session URL', () => {
  state.attachments = [{ id: 'upload-id', filename: 'photo.png', kind: 'image' }]
  const view = render(
    <SharedFiles context={context} item={{ id: 'turn', toolPaths: [] } as TranscriptItem} />,
  )
  expect(view.queryByRole('img')).toBeNull()
  expect(view.getByTestId('body-pending')).toBeTruthy()
})
