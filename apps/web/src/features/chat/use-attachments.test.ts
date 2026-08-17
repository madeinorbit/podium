// @vitest-environment happy-dom
/**
 * THE THREE THINGS WIDENING ATTACHMENTS COULD HAVE BROKEN (POD-1203).
 *
 * The hook stopped being image-only and gained a machine to aim at. Both are
 * easy to get subtly wrong in ways no screen shows: a paste of prose that the
 * composer swallows, or a chip reading `ready` over a path on the wrong disk.
 */
import { asMachineId, asSessionId, type MachineId } from '@podium/model'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '@/app/store'
import { useAttachments } from './use-attachments'

const mutate = vi.fn()
const trpc = { sessions: { uploadImage: { mutate } } } as unknown as Store['trpc']
const sessionId = asSessionId('scope-1')

beforeEach(() => {
  mutate.mockReset()
  mutate.mockImplementation(async (input: { filename: string; machineId?: MachineId }) => ({
    path: `/on/${input.machineId ?? 'default'}/${input.filename}`,
  }))
})

/** A DataTransferItemList happy-dom will not build for us. `kind` is the field
 *  under test, so it is the field the double has to carry honestly. */
function items(entries: { kind: string; type: string; file?: File }[]): DataTransferItemList {
  const list = entries.map((e) => ({
    kind: e.kind,
    type: e.type,
    getAsFile: () => e.file ?? null,
  }))
  return Object.assign(list, { length: list.length }) as unknown as DataTransferItemList
}

function pasteEvent(entries: Parameters<typeof items>[0]): React.ClipboardEvent {
  return {
    clipboardData: { items: items(entries) },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent
}

describe('useAttachments', () => {
  it('takes a document, not only an image', async () => {
    const { result } = renderHook(() => useAttachments({ sessionId, trpc }))

    await act(async () => {
      await result.current.processFiles([
        new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' }),
      ])
    })

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'spec.pdf', mimeType: 'application/pdf' }),
    )
    const [chip] = result.current.attachments
    expect(chip?.state).toBe('ready')
    // No object URL for something the browser cannot show — the strip reads that
    // as "render a document glyph", and `ready()` reads it as the tag kind.
    expect(chip?.previewUrl).toBe('')
    expect(result.current.ready().tags).toEqual([{ kind: 'file', label: 'spec.pdf' }])
  })

  it('still tags an image as an image', async () => {
    const { result } = renderHook(() => useAttachments({ sessionId, trpc }))

    await act(async () => {
      await result.current.processFiles([new File(['x'], 'shot.png', { type: 'image/png' })])
    })

    expect(result.current.ready().tags).toEqual([{ kind: 'image', label: 'shot.png' }])
  })

  /* The one thing widening past mime types must NOT widen. Copied prose arrives
   * as `kind: 'string'`; if the composer intercepted that, ordinary pasting into
   * the prompt box would stop working. */
  it('lets a paste of plain text fall straight through to the field', () => {
    const { result } = renderHook(() => useAttachments({ sessionId, trpc }))
    const event = pasteEvent([{ kind: 'string', type: 'text/plain' }])

    act(() => result.current.onPaste(event))

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
    expect(result.current.attachments).toEqual([])
  })

  it('intercepts a pasted file of any type', async () => {
    const { result } = renderHook(() => useAttachments({ sessionId, trpc }))
    const file = new File(['a,b'], 'rows.csv', { type: 'text/csv' })
    const event = pasteEvent([{ kind: 'file', type: 'text/csv', file }])

    act(() => result.current.onPaste(event))

    expect(event.preventDefault).toHaveBeenCalled()
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ filename: 'rows.csv' })),
    )
  })

  /* An uploaded path is absolute on ONE machine. The home composer's target is a
   * dropdown the operator can still change after attaching, so the bytes follow
   * it — the alternatives are throwing their attachment away or handing the
   * agent a path that does not exist where it runs. */
  it('re-uploads to the new machine when the target changes underneath an attachment', async () => {
    const { result, rerender } = renderHook(
      ({ machineId }: { machineId: MachineId }) => useAttachments({ sessionId, trpc, machineId }),
      { initialProps: { machineId: asMachineId('mac') } },
    )

    await act(async () => {
      await result.current.processFiles([new File(['x'], 'shot.png', { type: 'image/png' })])
    })
    expect(result.current.ready().paths).toEqual(['/on/mac/shot.png'])

    await act(async () => {
      rerender({ machineId: asMachineId('linux-box') })
    })

    await waitFor(() => expect(result.current.ready().paths).toEqual(['/on/linux-box/shot.png']))
    expect(mutate).toHaveBeenCalledTimes(2)
  })

  it('does not re-upload when nothing moved', async () => {
    const machineId = asMachineId('mac')
    const { result, rerender } = renderHook(() => useAttachments({ sessionId, trpc, machineId }))

    await act(async () => {
      await result.current.processFiles([new File(['x'], 'shot.png', { type: 'image/png' })])
    })
    await act(async () => {
      rerender()
    })

    expect(mutate).toHaveBeenCalledTimes(1)
  })

  /* The session chat composer names no machine, so the whole re-target arm has
   * to be inert for it — an upload there must never be repeated. */
  it('is inert for a composer that names no machine at all', async () => {
    const { result, rerender } = renderHook(() => useAttachments({ sessionId, trpc }))

    await act(async () => {
      await result.current.processFiles([new File(['x'], 'shot.png', { type: 'image/png' })])
    })
    await act(async () => {
      rerender()
    })

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0]?.[0]).not.toHaveProperty('machineId')
  })
})
