import { harnessHomeVariable } from '@podium/harness'
import { BUILTIN_HARNESS_KINDS } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { testHarnessSnapshot } from '../test-support/harness-snapshot'
import { HarnessInstalls } from './service'

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
