import { describe, expect, it } from 'vitest'
import { PortableStateFence, PortableStateFencedError } from './portable-state-fence'

describe('PortableStateFence', () => {
  it('closes admission before draining an in-flight writer', async () => {
    const fence = new PortableStateFence()
    let finishWrite!: () => void
    const writeFinished = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const activeWrite = fence.run(() => writeFinished)

    let drained = false
    const drain = fence.pauseAndDrain().then(() => {
      drained = true
    })

    await expect(fence.run(async () => undefined)).rejects.toBeInstanceOf(PortableStateFencedError)
    expect(drained).toBe(false)

    finishWrite()
    await activeWrite
    await drain
    expect(drained).toBe(true)
  })

  it('re-admits writers only after an explicit safe-abort resume', async () => {
    const fence = new PortableStateFence()
    await fence.pauseAndDrain()

    expect(() => fence.runSync(() => 'blocked')).toThrow(PortableStateFencedError)

    fence.resume()
    expect(fence.runSync(() => 'resumed')).toBe('resumed')
  })
})
