import { asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { type ComponentProps, type ReactNode, useState } from 'react'
import type { TextInput, View } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import type { AttachmentReadSource } from '../lib/composer-media-limits'
import { MAX_ATTACHMENT_BYTES } from '../lib/composer-media-limits'
import type { PickedFile } from '../lib/composer-media-types'
import { Composer } from './Composer'
import { type ComposerAttachmentsApi, useComposerAttachments } from './useComposerAttachments'

const native = vi.hoisted(() => ({
  onImagePaste: vi.fn(),
  readAsStringAsync: vi.fn(async (_uri: string, _options: unknown) => 'cG5n'),
  getInfoAsync: vi.fn(),
  stop: vi.fn(),
  pasted: undefined as ((source: () => Promise<AttachmentReadSource[]>) => void) | undefined,
  input: undefined as ComponentProps<typeof TextInput> | undefined,
  inputVersion: 0,
  registered: false,
}))
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  const { forwardRef } = await import('react')
  return {
    ...rn,
    TextInput: forwardRef<TextInput, ComponentProps<typeof TextInput>>((props, ref) => {
      native.input = props
      return <rn.TextInput key={native.inputVersion} {...props} ref={ref} onLayout={undefined} />
    }),
  }
})
// Drive Composer's own binding through the native adapter. The .js specifier
// resolves its native .ts entry instead of this lane's default .web.ts entry.
vi.mock('../lib/composer-media', async () => import('../lib/composer-media.js'))
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
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('expo-blur', async () => {
  const { View } = await import('react-native')
  return { BlurView: (props: ComponentProps<typeof View>) => <View {...props} /> }
})
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

let attachments: ComposerAttachmentsApi
function Harness({
  onSend = () => {},
  pickMedia,
}: {
  onSend?: ComponentProps<typeof Composer>['onSend']
  pickMedia?: () => Promise<PickedFile[]>
}) {
  const api = useComposerAttachments(asSessionId('paste-session'), { pickMedia })
  const [text, setText] = useState('Describe this')
  attachments = api
  return (
    <Composer
      placeholder="Message"
      value={text}
      onChangeText={setText}
      onSend={onSend}
      attachments={api}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  native.input = undefined
  native.inputVersion = 0
  native.registered = false
  native.pasted = undefined
  native.onImagePaste.mockImplementation((_node, handler) => {
    // Simulate the initial pager input being unavailable until its first layout.
    if (native.registered) native.pasted = handler
    return native.stop
  })
})
afterEach(cleanup)

const image = (
  name: string,
  mimeType = 'image/png',
  size = 3,
): Omit<AttachmentReadSource, 'error'> => ({
  name,
  mimeType,
  size,
  uri: `file:///${name}`,
  previewUri: `file:///${name}`,
})

function paste(files: AttachmentReadSource[]) {
  native.pasted?.(async () => files)
}

function layoutInput() {
  native.registered = true
  act(() =>
    native.input?.onLayout?.({
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 72 } },
    } as never),
  )
}

async function mountComposer(...args: Parameters<typeof renderWithMobileStore>) {
  const app = await renderWithMobileStore(...args)
  layoutInput()
  return app
}

