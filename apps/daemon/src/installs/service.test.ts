import { harnessHomeVariable } from '@podium/harness'
import type { InstallReleaseOptions, InstallReleaseResult } from '@podium/harness/inventory'
import { BUILTIN_HARNESS_KINDS, type Inventory } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testHarnessSnapshot } from '../test-support/harness-snapshot'
import { HarnessInstalls, PROGRESS_REPORT_INTERVAL_MS } from './service'

const updater = {
  checkNow: async () => [],
  goBack: async (kind: (typeof BUILTIN_HARNESS_KINDS)[number]) => ({
    outcome: 'not-managed' as const,
    kind,
  }),
  setPaused: (kind: (typeof BUILTIN_HARNESS_KINDS)[number]) => ({
    outcome: 'set' as const,
    kind,
    paused: true,
  }),
}
describe('local install requests', () => {
  it('reports vendor-owned updates as a successful no-op check', async () => {
    const service = new HarnessInstalls({
      runtime: { refresh: async () => testHarnessSnapshot({}) },
      updater: {
        ...updater,
        checkNow: async () => [
          { outcome: 'vendor-updated' as const, kind: 'cursor' as const, swept: [] },
        ],
      },
      harnessesDir: '/not-written',
      report: () => {},
    })
    expect(await service.run('check', 'cursor')).toEqual({ ok: true, outcome: 'vendor-updated' })
  })

  it.each(
    BUILTIN_HARNESS_KINDS.filter((kind) => !harnessHomeVariable(kind)),
  )('refuses %s alongside a personal install before touching the vendor or ledger', async (kind) => {
    const snapshot = testHarnessSnapshot({ [kind]: `/personal/${kind}` })
    const service = new HarnessInstalls({
      runtime: { refresh: async () => snapshot },
      updater,
      harnessesDir: '/not-written',
      report: () => {},
    })
    const result = await service.run('install', kind)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no folder variable')
  })
  it('makes the home ready and publishes inventory before acknowledging a successful install', async () => {
    let finishReport: () => void = () => {}
    const finalReport = new Promise<void>((resolve) => {
      finishReport = resolve
    })
    let reports = 0
    const events: string[] = []
    const service = new HarnessInstalls({
      runtime: { refresh: async () => testHarnessSnapshot({}) },
      updater,
      install: async (kind, _own, options) => {
        expect(options.requestedBy).toBe('person')
        events.push('installed')
        return {
          outcome: 'installed',
          kind,
          number: 1,
          version: '0.171.0',
          dir: '/state/release',
          executable: '/state/release/tool',
          previous: null,
          swept: [],
        }
      },
      podiumHomes: {
        reconcile: async () => {
          events.push('home-ready')
          return []
        },
        takeMySettings: async () => ({ error: 'no personal settings' }),
      },
      report: () => {
        reports++
        if (reports === 2) return finalReport
      },
      reportProgress: () => {},
    })
    let completed = false
    const pending = service.run('install', 'codex').then((result) => {
      completed = true
      return result
    })
    await vi.waitFor(() => expect(reports).toBe(2))
    expect(events).toEqual(['installed', 'home-ready'])
    expect(completed).toBe(false)
    finishReport()
    await expect(pending).resolves.toMatchObject({ ok: true, version: '0.171.0' })
  })
})

