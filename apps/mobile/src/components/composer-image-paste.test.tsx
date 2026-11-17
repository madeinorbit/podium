import { asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import type { AttachmentReadSource } from '../lib/composer-media-limits'
import { MAX_ATTACHMENT_BYTES } from '../lib/composer-media-limits'
import { AttachmentStrip } from './AttachmentStrip'
import { type ComposerAttachmentsApi, useComposerAttachments } from './useComposerAttachments'

const native = vi.hoisted(() => ({
  onImagePaste: vi.fn(),
  readAsStringAsync: vi.fn(async (_uri: string, _options: unknown) => 'cG5n'),
  getInfoAsync: vi.fn(),
  stop: vi.fn(),
  pasted: undefined as ((files: AttachmentReadSource[]) => void) | undefined,
}))
vi.mock('../lib/composer-image-paste', () => ({ onImagePaste: native.onImagePaste }))
vi.mock('expo-clipboard', () => ({}))
vi.mock('expo-image-picker', () => ({}))
vi.mock('expo-document-picker', () => ({}))
vi.mock('expo-file-system/legacy', () => ({
  getInfoAsync: native.getInfoAsync,
  readAsStringAsync: native.readAsStringAsync,
  EncodingType: { Base64: 'base64' },
}))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))

// The .js specifier resolves the native .ts entry instead of the lane's .web.ts.
const { onMediaPaste } = await import('../lib/composer-media.js')

let attachments: ComposerAttachmentsApi
function Harness() {
  const api = useComposerAttachments(asSessionId('paste-session'))
  attachments = api
  useEffect(() => onMediaPaste(null, api.accept, api.fromSource), [api.accept, api.fromSource])
  return <AttachmentStrip attachments={api.attachments} onRemove={api.remove} />
}

beforeEach(() => {
  vi.clearAllMocks()
  native.onImagePaste.mockImplementation((_node, handler) => {
    native.pasted = handler
    return native.stop
  })
})
afterEach(cleanup)

const image = (name: string, mimeType = 'image/png', size = 3): AttachmentReadSource => ({
  name,
  mimeType,
  size,
  uri: `file:///${name}`,
  previewUri: `file:///${name}`,
})

describe('pasted image attachment intake', () => {
  it('uploads PNG and HEIC through sessions.uploadImage and keeps the strip previews and send refs', async () => {
    const uploadImage = vi.fn(
      async ({ filename, mimeType }: { filename: string; mimeType: string }) => ({
        path: '',
        attachment: { id: filename, filename, mediaType: mimeType, kind: 'image' as const },
      }),
    )
    await renderWithMobileStore(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })

    act(() => native.pasted?.([image('pasted.png'), image('pasted.heic', 'image/heic')]))
    await waitFor(() => expect(attachments.ready()).toHaveLength(2))
    expect(uploadImage.mock.calls.map(([input]) => input)).toEqual([
      {
        sessionId: 'paste-session',
        filename: 'pasted.png',
        mimeType: 'image/png',
        dataBase64: 'cG5n',
      },
      {
        sessionId: 'paste-session',
        filename: 'pasted.heic',
        mimeType: 'image/heic',
        dataBase64: 'cG5n',
      },
    ])
    expect(screen.getByLabelText('pasted.png')).toBeTruthy()
    expect(screen.getByLabelText('pasted.heic')).toBeTruthy()
    expect(attachments.ready()).toEqual([
      {
        name: 'pasted.png',
        previewUri: 'file:///pasted.png',
        ref: { id: 'pasted.png', filename: 'pasted.png', mediaType: 'image/png', kind: 'image' },
      },
      {
        name: 'pasted.heic',
        previewUri: 'file:///pasted.heic',
        ref: { id: 'pasted.heic', filename: 'pasted.heic', mediaType: 'image/heic', kind: 'image' },
      },
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted.png' }))
    expect(attachments.ready().map((file) => file.name)).toEqual(['pasted.heic'])
  })

  it('rejects oversized, unreadable and overflow images without encoding or uploading them', async () => {
    const uploadImage = vi.fn(async ({ filename }: { filename: string }) => ({
      path: `/uploads/${filename}`,
    }))
    await renderWithMobileStore(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })
    act(() =>
      native.pasted?.([
        image('large.png', 'image/png', MAX_ATTACHMENT_BYTES + 1),
        { ...image('unreadable.heic', 'image/heic'), error: 'Could not read the clipboard image.' },
        image('third.png'),
        image('fourth.png'),
        image('fifth.png'),
        image('sixth.png'),
      ]),
    )
    await waitFor(() => expect(attachments.attachments).toHaveLength(5))
    await waitFor(() => expect(attachments.ready()).toHaveLength(2))
    expect(native.readAsStringAsync.mock.calls.map(([uri]) => uri)).toEqual([
      'file:///third.png',
      'file:///fourth.png',
    ])
    expect(uploadImage).toHaveBeenCalledTimes(2)
    expect(screen.getByText('large.png is larger than 7.5 MB.')).toBeTruthy()
    expect(screen.getByText('Could not read the clipboard image.')).toBeTruthy()
    expect(screen.getByText('Attach up to 4 files at a time.')).toBeTruthy()
    expect(attachments.attachments.at(-1)?.name).toBe('2 more files')
  })

  it('queues rapid native paste reads behind the preceding upload', async () => {
    let finish: (() => void) | undefined
    const uploadImage = vi.fn(async ({ filename }: { filename: string }) => {
      if (filename === 'first.png')
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      return { path: `/uploads/${filename}` }
    })
    await renderWithMobileStore(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })
    act(() => {
      native.pasted?.([image('first.png')])
      native.pasted?.([image('second.png')])
    })
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(1))
    expect(native.readAsStringAsync).toHaveBeenCalledTimes(1)
    expect(attachments.uploading).toBe(true)
    await act(async () => finish?.())
    await waitFor(() => expect(attachments.ready()).toHaveLength(2))
    expect(native.readAsStringAsync).toHaveBeenCalledTimes(2)
  })
})
