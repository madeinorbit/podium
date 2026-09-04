import { asSessionId } from '@podium/model'
import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import type { PickedFile } from '../lib/composer-media'
import { openNativePicker } from '../lib/composer-picker-errors'
import { type ComposerAttachmentsApi, useComposerAttachments } from './useComposerAttachments'

afterEach(cleanup)

const picked = (name: string): PickedFile => ({
  name,
  mimeType: 'image/png',
  previewUri: `file:///${name}`,
  dataBase64: `bytes:${name}`,
})

describe('composer attachment session boundary', () => {
  it('shares one target and serializes uploads across overlapping picker batches', async () => {
    let release: ((sessionId: ReturnType<typeof asSessionId>) => void) | undefined
    let releaseFirstUpload: (() => void) | undefined
    let activeUploads = 0
    let peakUploads = 0
    const prepareSession = vi.fn(
      () =>
        new Promise<ReturnType<typeof asSessionId>>((resolve) => {
          release = resolve
        }),
    )
    const uploadImage = vi.fn(async ({ filename }: { filename: string }) => {
      activeUploads += 1
      peakUploads = Math.max(peakUploads, activeUploads)
      if (filename === 'one.png') {
        await new Promise<void>((resolve) => {
          releaseFirstUpload = resolve
        })
      }
      activeUploads -= 1
      return { path: `/uploads/${filename}` }
    })
    let api: ComposerAttachmentsApi | undefined

    function Harness() {
      api = useComposerAttachments(undefined, { prepareSession })
      return null
    }

    await renderWithMobileStore(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })

    act(() => {
      api?.accept([picked('one.png')])
      api?.accept([picked('two.png')])
    })
    await waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(1))
    expect(uploadImage).not.toHaveBeenCalled()

    await act(async () => release?.(asSessionId('session:attachments')))
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(1))
    expect(uploadImage.mock.calls[0]?.[0].filename).toBe('one.png')
    expect(peakUploads).toBe(1)

    await act(async () => releaseFirstUpload?.())
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(2))
    expect(uploadImage.mock.calls.map(([input]) => input.filename)).toEqual(['one.png', 'two.png'])
    expect(prepareSession).toHaveBeenCalledTimes(1)
    expect(peakUploads).toBe(1)
  })

  it('serializes picker reads through the preceding batch upload', async () => {
    let releaseFirstRead: (() => void) | undefined
    let releaseFirstUpload: (() => void) | undefined
    let batch = 0
    let activeReads = 0
    let peakReads = 0
    const pickMedia = vi.fn(async () => {
      const current = ++batch
      activeReads += 1
      peakReads = Math.max(peakReads, activeReads)
      if (current === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRead = resolve
        })
      }
      activeReads -= 1
      return [picked(`${current}.png`)]
    })
    const uploadImage = vi.fn(async ({ filename }: { filename: string }) => {
      if (filename === '1.png') {
        await new Promise<void>((resolve) => {
          releaseFirstUpload = resolve
        })
      }
      return { path: `/uploads/${filename}` }
    })
    let api: ComposerAttachmentsApi | undefined

    function Harness() {
      api = useComposerAttachments(asSessionId('session:existing'), { pickMedia })
      return null
    }

    await renderWithMobileStore(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })

    act(() => {
      api?.pick?.()
      api?.pick?.()
    })
    await waitFor(() => expect(pickMedia).toHaveBeenCalledTimes(1))
    expect(peakReads).toBe(1)

    await act(async () => releaseFirstRead?.())
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(1))
    // The second filesystem/base64 read stays behind the first retained upload.
    expect(pickMedia).toHaveBeenCalledTimes(1)

    await act(async () => releaseFirstUpload?.())
    await waitFor(() => expect(pickMedia).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(2))
    expect(peakReads).toBe(1)
  })

  it('keeps native picker cancellation empty and surfaces denial without creating a session', async () => {
    const launch = vi
      .fn<() => Promise<{ cancelled: boolean; value: PickedFile[] }>>()
      .mockResolvedValueOnce({ cancelled: true, value: [] })
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'ERR_DENIED' }))
    const pickMedia = vi.fn(async () => (await openNativePicker('Photos', launch)) ?? [])
    const prepareSession = vi.fn(async () => asSessionId('should-not-exist'))
    const uploadImage = vi.fn(async () => ({ path: '/should-not-upload' }))
    let api: ComposerAttachmentsApi | undefined

    function Harness() {
      api = useComposerAttachments(undefined, { prepareSession, pickMedia })
      return null
    }

    await renderWithMobileStore(<Harness />, {
      api: { sessions: { uploadImage: { mutate: uploadImage } } },
    })

    act(() => api?.pick?.())
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    await act(async () => {
      await pickMedia.mock.results[0]?.value
    })
    expect(api?.attachments).toEqual([])
    expect(prepareSession).not.toHaveBeenCalled()
    expect(uploadImage).not.toHaveBeenCalled()

    act(() => api?.pick?.())
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api?.attachments).toHaveLength(1))
    expect(api?.attachments[0]).toMatchObject({
      state: 'failed',
      error: 'Photos access was denied. Allow access in Settings, then try again.',
    })
    expect(prepareSession).not.toHaveBeenCalled()
    expect(uploadImage).not.toHaveBeenCalled()
  })
})