describe('install progress, cancel and retry (POD-7471)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const inventory = {
    ...testHarnessSnapshot({}).inventory,
    agents: [{ kind: 'codex', installed: false, login: { state: 'unknown' } }],
  } as Inventory
  const installingOf = (service: HarnessInstalls) =>
    service.inventory(inventory).agents[0]?.install?.managed?.installing

  const installed = (version = '0.171.0'): InstallReleaseResult => ({
    outcome: 'installed',
    kind: 'codex',
    number: 1,
    version,
    dir: '/state/release',
    executable: '/state/release/tool',
    previous: null,
    swept: [],
  })

  /** A service whose install is driven by the test through the options it was handed. */
  function controlled() {
    const calls: {
      options: InstallReleaseOptions
      finish: (result: InstallReleaseResult) => void
    }[] = []
    const progressReports: unknown[] = []
    const reconciled: string[] = []
    const service: HarnessInstalls = new HarnessInstalls({
      runtime: { refresh: async () => testHarnessSnapshot({}) },
      updater,
      harnessesDir: '/not-written',
      report: () => {},
      reportProgress: () => {
        progressReports.push(installingOf(service)?.progress)
      },
      podiumHomes: {
        reconcile: async (match) => {
          if (match('codex')) reconciled.push('codex')
          return []
        },
        takeMySettings: async () => ({ error: 'no personal settings' }),
      },
      install: (_kind, _own, options) =>
        new Promise((finish) => {
          calls.push({ options, finish })
        }),
    })
    return { service, calls, progressReports, reconciled }
  }

  it('shows the running install in the overlay, reports each phase at once and bytes at most twice a second', async () => {
    vi.useFakeTimers({ now: 10_000 })
    const { service, calls, progressReports } = controlled()
    const pending = service.run('install', 'codex')
    await vi.advanceTimersByTimeAsync(0)
    const call = calls[0]
    if (!call) throw new Error('the install did not start')
    expect(installingOf(service)).toEqual({ progress: { phase: 'download' } })
    const progress = call.options.onProgress
    if (!progress) throw new Error('no progress callback')

    progress({ phase: 'download' })
    for (let chunk = 1; chunk <= 10; chunk++)
      progress({ phase: 'download', receivedBytes: chunk * 1000, totalBytes: 10_000 })
    expect(progressReports).toEqual([{ phase: 'download' }])
    await vi.advanceTimersByTimeAsync(PROGRESS_REPORT_INTERVAL_MS - 1)
    expect(progressReports).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(progressReports).toEqual([
      { phase: 'download' },
      { phase: 'download', receivedBytes: 10_000, totalBytes: 10_000 },
    ])

    progress({ phase: 'verify' })
    progress({ phase: 'setup' })
    expect(progressReports.slice(2)).toEqual([{ phase: 'verify' }, { phase: 'setup' }])

    call.finish(installed())
    await expect(pending).resolves.toEqual({ ok: true, outcome: 'installed', version: '0.171.0' })
    await vi.advanceTimersByTimeAsync(5 * PROGRESS_REPORT_INTERVAL_MS)
    expect(progressReports).toHaveLength(4)
    expect(installingOf(service)).toBeUndefined()
  })

  it('cancels a running install: the download stops and the pending install answers cancelled', async () => {
    const { service, calls, reconciled } = controlled()
    const pending = service.run('install', 'codex')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const call = calls[0]
    if (!call?.options.signal) throw new Error('no cancel signal handed to the install')
    const { signal } = call.options
    signal.addEventListener('abort', () =>
      call.finish({ outcome: 'cancelled', kind: 'codex', swept: [] }),
    )
    call.options.onProgress?.({ phase: 'download', receivedBytes: 512, totalBytes: 4096 })
    expect(installingOf(service)?.progress).toEqual({
      phase: 'download',
      receivedBytes: 512,
      totalBytes: 4096,
    })

    await expect(service.run('cancel-install', 'codex')).resolves.toEqual({
      ok: true,
      outcome: 'cancelled',
    })
    expect(signal.aborted).toBe(true)
    await expect(pending).resolves.toEqual({
      ok: false,
      outcome: 'cancelled',
      error: 'The install was cancelled.',
    })
    expect(reconciled).toEqual([])
    expect(installingOf(service)).toBeUndefined()
  })

  it('answers a cancel with nothing running, and one that comes after the publish, without changing anything', async () => {
    const { service, calls } = controlled()
    await expect(service.run('cancel-install', 'codex')).resolves.toMatchObject({
      ok: false,
      outcome: 'not-installing',
    })

    const pending = service.run('install', 'codex')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    // The install is past its last cancel point: it publishes whatever the signal says.
    const late = service.run('cancel-install', 'codex')
    calls[0]?.finish(installed())
    await expect(late).resolves.toEqual({
      ok: false,
      outcome: 'installed',
      error: 'The install finished before it could be cancelled.',
    })
    await expect(pending).resolves.toMatchObject({ ok: true, outcome: 'installed' })
  })

  it('takes a retry after a failed install, and passes on why nothing can be installed', async () => {
    const { service, calls } = controlled()
    const first = service.run('install', 'codex')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    calls[0]?.finish({
      outcome: 'failed',
      kind: 'codex',
      version: '0.171.0',
      step: 'verify',
      error: 'codex 0.171.0 does not run (exit): exited 3',
      rejected: true,
      swept: [],
    })
    await expect(first).resolves.toMatchObject({ ok: false, outcome: 'failed' })

    const retry = service.run('install', 'codex')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    const error =
      'codex 0.171.0 does not run (exit): exited 3. Podium will not install 0.171.0 again, and the vendor has no newer release yet.'
    calls[1]?.finish({
      outcome: 'not-installable',
      kind: 'codex',
      version: '0.171.0',
      error,
      swept: [],
    })
    await expect(retry).resolves.toEqual({ ok: false, outcome: 'not-installable', error })

    const third = service.run('install', 'codex')
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    calls[2]?.finish(installed('0.172.0'))
    await expect(third).resolves.toEqual({ ok: true, outcome: 'installed', version: '0.172.0' })
  })
})
