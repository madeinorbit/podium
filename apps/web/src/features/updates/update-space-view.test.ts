import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateSpaceView } from './update-space-view'

const views: UpdateSpaceView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.close()
  vi.useRealTimers()
})
const GiB = 1024 ** 3
const preview = {
  machines: [
    {
      machineId: 'build',
      name: 'build-box',
      targetVersion: 'next',
      status: 'low',
      checkedAt: 1,
      volumes: [
        {
          path: '/var/lib/podium',
          availableBytes: Math.floor(1.2 * GiB),
          peakBytes: 2 * GiB,
          requiredBytes: 3 * GiB,
          shortfallBytes: Math.floor(1.8 * GiB),
        },
      ],
    },
  ],
}

describe('disk space request answer', () => {
  function view(read: () => Promise<unknown>) {
    const view = new UpdateSpaceView(read)
    views.push(view)
    return view
  }

  it('uses the approved short warning, and expires without polling', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValue(preview)
    const v = view(read)
    await v.refresh()
    expect(v.warnings).toEqual([
      'Low disk space on build-box: 1.2 GiB available; about 3.0 GiB needed. This update is likely to fail.',
    ])
    expect(v.summary).toBe('')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(v.stale).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('ignores an older result after a newer check and after the view closes', async () => {
    vi.useFakeTimers()
    let resolve!: (result: unknown) => void
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      )
      .mockResolvedValue({ machines: [] })
    const v = view(read)
    const old = v.refresh()
    await v.refresh()
    resolve(preview)
    await old
    expect(v.answer).toEqual({ machines: [] })
    v.close()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(v.answer).toBeUndefined()
    expect(v.stale).toBe(false)
  })

  it('turns an unavailable endpoint or malformed response into an informational unknown', async () => {
    const v = view(async () => {
      throw new Error('old server')
    })
    await v.refresh()
    expect(v.error).toBe('Disk space could not be verified.')
    expect(v.warnings).toEqual([])
  })
})