describe('pasted image attachment intake', () => {
  it('binds the initial chat input after layout and replaces its binding only when the input changes', async () => {
    const uploadImage = vi.fn(async () => ({ path: '/uploads/initial.png' }))
    const app = await renderWithMobileStore(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })
    expect(native.onImagePaste).not.toHaveBeenCalled()
    const initialInput = screen.getByLabelText('Message')
    layoutInput()
    expect(native.onImagePaste).toHaveBeenCalledTimes(1)
    expect(native.onImagePaste.mock.calls[0]?.[0]).toBe(initialInput)
    act(() => paste([image('initial.png')]))
    await waitFor(() => expect(attachments.ready()).toHaveLength(1))
    expect(screen.getByLabelText('initial.png')).toBeTruthy()
    fireEvent.change(initialInput, { target: { value: 'Keep this attachment' } })
    layoutInput()
    expect(native.onImagePaste).toHaveBeenCalledTimes(1)
    expect(native.stop).not.toHaveBeenCalled()
    native.inputVersion += 1
    native.registered = false
    fireEvent.change(initialInput, { target: { value: 'Replacement input' } })
    const replacementInput = screen.getByLabelText('Message')
    expect(replacementInput).not.toBe(initialInput)
    layoutInput()
    expect(native.onImagePaste).toHaveBeenCalledTimes(2)
    expect(native.onImagePaste.mock.calls[1]?.[0]).toBe(replacementInput)
    expect(native.stop).toHaveBeenCalledTimes(1)
    app.unmount()
    expect(native.stop).toHaveBeenCalledTimes(2)
  })

  it('blocks Send before native image preparation has even produced file sources', async () => {
    let finishPreparation: ((files: AttachmentReadSource[]) => void) | undefined
    const onSend = vi.fn()
    const uploadImage = vi.fn(async () => ({ path: '/uploads/prepared.png' }))
    await mountComposer(<Harness onSend={onSend} />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })
    const beforeRender = attachments
    act(() => {
      native.pasted?.(
        () =>
          new Promise((resolve) => {
            finishPreparation = resolve
          }),
      )
      expect(beforeRender.uploading).toBe(true)
      fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Enter', metaKey: true })
    })
    expect(onSend).not.toHaveBeenCalled()
    expect(native.readAsStringAsync).not.toHaveBeenCalled()
    await waitFor(() => expect(finishPreparation).toBeTypeOf('function'))
    await act(async () => finishPreparation?.([image('prepared.png')]))
    await waitFor(() => expect(attachments.ready()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('drops a removed preparation result instead of attaching it to the next message', async () => {
    let finishPreparation: ((files: AttachmentReadSource[]) => void) | undefined
    const onSend = vi.fn()
    const uploadImage = vi.fn(async () => ({ path: '/uploads/fresh.png' }))
    await mountComposer(<Harness onSend={onSend} />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })
    act(() =>
      native.pasted?.(
        () =>
          new Promise((resolve) => {
            finishPreparation = resolve
          }),
      ),
    )
    await waitFor(() => expect(finishPreparation).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Attachment' }))
    expect(attachments.uploading).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Describe this', undefined)
    await act(async () => finishPreparation?.([image('cancelled.png')]))
    await waitFor(() => expect(native.readAsStringAsync).toHaveBeenCalledTimes(1))
    expect(attachments.attachments).toEqual([])
    expect(uploadImage).not.toHaveBeenCalled()
    act(() => paste([image('fresh.png')]))
    await waitFor(() => expect(attachments.ready()).toHaveLength(1))
    expect(attachments.ready()[0]?.name).toBe('fresh.png')
  })

  it('keeps queued reservations in place and skips a cancelled picker before it opens', async () => {
    let finishFirst: ((files: PickedFile[]) => void) | undefined
    const cancelledPicker = vi.fn(async () => [])
    const nextPicker = vi.fn(async () => [])
    const uploadImage = vi.fn(async () => ({ path: '/uploads/first.png' }))
    await mountComposer(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })
    act(() => {
      attachments.fromSource(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve
          }),
      )
      attachments.fromSource(cancelledPicker)
    })
    expect(attachments.attachments).toHaveLength(2)
    const cancelled = attachments.attachments[1]
    if (!cancelled) throw new Error('Missing queued reservation')
    act(() => attachments.remove(cancelled.id))
    act(() => attachments.fromSource(nextPicker))
    await waitFor(() => expect(finishFirst).toBeTypeOf('function'))
    await act(async () => finishFirst?.([{ ...image('first.png'), dataBase64: 'cG5n' }]))
    await waitFor(() => expect(attachments.ready()).toHaveLength(1))
    await waitFor(() => expect(nextPicker).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(attachments.uploading).toBe(false))
    expect(cancelledPicker).not.toHaveBeenCalled()
    expect(attachments.attachments.map((file) => file.name)).toEqual(['first.png'])
    expect(attachments.uploading).toBe(false)
  })

  it.each([
    'paste',
    'picker',
  ] as const)('reserves %s intake before a slow filesystem read and guards a send in the same turn', async (intake) => {
    let finishRead: ((data: string) => void) | undefined
    native.readAsStringAsync.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishRead = resolve
        }),
    )
    const file = image('delayed.png')
    const pickMedia = async (): Promise<PickedFile[]> => [
      {
        ...file,
        dataBase64: await native.readAsStringAsync(file.uri, { encoding: 'base64' }),
      },
    ]
    const onSend = vi.fn()
    const uploadImage = vi.fn(async () => ({ path: '/uploads/delayed.png' }))
    await mountComposer(<Harness onSend={onSend} pickMedia={pickMedia} />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })
    const input = screen.getByLabelText('Message')
    act(() => {
      if (intake === 'paste') paste([file])
      else attachments.pick?.()
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    })
    expect(onSend).not.toHaveBeenCalled()
    expect(attachments.uploading).toBe(true)
    expect(attachments.attachments).toMatchObject([{ state: 'uploading' }])
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).not.toHaveBeenCalled()
    await waitFor(() => expect(finishRead).toBeTypeOf('function'))
    expect(uploadImage).not.toHaveBeenCalled()
    await act(async () => finishRead?.('cG5n'))
    await waitFor(() => expect(attachments.ready()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Describe this', [
      {
        name: 'delayed.png',
        previewUri: 'file:///delayed.png',
        path: '/uploads/delayed.png',
      },
    ])
  })

  it('uploads PNG and HEIC through sessions.uploadImage and keeps the strip previews and send refs', async () => {
    const uploadImage = vi.fn(
      async ({ filename, mimeType }: { filename: string; mimeType: string }) => ({
        path: '',
        attachment: { id: filename, filename, mediaType: mimeType, kind: 'image' as const },
      }),
    )
    await mountComposer(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })

    act(() => paste([image('pasted.png'), image('pasted.heic', 'image/heic')]))
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
    await mountComposer(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })
    act(() =>
      paste([
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
    await mountComposer(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })
    act(() => {
      paste([image('first.png')])
      paste([image('second.png')])
    })
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(1))
    expect(native.readAsStringAsync).toHaveBeenCalledTimes(1)
    expect(attachments.uploading).toBe(true)
    await act(async () => finish?.())
    await waitFor(() => expect(attachments.ready()).toHaveLength(2))
    expect(native.readAsStringAsync).toHaveBeenCalledTimes(2)
  })
})
