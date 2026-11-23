import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuildTimeoutError, buildTask, withBuildAttempt } from './build-attempt'

afterEach(() => vi.useRealTimers())
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('overall development build deadline', () => {
  it('does not impose a completed build budget on later background work', async () => {
    vi.useFakeTimers()
    let resume!: () => void
    const pending = new Promise<void>((resolve) => {
      resume = resolve
    })
    let later!: Promise<unknown>
    await withBuildAttempt(async () => {
      later = pending
        .then(() => withBuildAttempt(async () => 'next build', 10))
        .catch((error) => error)
    }, 10)
    await vi.advanceTimersByTimeAsync(100)
    resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(await later).toBe('next build')
  })

  it('shares one budget across preparation, compilation, and publication', async () => {
    vi.useFakeTimers()
    const phases: string[] = []
    const result = withBuildAttempt(async () => {
      await buildTask(() => pause(30))
      phases.push('prepared')
      await withBuildAttempt(() => pause(30), 5_000)
      phases.push('compiled')
      await buildTask(() => pause(30))
      phases.push('published')
    }, 75).catch((error) => error)

    await vi.advanceTimersByTimeAsync(60)
    expect(phases).toEqual(['prepared', 'compiled'])
    await vi.advanceTimersByTimeAsync(15)
    expect(await result).toBeInstanceOf(BuildTimeoutError)
    await vi.advanceTimersByTimeAsync(100)
    expect(phases).toEqual(['prepared', 'compiled'])
  })

  it('prevents a late answer from continuing into publication', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const publish = vi.fn()
    const result = withBuildAttempt(async () => {
      await buildTask(() => pending)
      publish()
    }, 10).catch((error) => error)

    await vi.advanceTimersByTimeAsync(10)
    expect(await result).toBeInstanceOf(BuildTimeoutError)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(publish).not.toHaveBeenCalled()
  })

  it('keeps cancellation separate for independent attempts', async () => {
    vi.useFakeTimers()
    const expired = withBuildAttempt(() => pause(20), 10).catch((error) => error)
    const completed = withBuildAttempt(async () => {
      await pause(30)
      return 'built'
    }, 50)
    await vi.advanceTimersByTimeAsync(30)
    expect(await expired).toBeInstanceOf(BuildTimeoutError)
    expect(await completed).toBe('built')
    expect(vi.getTimerCount()).toBe(0)
  })
})
