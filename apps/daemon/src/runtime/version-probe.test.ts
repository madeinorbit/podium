import { describe, expect, it } from 'vitest'
import { createVersionProbeCache } from './version-probe'

type Verdict =
  | { drivable: true }
  | { drivable: false; reason: 'unsupported' | 'unprobeable'; diagnostic: string }

const evaluate = ({ output, ok }: { output: string; ok: boolean }): Verdict =>
  ok
    ? { drivable: true }
    : { drivable: false, reason: 'unprobeable', diagnostic: output || 'no answer' }

describe('the asynchronous version-probe cache', () => {
  it('coalesces an in-flight child for concurrent spawn admissions', async () => {
    const cache = createVersionProbeCache<Verdict>({ evaluate })
    let calls = 0
    let finish!: (result: { output: string; ok: boolean }) => void
    const run = () => {
      calls += 1
      return new Promise<{ output: string; ok: boolean }>((resolve) => {
        finish = resolve
      })
    }

    const first = cache.probe(run)
    const second = cache.probe(run)
    await Promise.resolve()
    expect(calls).toBe(1)
    finish({ output: '1.0.0', ok: true })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { drivable: true },
      { drivable: true },
    ])
  })

  it('caches an inconclusive answer briefly, then retries instead of refusing forever', async () => {
    let now = 1_000
    const cache = createVersionProbeCache<Verdict>({
      evaluate,
      now: () => now,
      unprobeableTtlMs: 100,
    })
    let calls = 0
    const run = () => {
      calls += 1
      return calls === 1 ? { output: 'ETIMEDOUT', ok: false } : { output: '1.0.0', ok: true }
    }

    await expect(cache.probe(run)).resolves.toMatchObject({
      drivable: false,
      reason: 'unprobeable',
    })
    await expect(cache.probe(run)).resolves.toMatchObject({
      drivable: false,
      reason: 'unprobeable',
    })
    expect(calls).toBe(1)

    now += 101
    await expect(cache.probe(run)).resolves.toEqual({ drivable: true })
    expect(calls).toBe(2)
  })

  it('retries a completed inconclusive answer deliberately while coalescing concurrent retries', async () => {
    const cache = createVersionProbeCache<Verdict>({ evaluate })
    await cache.probe(() => ({ output: 'ENOENT', ok: false }))

    let calls = 0
    let finish!: (result: { output: string; ok: boolean }) => void
    const recovered = () => {
      calls += 1
      return new Promise<{ output: string; ok: boolean }>((resolve) => {
        finish = resolve
      })
    }
    const first = cache.probe(recovered, { retryInconclusive: true })
    const second = cache.probe(recovered, { retryInconclusive: true })
    await Promise.resolve()
    expect(calls).toBe(1)

    finish({ output: '1.0.0', ok: true })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { drivable: true },
      { drivable: true },
    ])
  })
})
