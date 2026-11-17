import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImagePasteEvent } from './composer-image-paste'
import type { AttachmentReadSource } from './composer-media-limits'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_PICK } from './composer-media-limits'

const bridge = vi.hoisted(() => ({
  bindInput: vi.fn(async () => {}),
  unbindInput: vi.fn(async () => {}),
  remove: vi.fn(),
  addListener: vi.fn(),
  listener: undefined as ((event: ImagePasteEvent) => void) | undefined,
}))

vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => bridge }))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  findNodeHandle: () => 27,
}))

const { onImagePaste } = await import('./composer-image-paste')
const node = {} as Parameters<typeof onImagePaste>[0]
const files: AttachmentReadSource[] = [
  {
    uri: 'file:///clipboard.png',
    name: 'clipboard.png',
    mimeType: 'image/png',
    previewUri: 'file:///clipboard.png',
  },
]
const start = (pasteId: string, target = 27) =>
  bridge.listener?.({ target, pasteId, phase: 'preparing' })
const complete = (pasteId: string, result = files, target = 27) =>
  bridge.listener?.({ target, pasteId, phase: 'ready', files: result })

function resultFrom(
  pasted: { mock: { calls: [() => Promise<AttachmentReadSource[]>][] } },
  index = 0,
) {
  const read = pasted.mock.calls[index]?.[0]
  if (!read) throw new Error('No native preparation was reserved')
  return read()
}

beforeEach(() => {
  vi.clearAllMocks()
  bridge.addListener.mockImplementation((_name, listener) => {
    bridge.listener = listener
    return { remove: bridge.remove }
  })
})

describe('native composer paste binding', () => {
  it('reserves this input during native preparation, then supplies its captured files', async () => {
    const pasted = vi.fn((_source: () => Promise<AttachmentReadSource[]>) => {})
    const stop = onImagePaste(node, pasted)
    await vi.waitFor(() =>
      expect(bridge.bindInput).toHaveBeenCalledWith(
        27,
        MAX_ATTACHMENT_BYTES,
        MAX_ATTACHMENTS_PER_PICK,
      ),
    )
    start('other-input', 28)
    complete('other-input', files, 28)
    expect(pasted).not.toHaveBeenCalled()
    start('current')
    expect(pasted).toHaveBeenCalledTimes(1)
    const result = resultFrom(pasted)
    complete('current')
    await expect(result).resolves.toEqual(files)
    stop()
    await vi.waitFor(() => expect(bridge.unbindInput).toHaveBeenCalledTimes(1))
  })

  it('releases pending preparation and serializes teardown ahead of a replacement binding', async () => {
    let finish: (() => void) | undefined
    bridge.bindInput.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const pasted = vi.fn((_source: () => Promise<AttachmentReadSource[]>) => {})
    const stop = onImagePaste(node, pasted)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    start('cancelled')
    const cancelled = resultFrom(pasted)
    const oldListener = bridge.listener
    stop()
    expect(bridge.remove).toHaveBeenCalledTimes(1)
    await expect(cancelled).resolves.toEqual([])
    oldListener?.({ target: 27, pasteId: 'late-start', phase: 'preparing' })
    expect(pasted).toHaveBeenCalledTimes(1)
    const replacement = onImagePaste(node, vi.fn())
    expect(bridge.bindInput).toHaveBeenCalledTimes(1)
    expect(bridge.unbindInput).not.toHaveBeenCalled()
    finish?.()
    await vi.waitFor(() => expect(bridge.bindInput).toHaveBeenCalledTimes(2))
    const secondBind = bridge.bindInput.mock.invocationCallOrder[1]
    if (secondBind === undefined) throw new Error('Replacement input was not bound')
    expect(bridge.unbindInput.mock.invocationCallOrder[0]).toBeLessThan(secondBind)
    replacement()
    await vi.waitFor(() => expect(bridge.unbindInput).toHaveBeenCalledTimes(2))
  })

  it('correlates separate preparation results instead of reading the live clipboard again', async () => {
    const pasted = vi.fn((_source: () => Promise<AttachmentReadSource[]>) => {})
    const stop = onImagePaste(node, pasted)
    start('first')
    start('second')
    const first = resultFrom(pasted)
    const second = resultFrom(pasted, 1)
    const firstDone = vi.fn()
    void first.then(firstDone)
    complete('unknown')
    complete('second', [])
    await expect(second).resolves.toEqual([])
    expect(firstDone).not.toHaveBeenCalled()
    complete('first')
    await expect(first).resolves.toEqual(files)
    stop()
    await vi.waitFor(() => expect(bridge.unbindInput).toHaveBeenCalledTimes(1))
  })

  it('ignores an old preparation result after the same input is rebound', async () => {
    const old = vi.fn((_source: () => Promise<AttachmentReadSource[]>) => {})
    const stopOld = onImagePaste(node, old)
    start('old')
    const oldResult = resultFrom(old)
    stopOld()
    await expect(oldResult).resolves.toEqual([])
    const current = vi.fn((_source: () => Promise<AttachmentReadSource[]>) => {})
    const stopCurrent = onImagePaste(node, current)
    start('new')
    const currentResult = resultFrom(current)
    const done = vi.fn()
    void currentResult.then(done)
    complete('old')
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    complete('new')
    await expect(currentResult).resolves.toEqual(files)
    stopCurrent()
    await vi.waitFor(() => expect(bridge.unbindInput).toHaveBeenCalledTimes(2))
  })
})
