import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentReadSource } from './composer-media-limits'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_PICK } from './composer-media-limits'

const bridge = vi.hoisted(() => ({
  bindInput: vi.fn(async () => {}),
  unbindInput: vi.fn(async () => {}),
  remove: vi.fn(),
  addListener: vi.fn(),
  listener: undefined as
    | ((event: { target: number; files: AttachmentReadSource[] }) => void)
    | undefined,
}))

vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => bridge }))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  findNodeHandle: () => 27,
}))

const { onImagePaste } = await import('./composer-image-paste')

beforeEach(() => {
  vi.clearAllMocks()
  bridge.addListener.mockImplementation((_name, listener) => {
    bridge.listener = listener
    return { remove: bridge.remove }
  })
})

describe('native composer paste binding', () => {
  it('opts in just the mounted input with the picker limits and routes only its paste events', () => {
    const pasted = vi.fn()
    const node = {} as Parameters<typeof onImagePaste>[0]
    const stop = onImagePaste(node, pasted)
    expect(bridge.bindInput).toHaveBeenCalledWith(
      27,
      MAX_ATTACHMENT_BYTES,
      MAX_ATTACHMENTS_PER_PICK,
    )
    expect(pasted).not.toHaveBeenCalled()
    const files = [
      {
        uri: 'file:///clipboard.png',
        name: 'clipboard.png',
        mimeType: 'image/png',
        previewUri: 'file:///clipboard.png',
      },
    ]
    bridge.listener?.({ target: 28, files })
    expect(pasted).not.toHaveBeenCalled()
    bridge.listener?.({ target: 27, files })
    expect(pasted).toHaveBeenCalledExactlyOnceWith(files)
    stop()
  })

  it('removes its listener immediately and unbinds even if registration is still in flight', async () => {
    let finish: (() => void) | undefined
    bridge.bindInput.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const stop = onImagePaste({} as Parameters<typeof onImagePaste>[0], vi.fn())
    stop()
    expect(bridge.remove).toHaveBeenCalledTimes(1)
    expect(bridge.unbindInput).not.toHaveBeenCalled()
    finish?.()
    await vi.waitFor(() => expect(bridge.unbindInput).toHaveBeenCalledWith(27))
  })
})
