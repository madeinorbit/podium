import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { reportHarnessProbe, withHarnessVersionReporting } from '../harness-version-reporting'
import { createVersionProbeCache, grokAcpVersionProbe, resetGrokAcpVersionProbe } from './version-probe'
import {
  codexAppServerVersionProbe,
  opencode2VersionProbe,
  opencodeVersionDiagnostic,
  opencodeVersionProbe,
  resetCodexAppServerVersionProbe,
  resetOpencode2VersionProbe,
  resetOpencodeVersionProbe,
} from './version-probe'

/** One installation every memo test below asks about (POD-6546: verdicts are
 *  cached per installation). */
const TEST_INSTALLATION = { executable: '/opt/rig/bin/harness', version: '', generation: 0 }

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
    const first = await grokAcpVersionProbe(TEST_INSTALLATION, {
      env: {},
      probe: () => {
        calls += 1
        return { ok: false, output: 'timed out' }
      },
    })
    const second = await grokAcpVersionProbe(TEST_INSTALLATION, {
      env: {},
      probe: () => {
        calls += 1
        return { ok: true, output: 'grok 0.2.118' }
      },
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
    await expect(
      grokAcpVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe }),
    ).resolves.toMatchObject({
      drivable: false,
      reason: 'unsupported',
    })
    await expect(
      grokAcpVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe }),
    ).resolves.toMatchObject({ reason: 'unsupported' })
    expect(calls).toBe(1)
  })
})

describe('codex app-server version probe memoization', () => {
  it('memoizes a DEFINITIVE verdict, so the probe is one fork per daemon life', async () => {
    resetCodexAppServerVersionProbe()
    let calls = 0
    const probe = () => {
      calls += 1
      return { output: 'codex-cli 0.147.0', ok: true }
    }
    await codexAppServerVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe })
    await codexAppServerVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe })
    await codexAppServerVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe })
    // The binary on PATH does not change under a running daemon, and the probe
    // costs a fork of a 250MB executable.
    expect(calls).toBe(1)
  })

  it('temporarily memoizes an unprobeable one so a spawn burst probes once', async () => {
    resetCodexAppServerVersionProbe()
    let calls = 0
    const probe = () => {
      calls += 1
      return { output: '', ok: false }
    }
    await codexAppServerVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe })
    await codexAppServerVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe })
    expect(calls).toBe(1)
  })
})

describe('opencode version probe memoization and delegation', () => {
  it('uses a resolved absolute executable when no bare OpenCode command exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolved-opencode-'))
    const executable = join(dir, 'resolved-opencode')
    const previousPath = process.env.PATH
    try {
      writeFileSync(executable, '#!/bin/sh\nprintf "1.18.16\n"\n')
      chmodSync(executable, 0o755)
      process.env.PATH = '/usr/bin:/bin'
      await expect(
        opencodeVersionProbe(
          { executable, version: '', generation: 0 },
          { env: { PATH: '/usr/bin:/bin' } },
        ),
      ).resolves.toEqual({
        drivable: true,
      })
    } finally {
      process.env.PATH = previousPath
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('MEMOIZES a DEFINITIVE answer, because the binary does not change under a daemon', async () => {
    resetOpencodeVersionProbe()
    let calls = 0
    const probe = (): { output: string; ok: boolean } => {
      calls += 1
      return { output: '1.18.16', ok: true }
    }
    await opencodeVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe })
    await opencodeVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe })
    await opencodeVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe })
    // One fork of a 180MB binary per daemon, not one per session.
    expect(calls).toBe(1)
  })

  it('temporarily memoizes a probe that could not answer', async () => {
    resetOpencodeVersionProbe()
    let calls = 0
    const probe = (): { output: string; ok: boolean } => {
      calls += 1
      return calls === 1 ? { output: 'ETIMEDOUT', ok: false } : { output: '1.18.16', ok: true }
    }
    expect((await opencodeVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe })).drivable).toBe(true)
    // A spawn burst reuses the inconclusive result instead of repeating the
    // expensive process. Expiry behavior is pinned by the generic cache suite above.
    expect((await opencodeVersionProbe(TEST_INSTALLATION, { env: {}, probe: probe })).drivable).toBe(true)
    expect(calls).toBe(1)
  })

  it('exposes only refusals through the old diagnostic surface', async () => {
    resetOpencodeVersionProbe()
    await expect(opencodeVersionDiagnostic(TEST_INSTALLATION, { env: {}, probe: () => ({ output: '1.18.16', ok: true }) })).resolves.toBeNull()
    resetOpencodeVersionProbe()
    await expect(opencodeVersionDiagnostic(TEST_INSTALLATION, { env: {}, probe: () => ({ output: 'ENOENT', ok: false }) })).resolves.toBeNull()
  })
})

/**
 * GUARD (POD-6546): each of the four probe memos keys its verdict on one
 * installation — executable path AND command-environment generation. The
 * regression test that fails on the base is engine-harness-binding.test.ts
 * ("a verdict for install A does not admit install B"); this pins the same
 * rule for every memo, plus the generation half of the key.
 */
describe('version verdicts are keyed per installation', () => {
  const probes = [
    {
      name: 'codex app-server',
      probe: codexAppServerVersionProbe,
      reset: resetCodexAppServerVersionProbe,
      good: 'codex-cli 0.162.0',
      bad: 'codex-cli 0.0.1',
    },
    {
      name: 'grok acp',
      probe: grokAcpVersionProbe,
      reset: resetGrokAcpVersionProbe,
      good: 'grok 1.0.46',
      bad: 'grok 0.0.1',
    },
    {
      name: 'opencode',
      probe: opencodeVersionProbe,
      reset: resetOpencodeVersionProbe,
      good: '1.18.16',
      bad: '0.0.1',
    },
    {
      name: 'opencode2',
      probe: opencode2VersionProbe,
      reset: resetOpencode2VersionProbe,
      good: '0.0.0-beta-18866',
      bad: '0.0.1',
    },
  ] as const

  it.each(probes)('$name: install A’s verdict never answers for install B or a new generation', async (entry) => {
    entry.reset()
    const answer = (output: string) => ({ env: {}, probe: () => ({ output, ok: true }) })
    const a = { executable: '/opt/a/bin/harness', version: '', generation: 0 }
    const b = { executable: '/opt/b/bin/harness', version: '', generation: 0 }

    const first = await entry.probe(a, answer(entry.good))
    expect(first.drivable).toBe(true)
    // Same installation: the memo answers, the probe's own answer is ignored.
    expect((await entry.probe(a, answer(entry.bad))).drivable).toBe(true)
    // Another path: its own verdict.
    expect((await entry.probe(b, answer(entry.bad))).drivable).toBe(false)
    // The same path in a later generation: probed afresh (upgraded in place).
    expect((await entry.probe({ ...a, generation: 1 }, answer(entry.bad))).drivable).toBe(false)
    entry.reset()
  })
})
