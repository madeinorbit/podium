import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { reportHarnessProbe, withHarnessVersionReporting } from '../harness-version-reporting'
import { createVersionProbeCache, grokAcpVersionProbe, resetGrokAcpVersionProbe } from './version-probe'

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

it('retries an inconclusive but admitted harness after its TTL', async () => {
  let now = 0
  const cache = createVersionProbeCache({
    now: () => now,
    unprobeableTtlMs: 10,
    evaluate: ({ ok }) => ({ drivable: true, ...(!ok ? { reason: 'unprobeable' as const } : {}) }),
  })
  let calls = 0
  const run = () => ({ output: '', ok: ++calls > 1 })
  await expect(cache.probe(run)).resolves.toEqual({ drivable: true, reason: 'unprobeable' })
  await cache.probe(run)
  expect(calls).toBe(1)
  now = 11
  await expect(cache.probe(run)).resolves.toEqual({ drivable: true })
  expect(calls).toBe(2)
})

it('keeps asynchronous version observations scoped to their machine and never gates the caller', async () => {
  const first: DaemonMessage[] = []
  const second: DaemonMessage[] = []
  await Promise.all([
    withHarnessVersionReporting(
      (message) => {
        first.push(message)
      },
      async () => {
        await Promise.resolve()
        reportHarnessProbe('codex', 'codex-cli 0.154.0')
      },
    ),
    withHarnessVersionReporting(
      (message) => {
        second.push(message)
      },
      async () => {
        await Promise.resolve()
        reportHarnessProbe('/usr/bin/grok', '0.2.118')
      },
    ),
  ])
  expect(first).toEqual([
    {
      type: 'machineHarnessVersion',
      harness: 'codex',
      version: '0.154.0',
      probedAt: expect.any(String),
    },
  ])
  expect(second).toEqual([
    {
      type: 'machineHarnessVersion',
      harness: 'grok',
      version: '0.2.118',
      probedAt: expect.any(String),
    },
  ])
  expect(() =>
    withHarnessVersionReporting(
      () => {
        throw new Error('offline')
      },
      () => reportHarnessProbe('codex', '0.154.0'),
    ),
  ).not.toThrow()
})

describe('grok ACP version probe memoization', () => {
  it('temporarily memoizes an unprobeable result', async () => {
    resetGrokAcpVersionProbe()
    let calls = 0
    const first = await grokAcpVersionProbe(() => {
      calls += 1
      return { ok: false, output: 'timed out' }
    })
    const second = await grokAcpVersionProbe(() => {
      calls += 1
      return { ok: true, output: 'grok 0.2.118' }
    })
    expect(first).toMatchObject({ drivable: true, reason: 'unprobeable' })
    expect(second).toMatchObject({ drivable: true, reason: 'unprobeable' })
    expect(calls).toBe(1)
  })

  it('memoizes a definitive unsupported version', async () => {
    resetGrokAcpVersionProbe()
    let calls = 0
    const probe = () => {
      calls += 1
      return { ok: true, output: 'grok 0.2.22' }
    }
    await expect(grokAcpVersionProbe(probe)).resolves.toMatchObject({
      drivable: false,
      reason: 'unsupported',
    })
    await expect(grokAcpVersionProbe(probe)).resolves.toMatchObject({ reason: 'unsupported' })
    expect(calls).toBe(1)
  })
})
